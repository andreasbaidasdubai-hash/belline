import { openCredentials } from "../../db/credentials";
import {
  PartnerNotConnected,
  PartnerUnsupported,
  partnerEnvKey,
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
import { baseUrlFor, httpTransport, requireEnv, requireKey, type PartnerTransport } from "./http";
import { PARTNERS } from "./registry";
import { sandboxPartner } from "./sandbox";

/**
 * Mindbody Public API v6, as its swagger document describes it.
 *
 * The one partner of the six with an open specification and a sandbox anybody
 * can have (site `-99`, wiped nightly). Everything below is written from the
 * documented endpoints:
 *
 *   POST /public/v6/usertoken/issue           a staff token, per site
 *   GET  /public/v6/appointment/bookableitems what can actually be booked
 *   POST /public/v6/appointment/addappointment
 *   POST /public/v6/appointment/updateappointment
 *
 * Two of Mindbody's own warnings are built into this file rather than left in
 * a document nobody reads.
 *
 * **`availabledates` is not availability.** It says when a staff member is
 * rostered, which is not the same as a bookable gap, and quoting it would have
 * Belline offering times the studio's own screen refuses. Only `bookableitems`
 * is used.
 *
 * **There is no appointment cancellation in v6.** Classes can be cancelled; a
 * booked appointment cannot. So `facts.api.cancel` is false, the agent is never
 * given a cancel tool for a Mindbody studio, and a guest who rings to cancel is
 * taken as a message. Being unable to do it is a limitation; saying it is done
 * would be a lie.
 *
 * Three headers authenticate every call: `Api-Key` (Belline's, from env, issued
 * when Mindbody approves the account), `SiteId` (the studio's), and
 * `Authorization` (a staff user token, issued per site and cached for the
 * length of a process). The studio's activation — an owner typing a code into
 * Manager Tools — is what makes the second two possible at all, and nothing
 * here can conjure it.
 */

const facts = PARTNERS.mindbody;

const PRODUCTION = "https://api.mindbodyonline.com/public/v6/";

/** Mindbody's sandbox site, documented and free. Nothing in it is a customer. */
export const MINDBODY_SANDBOX_SITE = "-99";

interface BookableItem {
  Id?: number;
  StartDateTime: string;
  EndDateTime: string;
  Staff?: { Id?: number; Name?: string };
}

interface MindbodyAppointment {
  Id: number;
  StartDateTime: string;
  EndDateTime: string;
}

const minutesOf = (time: string): number => {
  const m = /T(\d{2}):(\d{2})/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

const dateOf = (time: string): string => time.slice(0, 10);

const iso = (date: string, min: number) =>
  `${date}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00`;

export interface MindbodyContext {
  /** The studio's Mindbody site. */
  siteId: string;
  /** The Mindbody client record this booking belongs to. */
  clientId?: string;
}

export function mindbodyApi(transport: PartnerTransport, context: MindbodyContext): PartnerApi {
  /**
   * The studio's client record for this guest.
   *
   * UNVERIFIED: Mindbody documents `POST client/addclient` and a client search,
   * and also documents that required fields differ with and without a user
   * token and that duplicate first+last+email has been refused since 2020. The
   * exact search shape was not confirmed, so this is the part of the flow a
   * reviewer should distrust first, and it must be checked against the sandbox
   * before any studio is connected.
   */
  async function clientId(input: { guestName: string; guestPhone: string; guestEmail?: string }): Promise<string> {
    if (context.clientId) return context.clientId;
    const [first, ...rest] = input.guestName.trim().split(/\s+/);
    const found = await transport.request<{ Clients?: { Id: string }[] }>({
      method: "GET",
      path: "client/clients",
      query: { "request.searchText": input.guestPhone, "request.limit": 1 },
    });
    const existing = found.Clients?.[0]?.Id;
    if (existing) return existing;
    const made = await transport.request<{ Client?: { Id: string } }>({
      method: "POST",
      path: "client/addclient",
      body: { FirstName: first, LastName: rest.join(" ") || first, MobilePhone: input.guestPhone, Email: input.guestEmail },
    });
    if (!made.Client?.Id) throw new PartnerNotConnected("mindbody", "the studio would not create a client record for this guest");
    return made.Client.Id;
  }

  return {
    async availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]> {
      // A session type is the service. Mindbody cannot answer "what is free on
      // Tuesday" without one, and Belline does not answer it for them.
      if (!query.serviceIds?.length) return [];
      const answer = await transport.request<{ Availabilities?: BookableItem[] }>({
        method: "GET",
        path: "appointment/bookableitems",
        query: {
          "request.sessionTypeIds": query.serviceIds.join(","),
          "request.staffIds": query.staffId,
          "request.startDate": query.date,
          "request.endDate": query.date,
        },
      });
      return (answer.Availabilities ?? [])
        .map((item): PartnerSlot => ({
          date: dateOf(item.StartDateTime),
          startMin: minutesOf(item.StartDateTime),
          endMin: minutesOf(item.EndDateTime),
          staffId: item.Staff?.Id === undefined ? undefined : String(item.Staff.Id),
          staffName: item.Staff?.Name,
        }))
        .filter((s) => s.date === query.date && Number.isFinite(s.startMin));
    },

    async create(input: PartnerCreate): Promise<PartnerBookingRef> {
      if (!input.serviceIds?.length) throw new PartnerUnsupported("mindbody", "Mindbody needs the session type before it can take a booking");
      if (!input.staffId) throw new PartnerUnsupported("mindbody", "Mindbody books a named staff member; none was chosen");
      const client = await clientId(input);
      // Mindbody deduplicates `addappointment` itself, and the header that
      // turns that off (`X-RequestDeduplication-Skip`) is exactly what must
      // never be sent from here.
      const made = await transport.request<{ Appointment?: MindbodyAppointment }>({
        method: "POST",
        path: "appointment/addappointment",
        body: {
          ClientId: client,
          StaffId: Number(input.staffId),
          SessionTypeId: Number(input.serviceIds[0]),
          StartDateTime: iso(input.date, input.startMin),
          Notes: input.notes,
        },
      });
      if (!made.Appointment) throw new Error("Mindbody did not return the appointment it made");
      return { id: String(made.Appointment.Id) };
    },

    async reschedule(ref, changes): Promise<PartnerBookingRef> {
      const moved = await transport.request<{ Appointment?: MindbodyAppointment }>({
        method: "POST",
        path: "appointment/updateappointment",
        body: {
          AppointmentId: Number(ref.id),
          StartDateTime: iso(changes.date, changes.startMin),
          EndDateTime: iso(changes.date, changes.endMin),
          StaffId: changes.staffId ? Number(changes.staffId) : undefined,
        },
      });
      return { id: moved.Appointment ? String(moved.Appointment.Id) : ref.id, ref: ref.ref };
    },

    async cancel(): Promise<void> {
      // Public API v6 has no appointment cancellation. The studio's own team
      // cancels it, and Belline takes a message saying so.
      throw new PartnerUnsupported("mindbody", "Mindbody's public API v6 cannot cancel a booked appointment");
    },
  };
}

/**
 * A staff user token for one site, for as long as this process lives.
 *
 * Mindbody issues it from a username and password that belong to Belline's own
 * staff record on that studio's site, which the studio creates when it
 * activates us. It is per site, so the cache is keyed by site.
 */
const tokens = new Map<string, string>();

export async function mindbodyUserToken(transport: PartnerTransport, siteId: string, username: string, password: string): Promise<string> {
  const cached = tokens.get(siteId);
  if (cached) return cached;
  const issued = await transport.request<{ AccessToken?: string }>({
    method: "POST",
    path: "usertoken/issue",
    body: { Username: username, Password: password },
  });
  if (!issued.AccessToken) throw new PartnerNotConnected("mindbody", `Mindbody would not issue a staff token for site ${siteId}`);
  tokens.set(siteId, issued.AccessToken);
  return issued.AccessToken;
}

/** Forget every cached token: a studio whose activation was withdrawn must not keep working. */
export function forgetMindbodyTokens(): void {
  tokens.clear();
}

export const mindbodyConnector: PartnerConnector = {
  facts,

  linked(location: PartnerVenue): boolean {
    return Boolean(partnerLinkOf(location, "mindbody")?.venueId);
  },

  usable(location: PartnerVenue, env = process.env): boolean {
    const mode = partnerMode(facts, env);
    if (mode === "off") return false;
    const link = partnerLinkOf(location, "mindbody");
    if (!link?.venueId || link.expiredAt || link.misconfiguredAt) return false;
    // Live needs the studio's own activation. Mindbody's support documentation
    // is explicit that the owner's step cannot be automated, so a missing
    // activation is a person who has not clicked yet, not a bug.
    return mode === "sandbox" || Boolean(link.sealedToken);
  },

  apiFor(location: PartnerVenue, env = process.env): PartnerApi | null {
    if (!this.usable(location, env)) return null;
    const link = partnerLinkOf(location, "mindbody")!;
    if (partnerMode(facts, env) === "sandbox") {
      return sandboxPartner(facts, { opens: 8 * 60, closes: 19 * 60, stepMin: 60, staff: [{ id: "100000001", name: "Dana" }] });
    }
    const apiKey = requireKey(facts, env);
    const username = requireEnv(facts, "STAFF_USERNAME", env);
    // Read here and handed straight to Mindbody; never logged, never stored.
    const password = requireEnv(facts, "STAFF_PASSWORD", env);
    const siteId = link.venueId!;
    const activation = openCredentials(link.sealedToken!).activationCode;
    if (!activation) throw new PartnerNotConnected("mindbody", `site ${siteId} has not been activated by its owner`);

    const base = baseUrlFor(facts, PRODUCTION, env);
    const anonymous = httpTransport(facts, { baseUrl: base, auth: { "Api-Key": apiKey, SiteId: siteId } });
    const authorised: PartnerTransport = {
      async request(req) {
        const token = await mindbodyUserToken(anonymous, siteId, username, password);
        return httpTransport(facts, {
          baseUrl: base,
          auth: { "Api-Key": apiKey, SiteId: siteId, Authorization: token },
        }).request(req);
      },
    };
    return mindbodyApi(authorised, { siteId });
  },

  refFields(ref: PartnerBookingRef) {
    return { partnerBookingId: ref.id, partnerRef: ref.ref };
  },
};

/** The env var a deployment sets to point Mindbody at the free sandbox site. */
export const MINDBODY_SITE_ENV = partnerEnvKey("mindbody", "SITE_ID");
