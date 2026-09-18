import { openCredentials } from "../../db/credentials";
import {
  PartnerNotConnected,
  PartnerUnsupported,
  partnerLinkOf,
  partnerMode,
  type PartnerApi,
  type PartnerAvailabilityQuery,
  type PartnerBookingRef,
  type PartnerConnector,
  type PartnerCreate,
  type PartnerSlot,
  type PartnerVenue,
} from "./contract";
import { baseUrlFor, httpTransport, requireEnv, type PartnerTransport } from "./http";
import { PARTNERS } from "./registry";
import { sandboxPartner } from "./sandbox";

/**
 * Microsoft Bookings, through Microsoft Graph v1.0.
 *
 * The most capable partner adapter in this directory — availability, create,
 * move and cancel are all documented — and the one that had to be built as its
 * own destination rather than a tick-box on the Outlook connection. The reason
 * is in registry.ts and is worth repeating in one line here, because it is the
 * fact most likely to be "simplified away" later:
 *
 *   **getStaffAvailability has no delegated permission.** Microsoft's own
 *   reference says "Not supported" for delegated work-or-school accounts and
 *   for delegated personal accounts alike. Availability is application
 *   permissions or nothing.
 *
 * So this adapter authenticates with client credentials against the venue's own
 * tenant — `POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`
 * with `scope=https://graph.microsoft.com/.default` — and that token only
 * exists because an administrator in that tenant granted Belline admin consent.
 * There is no owner-clicks-a-button path here, and setup must say so.
 *
 * The endpoints, all v1.0, all under the tenant's own bookingBusiness:
 *
 *   GET   /solutions/bookingBusinesses/{id}                     businessHours, schedulingPolicy
 *   GET   /solutions/bookingBusinesses/{id}/services            duration, buffers, policy
 *   GET   /solutions/bookingBusinesses/{id}/staffMembers        who can be asked for
 *   POST  /solutions/bookingBusinesses/{id}/getStaffAvailability
 *   POST  /solutions/bookingBusinesses/{id}/appointments
 *   PATCH /solutions/bookingBusinesses/{id}/appointments/{id}
 *   POST  /solutions/bookingBusinesses/{id}/appointments/{id}/cancel
 *
 * ## The arithmetic, and why it is allowed here
 *
 * `getStaffAvailability` does not return bookable starts. It returns coarse
 * intervals — "Available 08:00 to 15:00", "Busy 15:00 to 16:00" — and leaves
 * the rest to the caller. Microsoft says so outright on its "Business rules
 * validation" page: an app creating appointments with application permissions
 * must itself honour business hours, the time slot interval, minimum and
 * maximum lead time, pre- and post-buffers, and `allowStaffSelection`, with
 * service-level policy overriding business-level.
 *
 * Belline's standing rule is that it never computes a partner's availability
 * (partner-provider.ts), and Mindbody's `availabledates` is the cautionary
 * tale. The difference that makes `slotsFrom` below acceptable rather than a
 * repeat of that mistake:
 *
 * - For Mindbody, a truer endpoint existed (`bookableitems`) and using the
 *   rostered-dates one would have been choosing the worse answer.
 * - Microsoft publishes **no** bookable-slots endpoint. The arithmetic is not
 *   Belline substituting its own judgement for the venue's; it is the only
 *   documented way to use the answer Microsoft gives, and every input to it —
 *   the increment, the lead times, the buffers, the duration, the business
 *   hours — is read from the venue's own calendar on every call. Nothing is
 *   Belline's default and nothing is cached.
 *
 * If Microsoft ever ships a slots endpoint, this function should be deleted in
 * favour of it. `check:msbookings` pins each rule so the arithmetic cannot
 * quietly drift into being generous.
 */

const facts = PARTNERS.msbookings;

const GRAPH = "https://graph.microsoft.com/v1.0/";
const LOGIN = "https://login.microsoftonline.com";

/**
 * The application permissions this needs, and what each is for. An
 * administrator is entitled to see this list before consenting, so it lives in
 * code rather than in a slide.
 */
export const MSBOOKINGS_APP_PERMISSIONS = [
  // getStaffAvailability, the business, its services and its staff.
  "Bookings.Read.All",
  // Create, move and cancel an appointment. Deliberately not Bookings.Manage.All,
  // which would also let Belline rewrite the venue's services and policy.
  "BookingsAppointment.ReadWrite.All",
] as const;

/** Where a tenant administrator grants the consent above. Never opened by Belline. */
export function msbookingsAdminConsentUrl(tenantId: string, clientId: string, redirectUri: string): string {
  const url = new URL(`${LOGIN}/${encodeURIComponent(tenantId)}/adminconsent`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Graph's shapes, only the fields Belline reads
// ---------------------------------------------------------------------------

interface DateTimeTimeZone {
  dateTime: string;
  timeZone?: string;
}

interface SchedulingPolicy {
  /** ISO 8601 duration: the grid bookable starts sit on. */
  timeSlotInterval?: string;
  minimumLeadTime?: string;
  maximumLeadTime?: string;
  /** False means Bookings picks the person, and Belline must not promise one. */
  allowStaffSelection?: boolean;
}

interface BookingBusiness {
  id?: string;
  schedulingPolicy?: SchedulingPolicy;
}

interface BookingService {
  id: string;
  displayName?: string;
  defaultDuration?: string;
  preBuffer?: string;
  postBuffer?: string;
  /** A service may override the business's policy, and where it does it wins. */
  schedulingPolicy?: SchedulingPolicy;
}

interface BookingStaffMember {
  id: string;
  displayName?: string;
}

interface AvailabilityItem {
  status?: string;
  startDateTime?: DateTimeTimeZone;
  endDateTime?: DateTimeTimeZone;
}

interface StaffAvailability {
  staffId?: string;
  availabilityItems?: AvailabilityItem[];
}

interface BookingAppointment {
  id: string;
  start?: DateTimeTimeZone;
  end?: DateTimeTimeZone;
}

// ---------------------------------------------------------------------------
// ISO 8601 durations and Graph's local date-times
// ---------------------------------------------------------------------------

/**
 * "PT1H30M" → 90. Bookings expresses every duration and buffer this way.
 *
 * Deliberately narrow: hours and minutes only, and anything else returns
 * undefined rather than a number that would quietly be wrong. A service whose
 * duration cannot be read is a service Belline does not quote.
 */
export function isoMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+(?:\.\d+)?)M)?(?:[\d.]+S)?$/.exec(value.trim());
  if (!m) return undefined;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const total = days * 24 * 60 + hours * 60 + mins;
  return Number.isFinite(total) ? total : undefined;
}

/** Graph's local "2026-09-21T09:00:00.0000000" → the date part. */
const dateOf = (value: string): string => value.slice(0, 10);

/** …and the minute of that local day. Graph's own time zone is echoed back unchanged. */
export function minutesOf(value: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

const stamp = (date: string, min: number) =>
  `${date}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00`;

/** The service's own policy where it set one, otherwise the business's. */
function policyFor(business: BookingBusiness, service: BookingService | undefined): SchedulingPolicy {
  return { ...(business.schedulingPolicy ?? {}), ...(service?.schedulingPolicy ?? {}) };
}

export interface SlotRules {
  /** Minutes the appointment itself takes. */
  durationMin: number;
  /** Held before and after it on the staff member's calendar. */
  preBufferMin: number;
  postBufferMin: number;
  /** The grid starts sit on. */
  incrementMin: number;
  /** Nothing sooner than this, nothing later than that, from `now`. */
  minimumLeadMin?: number;
  maximumLeadMin?: number;
}

/**
 * The bookable starts inside one staff member's Available intervals.
 *
 * Every rule here is Microsoft's, applied to the venue's own numbers:
 *
 * - a start sits on the venue's `timeSlotInterval` grid, counted from the
 *   start of the Available interval;
 * - the whole of pre-buffer + duration + post-buffer must fit inside a single
 *   Available interval, because that is what Bookings will hold on the staff
 *   member's calendar;
 * - `minimumLeadTime` and `maximumLeadTime` are measured from now.
 *
 * It offers nothing when the duration is unknown, and it never widens an
 * interval. A `Busy` item is simply not an `Available` one — Belline does not
 * subtract busy from a day it invented, which is the step that would turn this
 * back into guessing.
 */
export function slotsFrom(
  items: readonly AvailabilityItem[],
  rules: SlotRules,
  date: string,
  now: Date,
): { startMin: number; endMin: number }[] {
  if (!(rules.durationMin > 0) || !(rules.incrementMin > 0)) return [];
  const span = rules.preBufferMin + rules.durationMin + rules.postBufferMin;
  const out: { startMin: number; endMin: number }[] = [];
  for (const item of items) {
    // Only "Available". Anything else — Busy, Tentative, Out of office, or a
    // status Microsoft adds later — is not an invitation.
    if ((item.status ?? "").toLowerCase() !== "available") continue;
    const from = item.startDateTime?.dateTime;
    const to = item.endDateTime?.dateTime;
    if (!from || !to) continue;
    // An interval may run across days; only this day's part of it is offered.
    const opens = dateOf(from) === date ? minutesOf(from) : dateOf(from) < date ? 0 : NaN;
    const closes = dateOf(to) === date ? minutesOf(to) : dateOf(to) > date ? 24 * 60 : NaN;
    if (!Number.isFinite(opens) || !Number.isFinite(closes)) continue;
    for (let start = opens; start + span <= closes; start += rules.incrementMin) {
      // The guest's appointment begins after the pre-buffer, not at the top of
      // the held block: that is what the venue's screen will show.
      const begins = start + rules.preBufferMin;
      const ahead = (Date.parse(`${stamp(date, begins)}Z`) - now.getTime()) / 60000;
      if (rules.minimumLeadMin !== undefined && ahead < rules.minimumLeadMin) continue;
      if (rules.maximumLeadMin !== undefined && ahead > rules.maximumLeadMin) continue;
      out.push({ startMin: begins, endMin: begins + rules.durationMin });
    }
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface MsBookingsContext {
  /** The bookingBusiness id: an SMTP-style address such as contoso@contoso.onmicrosoft.com. */
  businessId: string;
  /** Overridable so a check can pin the lead-time arithmetic to a fixed clock. */
  now?: () => Date;
}

export function msbookingsApi(transport: PartnerTransport, context: MsBookingsContext): PartnerApi {
  const business = encodeURIComponent(context.businessId);
  const at = context.now ?? (() => new Date());
  const path = (rest = "") => `solutions/bookingBusinesses/${business}${rest}`;

  /** The venue's own service, staff and policy, read fresh on every question. */
  async function settings(serviceId: string | undefined) {
    const [biz, services, staff] = await Promise.all([
      transport.request<BookingBusiness>({ method: "GET", path: path() }),
      transport.request<{ value?: BookingService[] }>({ method: "GET", path: path("/services") }),
      transport.request<{ value?: BookingStaffMember[] }>({ method: "GET", path: path("/staffMembers") }),
    ]);
    const service = (services.value ?? []).find((s) => s.id === serviceId);
    return { biz, service, staff: staff.value ?? [] };
  }

  return {
    async availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]> {
      // Bookings computes against a service: its duration, its buffers, its
      // policy. Without one there is no honest answer, so none is given.
      const serviceId = query.serviceIds?.[0];
      if (!serviceId) return [];
      const { biz, service, staff } = await settings(serviceId);
      // A service the venue does not have is not a service Belline quotes.
      if (!service) return [];
      const policy = policyFor(biz, service);
      const durationMin = isoMinutes(service.defaultDuration);
      const incrementMin = isoMinutes(policy.timeSlotInterval);
      // No duration, no grid: Belline will not pick either for the venue.
      if (durationMin === undefined || incrementMin === undefined) return [];

      const wanted = query.staffId ? staff.filter((s) => s.id === query.staffId) : staff;
      // A person the venue does not have is never offered, and asking for one
      // where the venue turned staff selection off is refused rather than
      // silently answered with somebody else's diary.
      if (query.staffId && (wanted.length === 0 || policy.allowStaffSelection === false)) return [];
      if (wanted.length === 0) return [];

      const answer = await transport.request<{ staffAvailabilityItem?: StaffAvailability[] }>({
        method: "POST",
        path: path("/getStaffAvailability"),
        body: {
          staffIds: wanted.map((s) => s.id),
          startDateTime: { dateTime: stamp(query.date, 0), timeZone: "UTC" },
          endDateTime: { dateTime: stamp(query.date, 24 * 60 - 1), timeZone: "UTC" },
        },
      });

      const rules: SlotRules = {
        durationMin,
        preBufferMin: isoMinutes(service.preBuffer) ?? 0,
        postBufferMin: isoMinutes(service.postBuffer) ?? 0,
        incrementMin,
        minimumLeadMin: isoMinutes(policy.minimumLeadTime),
        maximumLeadMin: isoMinutes(policy.maximumLeadTime),
      };

      const out: PartnerSlot[] = [];
      for (const person of answer.staffAvailabilityItem ?? []) {
        const member = wanted.find((s) => s.id === person.staffId);
        if (!member) continue;
        for (const slot of slotsFrom(person.availabilityItems ?? [], rules, query.date, at())) {
          out.push({
            date: query.date,
            startMin: slot.startMin,
            endMin: slot.endMin,
            // Where the venue lets Bookings choose the host, Belline does not
            // hand the caller a name it may not keep.
            staffId: policy.allowStaffSelection === false ? undefined : member.id,
            staffName: policy.allowStaffSelection === false ? undefined : member.displayName,
          });
        }
      }
      return out
        .filter((s, i, all) => all.findIndex((o) => o.startMin === s.startMin && o.staffId === s.staffId) === i)
        .sort((a, b) => a.startMin - b.startMin);
    },

    async create(input: PartnerCreate): Promise<PartnerBookingRef> {
      const serviceId = input.serviceIds?.[0];
      if (!serviceId) throw new PartnerUnsupported("msbookings", "Microsoft Bookings needs the service before it can take a booking");
      const { service } = await settings(serviceId);
      if (!service) throw new PartnerUnsupported("msbookings", "that service is not one this Bookings calendar offers");
      const made = await transport.request<BookingAppointment>({
        method: "POST",
        path: path("/appointments"),
        body: {
          "@odata.type": "#microsoft.graph.bookingAppointment",
          serviceId,
          // The guest, in the shape Graph insists on: the @odata.type is not
          // decoration — the request fails without it.
          customers: [
            {
              "@odata.type": "#microsoft.graph.bookingCustomerInformation",
              name: input.guestName,
              emailAddress: input.guestEmail,
              phone: input.guestPhone,
              notes: input.notes,
            },
          ],
          customerTimeZone: "UTC",
          start: { "@odata.type": "#microsoft.graph.dateTimeTimeZone", dateTime: stamp(input.date, input.startMin), timeZone: "UTC" },
          end: { "@odata.type": "#microsoft.graph.dateTimeTimeZone", dateTime: stamp(input.date, input.endMin), timeZone: "UTC" },
          staffMemberIds: input.staffId ? [input.staffId] : undefined,
        },
      });
      if (!made?.id) throw new Error("Microsoft Bookings did not return the appointment it made");
      return { id: made.id };
    },

    async reschedule(ref, changes): Promise<PartnerBookingRef> {
      await transport.request<void>({
        method: "PATCH",
        path: path(`/appointments/${encodeURIComponent(ref.id)}`),
        body: {
          "@odata.type": "#microsoft.graph.bookingAppointment",
          start: { "@odata.type": "#microsoft.graph.dateTimeTimeZone", dateTime: stamp(changes.date, changes.startMin), timeZone: "UTC" },
          end: { "@odata.type": "#microsoft.graph.dateTimeTimeZone", dateTime: stamp(changes.date, changes.endMin), timeZone: "UTC" },
          staffMemberIds: changes.staffId ? [changes.staffId] : undefined,
        },
      });
      // PATCH answers 204 with no body: the appointment keeps its id.
      return { id: ref.id, ref: ref.ref };
    },

    async cancel(ref, reason): Promise<void> {
      await transport.request<void>({
        method: "POST",
        path: path(`/appointments/${encodeURIComponent(ref.id)}/cancel`),
        // Microsoft mails this to the customer and the staff member, so it is
        // written for a guest to read rather than for a log.
        body: { cancellationMessage: reason?.trim() || "Cancelled at the customer's request." },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Client credentials, per tenant
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number;
}

/** One token per tenant, for as long as this process lives. */
const tokens = new Map<string, TokenCache>();

/**
 * A Graph token for one tenant, by client credentials.
 *
 * No user, no refresh token, no consent screen: the administrator's grant
 * already happened, and this exchanges Belline's own client secret for a token
 * that is good for that tenant alone. A tenant whose admin withdrew consent
 * simply stops issuing, which the connector turns back into requests.
 */
export async function msbookingsToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cached = tokens.get(tenantId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetchImpl(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    // The tenant's administrator has not consented, or has withdrawn it. Either
    // way it is a person's decision, not a retryable failure.
    throw new PartnerNotConnected("msbookings", `tenant ${tenantId} would not issue a Graph token`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new PartnerNotConnected("msbookings", `tenant ${tenantId} returned no access token`);
  tokens.set(tenantId, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

/** Forget every cached token: a tenant that withdrew consent must not keep working. */
export function forgetMsBookingsTokens(): void {
  tokens.clear();
}

export const msbookingsConnector: PartnerConnector = {
  facts,

  linked(location: PartnerVenue): boolean {
    return Boolean(partnerLinkOf(location, "msbookings")?.venueId);
  },

  usable(location: PartnerVenue, env = process.env): boolean {
    const mode = partnerMode(facts, env);
    if (mode === "off") return false;
    const link = partnerLinkOf(location, "msbookings");
    if (!link?.venueId || link.expiredAt || link.misconfiguredAt) return false;
    // Live needs the tenant's admin consent, sealed on the venue when it was
    // granted. Nothing here can conjure an administrator's decision.
    return mode === "sandbox" || Boolean(link.sealedToken);
  },

  apiFor(location: PartnerVenue, env = process.env): PartnerApi | null {
    if (!this.usable(location, env)) return null;
    const link = partnerLinkOf(location, "msbookings")!;
    if (partnerMode(facts, env) === "sandbox") {
      return sandboxPartner(facts, { opens: 9 * 60, closes: 17 * 60, stepMin: 30, staff: [{ id: "staff-msb-1", name: "Dana" }] });
    }
    const clientId = requireEnv(facts, "CLIENT_ID", env);
    // Read here and handed straight to Microsoft; never logged, never stored.
    const clientSecret = requireEnv(facts, "CLIENT_SECRET", env);
    const granted = openCredentials(link.sealedToken!);
    const tenantId = granted.tenantId;
    if (!tenantId) throw new PartnerNotConnected("msbookings", "no tenant has granted Belline admin consent for this venue");

    const base = baseUrlFor(facts, GRAPH, env);
    const transport: PartnerTransport = {
      async request(req) {
        const token = await msbookingsToken(tenantId, clientId, clientSecret);
        return httpTransport(facts, { baseUrl: base, auth: { Authorization: `Bearer ${token}` } }).request(req);
      },
    };
    return msbookingsApi(transport, { businessId: link.venueId! });
  },

  refFields(ref: PartnerBookingRef) {
    return { partnerBookingId: ref.id, partnerRef: ref.ref };
  },
};
