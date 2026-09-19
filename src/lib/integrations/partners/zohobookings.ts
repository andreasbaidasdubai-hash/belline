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
import { httpTransport, requireEnv, type PartnerRequest, type PartnerTransport } from "./http";
import { PARTNERS } from "./registry";
import { sandboxPartner } from "./sandbox";

/**
 * Zoho Bookings, through its v1 JSON API.
 *
 * All four operations are documented and the API is on every plan — Zoho meters
 * it (250 calls a day on Free, 1,000 on Basic, 3,000 on Premium) rather than
 * selling it. For a small Gulf business that is the friendliest commercial
 * shape on the whole partner list.
 *
 *   GET  {api_domain}/bookings/v1/json/availableslots
 *   GET  {api_domain}/bookings/v1/json/services?workspace_id=
 *   POST {api_domain}/bookings/v1/json/appointment            form-data
 *   POST {api_domain}/bookings/v1/json/rescheduleappointment  form-data
 *   POST {api_domain}/bookings/v1/json/updateappointment      form-data, action=cancel
 *
 * ## The data centre, which is the only thing that really matters here
 *
 * Zoho is partitioned into separate data centres — `.com`, `.eu`, `.in`,
 * `.com.au`, `.jp`, `.ca`, `.uk`, `.sa` and, since January 2026, `.ae` — and a
 * grant made in one is meaningless in another. Three rules follow, and every
 * one of them is Zoho's own:
 *
 * 1. **The refresh goes to the venue's own accounts host.** Zoho puts
 *    `accounts-server` on the authorisation callback; that value is recorded on
 *    the venue and used verbatim. Belline never maps a country, a dialling code
 *    or a `location` code to a host.
 * 2. **The API host is read off the token, never built.** Zoho's instruction is
 *    "Never hardcode a single region's URL. Always use the api_domain from the
 *    access token response." Zoho's own examples show `api_domain` as
 *    `https://api.zoho.eu` in one place and `https://www.zohoapis.in` in
 *    another, so it cannot be string-built from the region even if we wanted
 *    to. It is taken from each refresh and used for that call only.
 * 3. **A venue that has recorded neither is not connected.** Not defaulted to
 *    `.com`, which is the failure the founder specifically asked about: it
 *    would look like a working integration and fail for every customer outside
 *    one data centre.
 *
 * There is deliberately **no region table in this file**, and there must never
 * be one. `check:zohobookings` fails if a `zohoapis` hostname is written down
 * anywhere in the source.
 *
 * ## The scope, which asks for more than Belline uses
 *
 * `zohobookings.data.CREATE` is the only scope Zoho publishes — there is no
 * read-only one, and even `GET /services` lists that write scope. So the
 * consent screen a customer sees grants full write access to their bookings.
 * That is not something to bury: it is recorded in `limits` and belongs in what
 * setup tells an owner before they click.
 */

const facts = PARTNERS.zohobookings;

/** The one scope Zoho publishes. There is no read-only alternative. */
export const ZOHO_BOOKINGS_SCOPE = "zohobookings.data.CREATE";

/** Every write is form-data; the path is the same for all of them. */
const API_PREFIX = "bookings/v1/json/";

// ---------------------------------------------------------------------------
// Zoho's shapes, only the fields Belline reads
// ---------------------------------------------------------------------------

/** Everything comes back wrapped: `{ response: { returnvalue, status } }`. */
interface ZohoEnvelope<T> {
  response?: { returnvalue?: T; status?: string };
}

interface SlotsReturn {
  /** Bare start times. No end time is offered, at all. */
  data?: string[];
  time_zone?: string;
}

interface ServiceEntity {
  id?: string;
  name?: string;
  /** "45 mins", "1 hour 30 mins", "5 mins". A string, always. */
  duration?: string;
}

interface AppointmentReturn {
  booking_id?: string;
  status?: string;
  summary_url?: string;
}

// ---------------------------------------------------------------------------
// Time, and the two formats Zoho answers in
// ---------------------------------------------------------------------------

/**
 * A slot time, in whichever of Zoho's two formats the venue chose.
 *
 * `GET /availableslots` returns bare times formatted by the venue's own
 * Settings → General → Time Format, so the very same endpoint answers "14:00"
 * for one salon and "02:00 PM" for the next. Both are read here; anything else
 * is NaN, and a NaN is dropped rather than guessed at.
 */
export function minutesOf(value: string): number {
  const text = value.trim();
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(text);
  if (!m) return NaN;
  let hours = Number(m[1]);
  const mins = Number(m[2]);
  const meridiem = m[3]?.toUpperCase();
  if (meridiem) {
    if (hours < 1 || hours > 12) return NaN;
    if (meridiem === "AM") hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
  } else if (hours > 23) {
    return NaN;
  }
  if (mins > 59) return NaN;
  return hours * 60 + mins;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * "2026-09-21" + 540 → "21-Sep-2026 09:00:00", the only format Zoho takes.
 *
 * A wall time at the venue, deliberately: Zoho resolves it against the
 * workspace's own zone, so nothing here converts to an instant. Cal.com is the
 * opposite and this must not be made to match it.
 */
export function zohoTime(date: string, min: number): string {
  const [y, m, d] = date.split("-");
  const month = MONTHS[Number(m) - 1];
  if (!month || !y || !d) return "";
  const hh = String(Math.floor(min / 60)).padStart(2, "0");
  const mm = String(min % 60).padStart(2, "0");
  return `${d}-${month}-${y} ${hh}:${mm}:00`;
}

/** "2026-09-21" → "21-Sep-2026", the shape `selected_date` takes. */
export function zohoDate(date: string): string {
  return zohoTime(date, 0).slice(0, 11);
}

/**
 * "45 mins" → 45, "1 hour 30 mins" → 90, "2 hours" → 120.
 *
 * Deliberately narrow. A duration Zoho words in some way this does not
 * recognise returns undefined, and the adapter then offers no times at all —
 * the Microsoft Bookings rule, for the same reason: `availableslots` gives
 * starts only, so an unreadable length means Belline would be inventing the
 * end of somebody's appointment.
 */
export function durationMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const text = value.toLowerCase();
  // A signed number is not a duration Zoho would send, and reading "-30 mins"
  // as thirty minutes would end an appointment before it began. Refuse the
  // whole string rather than the sign, because a value this odd means the
  // field is not what it was thought to be.
  if (/[-+]\s*\d/.test(text)) return undefined;
  let total = 0;
  let matched = false;
  for (const [re, factor] of [
    [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/g, 60],
    [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/g, 1],
  ] as const) {
    for (const m of text.matchAll(re)) {
      total += Number(m[1]) * factor;
      matched = true;
    }
  }
  if (!matched || !Number.isFinite(total) || total <= 0) return undefined;
  return total;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface ZohoBookingsContext {
  /** The workspace the venue's services live in. */
  workspaceId: string;
}

export function zohoBookingsApi(transport: PartnerTransport, context: ZohoBookingsContext): PartnerApi {
  /** The venue's own services, read fresh: the duration is theirs, never ours. */
  async function serviceOf(serviceId: string): Promise<ServiceEntity | undefined> {
    const answer = await transport.request<ZohoEnvelope<{ data?: ServiceEntity[] }>>({
      method: "GET",
      path: `${API_PREFIX}services`,
      query: { workspace_id: context.workspaceId, service_id: serviceId },
    });
    const all = answer.response?.returnvalue?.data ?? [];
    return all.find((s) => s.id === serviceId) ?? all[0];
  }

  return {
    async availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]> {
      // Zoho needs the service and one of staff/group/resource. Without both
      // there is no question to ask, and Belline does not answer it instead.
      const serviceId = query.serviceIds?.[0];
      const staffId = query.staffId;
      if (!serviceId || !staffId) return [];

      // Only starts come back, so the length is read off the venue's own
      // service record on every call. No duration, no times.
      const service = await serviceOf(serviceId);
      const durationMin = durationMinutes(service?.duration);
      if (durationMin === undefined) return [];

      const answer = await transport.request<ZohoEnvelope<SlotsReturn>>({
        method: "GET",
        path: `${API_PREFIX}availableslots`,
        query: { service_id: serviceId, staff_id: staffId, selected_date: zohoDate(query.date) },
      });

      return (answer.response?.returnvalue?.data ?? [])
        .map((time): PartnerSlot => {
          const startMin = minutesOf(time);
          return {
            date: query.date,
            startMin,
            endMin: startMin + durationMin,
            // The staff member was named in the question, so naming them in
            // the answer reports rather than promises.
            staffId,
          };
        })
        .filter((s) => Number.isFinite(s.startMin))
        .filter((s) => (query.fromMin === undefined || s.startMin >= query.fromMin) && (query.toMin === undefined || s.startMin <= query.toMin))
        .sort((a, b) => a.startMin - b.startMin);
    },

    async create(input: PartnerCreate): Promise<PartnerBookingRef> {
      const serviceId = input.serviceIds?.[0];
      if (!serviceId) throw new PartnerUnsupported("zohobookings", "Zoho Bookings needs the service before it can take a booking");
      if (!input.staffId) throw new PartnerUnsupported("zohobookings", "Zoho Bookings needs the staff member before it can take a booking");
      const made = await transport.request<ZohoEnvelope<AppointmentReturn>>({
        method: "POST",
        path: `${API_PREFIX}appointment`,
        // Form-data, not JSON, and the guest goes in as a JSON string inside a
        // form field. That is Zoho's documented shape, not a workaround.
        form: {
          service_id: serviceId,
          staff_id: input.staffId,
          from_time: zohoTime(input.date, input.startMin),
          customer_details: JSON.stringify({
            name: input.guestName,
            phone_number: input.guestPhone,
            email: input.guestEmail?.trim() || undefined,
          }),
          notes: input.notes,
        },
      });
      const id = made.response?.returnvalue?.booking_id;
      if (!id) throw new Error("Zoho Bookings did not return the appointment it made");
      // Zoho's booking_id is the human reference too ("#AN-00014"), so it is
      // both what the guest reads out and what every other call takes.
      return { id, ref: id };
    },

    async reschedule(ref, changes): Promise<PartnerBookingRef> {
      await transport.request<ZohoEnvelope<AppointmentReturn>>({
        method: "POST",
        path: `${API_PREFIX}rescheduleappointment`,
        form: {
          booking_id: ref.id,
          start_time: zohoTime(changes.date, changes.startMin),
          staff_id: changes.staffId,
        },
      });
      // The appointment keeps its booking_id through a move.
      return { id: ref.id, ref: ref.ref };
    },

    async cancel(ref): Promise<void> {
      // There is no cancel endpoint: cancelling is an action on the update
      // call, and "cancel" is the documented value.
      await transport.request<ZohoEnvelope<AppointmentReturn>>({
        method: "POST",
        path: `${API_PREFIX}updateappointment`,
        form: { booking_id: ref.id, action: "cancel" },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tokens, per venue, per data centre
// ---------------------------------------------------------------------------

export interface ZohoToken {
  accessToken: string;
  /** Where this token — and only this token — may be spent. */
  apiDomain: string;
  expiresAt: number;
}

const tokens = new Map<string, ZohoToken>();

/**
 * An access token for one venue, refreshed at that venue's own accounts host.
 *
 * The `accountsServer` argument is the value Zoho itself put on the
 * authorisation callback. It is not derived from a country, and there is no
 * fallback: a refresh sent to the wrong data centre does not fail helpfully, it
 * fails as an invalid token.
 *
 * The returned `api_domain` is the other half of the same rule. It is Zoho's
 * answer to "where may this token be spent", it is not consistently spelled
 * across Zoho's own documentation, and it is therefore never reconstructed.
 */
export async function zohoRefresh(
  accountsServer: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ZohoToken> {
  const cacheKey = `${accountsServer}|${refreshToken.slice(0, 12)}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;

  const base = accountsServer.endsWith("/") ? accountsServer : `${accountsServer}/`;
  const res = await fetchImpl(new URL("oauth/v2/token", base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new PartnerNotConnected(
      "zohobookings",
      `${accountsServer} would not refresh this venue's Zoho grant — the owner may have revoked it, or this data centre may not be enabled on Belline's OAuth client`,
    );
  }
  const data = (await res.json()) as { access_token?: string; api_domain?: string; expires_in?: number; error?: string };
  if (data.error || !data.access_token) {
    throw new PartnerNotConnected("zohobookings", `${accountsServer} returned no access token for this venue`);
  }
  // No api_domain means no idea where this token is valid, and guessing is the
  // one thing Zoho's documentation explicitly forbids.
  if (!data.api_domain) {
    throw new PartnerNotConnected("zohobookings", "Zoho returned a token with no api_domain, and Belline will not guess which data centre it belongs to");
  }
  const token: ZohoToken = {
    accessToken: data.access_token,
    apiDomain: data.api_domain,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  tokens.set(cacheKey, token);
  return token;
}

/** Forget every cached token: a withdrawn grant must not keep working. */
export function forgetZohoTokens(): void {
  tokens.clear();
}

/**
 * The transport, pointed at whatever data centre the token came back from.
 *
 * The base URL is resolved per request rather than once, because it is a
 * property of the token and not of the deployment. That is the whole
 * multi-data-centre design in one line, and it is why there is no host constant
 * in this file.
 */
export function zohoTransport(
  accountsServer: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  refresh: typeof zohoRefresh = zohoRefresh,
): PartnerTransport {
  return {
    async request<T>(req: PartnerRequest): Promise<T> {
      const token = await refresh(accountsServer, refreshToken, clientId, clientSecret);
      return httpTransport(facts, {
        baseUrl: token.apiDomain,
        auth: { Authorization: `Zoho-oauthtoken ${token.accessToken}` },
      }).request<T>(req);
    },
  };
}

export const zohobookingsConnector: PartnerConnector = {
  facts,

  linked(location: PartnerVenue): boolean {
    return Boolean(partnerLinkOf(location, "zohobookings")?.venueId);
  },

  usable(location: PartnerVenue, env = process.env): boolean {
    const mode = partnerMode(facts, env);
    if (mode === "off") return false;
    const link = partnerLinkOf(location, "zohobookings");
    if (!link?.venueId || link.expiredAt || link.misconfiguredAt) return false;
    if (mode === "sandbox") return true;
    // Live needs the owner's grant and the data centre it was made in. Without
    // the accounts host there is nowhere to refresh it, and defaulting to one
    // would be the exact bug this adapter exists to avoid: an integration that
    // works for whichever data centre we happened to test in.
    return Boolean(link.sealedToken) && Boolean(link.accountsServer?.trim());
  },

  apiFor(location: PartnerVenue, env = process.env): PartnerApi | null {
    if (!this.usable(location, env)) return null;
    const link = partnerLinkOf(location, "zohobookings")!;
    if (partnerMode(facts, env) === "sandbox") {
      return sandboxPartner(facts, { opens: 9 * 60, closes: 17 * 60, stepMin: 30, staff: [{ id: "zoho-staff-1", name: "Huda" }] });
    }
    // Belline's own OAuth client. One client id serves every data centre, and
    // one secret does too where the founder ticked "use the same OAuth
    // credentials for all data centers" in the API console.
    const clientId = requireEnv(facts, "CLIENT_ID", env);
    const clientSecret = requireEnv(facts, "CLIENT_SECRET", env);

    const granted = openCredentials(link.sealedToken!);
    const refreshToken = granted.refreshToken;
    if (!refreshToken) throw new PartnerNotConnected("zohobookings", "this venue's owner has not granted Belline access to their Zoho Bookings");
    const accountsServer = link.accountsServer?.trim();
    if (!accountsServer) {
      throw new PartnerNotConnected("zohobookings", "this venue has not recorded which Zoho data centre its account lives in");
    }
    return zohoBookingsApi(zohoTransport(accountsServer, refreshToken, clientId, clientSecret), { workspaceId: link.venueId! });
  },

  refFields(ref: PartnerBookingRef) {
    return { partnerBookingId: ref.id, partnerRef: ref.ref };
  },
};
