import type { Booking, Location } from "../../types";
import { flag } from "../../flags";

/**
 * What Belline needs from a partner booking system, and what it is honest
 * about not having.
 *
 * Google Calendar and Outlook are calendars: Belline's own rules decide what is
 * offered and the calendar only takes times away (integrations/calendar-connector.ts).
 * A partner booking system is the opposite — Fresha, Zenoti, Mindbody and
 * Treatwell hold the salon's own services, staff, rotas and rules, and the only
 * honest availability is the one *they* compute. So this contract asks the
 * partner for bookable times rather than asking it what is busy.
 *
 * Three things every implementation here must obey.
 *
 * **Credentials or nothing.** Every partner API on our list is issued under a
 * signed agreement; none of them can be reached with a key a developer signs up
 * for on a Tuesday. An adapter with no credentials does not guess, does not
 * fall back to Belline's own diary, and does not pretend: it answers
 * `not_connected`, the venue stays on requests, and the website keeps saying
 * "on our roadmap". See registry.ts for what each partner actually gates.
 *
 * **Sandbox is not live.** `PARTNER_<ID>_ENV=sandbox` (the default whenever
 * credentials exist at all) drives the same code against the sandbox host or
 * the in-memory fake the checks use. It is a real connection for our purposes
 * and a fake one for a customer's, so it may never promote a logo on the
 * website. Only `live` may, and `live` needs every credential in
 * `facts.liveNeeds` — which is exactly the set a partner agreement issues.
 *
 * **The venue's own ids are the venue's.** A partner key authenticates
 * Belline; it does not name the salon. Mindbody wants a site id the studio
 * activates for us, Zenoti a centre id, SevenRooms a venue id. Those live on
 * the location, not in env, and an adapter without them is not connected to
 * *that* venue however good our key is.
 */

export type PartnerId =
  | "fresha"
  | "zenoti"
  | "mindbody"
  | "treatwell"
  | "opentable"
  | "sevenrooms"
  | "msbookings"
  | "calcom"
  | "eatapp"
  | "booksy"
  | "vagaro";

/** How the partner's own product thinks about a booking. */
export type PartnerModel =
  /** A service of a known length, with a named person: a salon, a clinic. */
  | "appointments"
  /** A party of a given size, for a sitting, on a table: a restaurant. */
  | "reservations";

/** What somebody has to do before this partner can be used in production. */
export interface PartnerGate {
  /** One sentence a founder can act on. */
  what: string;
  /** Where the application actually starts, when there is a public URL. */
  apply?: string;
  /** Documentation, when any of it is public. */
  docs?: string;
}

/** What the partner's documented API can do, from its own docs and nowhere else. */
export interface PartnerApiFacts {
  /** Is there a public, documented REST API at all? */
  documented: boolean;
  /** Can Belline read bookable times the partner computed? */
  availability: boolean;
  /** Can Belline write a booking the partner treats as confirmed? */
  create: boolean;
  reschedule: boolean;
  cancel: boolean;
  /** Can a guest ask for a particular person? */
  staffSelection: boolean;
  /** Can Belline read the venue's services and staff, rather than being told them? */
  catalogue: boolean;
}

export interface PartnerFacts {
  id: PartnerId;
  /** As the company writes it. */
  name: string;
  model: PartnerModel;
  api: PartnerApiFacts;
  /** How the API authenticates us, in one line. */
  auth: string;
  /** Is there a sandbox, and can we get into it ourselves? */
  sandbox: "self-serve" | "on-request" | "none";
  gate: PartnerGate;
  /**
   * Env vars a *live* connection needs, over and above the flag's own
   * `PARTNER_<ID>_API_KEY`. These are what the partner agreement issues.
   */
  liveNeeds: readonly string[];
  /**
   * What a venue must have recorded on it before this adapter can book for it:
   * the studio's site id, the centre id, the venue id.
   */
  venueNeeds: readonly string[];
  /**
   * The honest limits, in the founder's words rather than an error code: what
   * Belline could not do through this API even with the agreement signed.
   */
  limits: readonly string[];
}

/**
 * Off, sandbox, or live.
 *
 * `off` is the only state the repository can be in today for every partner,
 * because no partner has issued us anything. The other two exist so that the
 * day a key arrives is a deployment and not a project.
 */
export type PartnerMode = "off" | "sandbox" | "live";

type Env = Record<string, string | undefined>;

export const partnerFlag = (id: PartnerId) => `booking.partner.${id}` as const;

/** `PARTNER_FRESHA_API_KEY`, `PARTNER_FRESHA_ENV`, … */
export function partnerEnvKey(id: PartnerId, suffix: string): string {
  return `PARTNER_${id.toUpperCase()}_${suffix}`;
}

/**
 * Which mode this partner is in on this deployment.
 *
 * The flag decides whether it is on at all — and the flag already requires
 * `PARTNER_<ID>_API_KEY` and an explicit `FLAG_BOOKING_PARTNER_<ID>=on`, so a
 * key lying in env cannot switch anything on by itself (flags.ts). Live needs
 * the partner's production credentials as well *and* someone saying `live` out
 * loud, because a sandbox key and a production key look identical from here.
 */
export function partnerMode(facts: PartnerFacts, env: Env = process.env): PartnerMode {
  if (!flag(partnerFlag(facts.id), env)) return "off";
  const asked = (env[partnerEnvKey(facts.id, "ENV")] ?? "").trim().toLowerCase();
  if (asked !== "live" && asked !== "production") return "sandbox";
  const missing = facts.liveNeeds.filter((key) => !(env[key] ?? "").trim());
  return missing.length ? "sandbox" : "live";
}

/** Env vars still missing before this partner could be live. Names only, never values. */
export function partnerLiveMissing(facts: PartnerFacts, env: Env = process.env): string[] {
  const keys = [partnerEnvKey(facts.id, "API_KEY"), ...facts.liveNeeds];
  return keys.filter((key) => !(env[key] ?? "").trim());
}

// ---------------------------------------------------------------------------
// The venue's side
// ---------------------------------------------------------------------------

/** What this venue recorded about its partner system. */
export interface PartnerVenueLink {
  /** The partner's own id for this venue: a site id, a centre id, a venue id. */
  venueId?: string;
  /**
   * The IANA zone this venue's partner calendar answers in, where the partner
   * needs an exact instant rather than a wall time.
   *
   * Most of these take naive local times and resolve them against the venue's
   * own record (Zenoti's centre, Bookings' calendar), so they need nothing
   * here. Cal.com is the exception: `POST /v2/bookings` takes `start` in UTC,
   * so "Tuesday at ten" has to become an instant, and Belline will not decide
   * which instant a venue meant. Missing, and the venue is not connected.
   */
  timeZone?: string;
  /**
   * Where this venue's partner lives, when the venue hosts it itself.
   *
   * Only Cal.com is open source, so only Cal.com has this: a self-hosted
   * instance is on the venue's own domain and may be on an older release than
   * the API versions the adapter pins. Everyone else's host is a constant and
   * this stays empty.
   */
  baseUrl?: string;
  /**
   * Mindbody's per-studio activation, Zenoti's per-centre grant: the partner
   * key gets us to the door, this is the studio letting us in. Sealed like any
   * other credential; never read here, only tested for presence.
   */
  sealedToken?: string;
  /** The partner stopped accepting it. Back to requests until a person fixes it. */
  expiredAt?: string;
  /** The partner refuses Belline's own application (approval withdrawn, key revoked). */
  misconfiguredAt?: string;
}

/**
 * As much of a venue as a partner adapter is allowed to see: where its
 * bookings go, and its own side of the partner system. Deliberately not the
 * whole `Location` — an adapter has no business reading the rota to decide
 * whether it is connected, and `destination.ts` must be able to ask without
 * loading anything heavier.
 */
export type PartnerVenue = Pick<Location, "onboarding" | "partners">;

export function partnerLinkOf(location: Pick<Location, "partners">, id: PartnerId): PartnerVenueLink | undefined {
  return location.partners?.[id];
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export interface PartnerSlot {
  /** Local date at the venue, "YYYY-MM-DD". */
  date: string;
  /** Minutes from midnight, local at the venue. */
  startMin: number;
  endMin: number;
  /** The partner's id for the person, where the partner names one. */
  staffId?: string;
  staffName?: string;
  /** Restaurant systems: the sitting or the shift this belongs to. */
  section?: string;
  /** Whatever the partner needs handed back when this slot is booked. */
  token?: string;
}

export interface PartnerAvailabilityQuery {
  date: string;
  /** Appointments: what the guest asked for, in the partner's own service ids. */
  serviceIds?: string[];
  staffId?: string;
  /** Reservations: how many people. */
  partySize?: number;
  /** Earliest and latest minute from midnight the guest would accept. */
  fromMin?: number;
  toMin?: number;
  /**
   * Who is asking, where the conversation knows.
   *
   * A calendar does not care, and neither does Belline's own diary: a free
   * hour is free for anybody. Zenoti does care — availability is computed
   * against a booking cart, and a cart belongs to a guest record — so without
   * this it can only answer "no times", which is the honest answer rather
   * than a guess at the salon's diary.
   */
  guest?: { name?: string; phone?: string };
}

export interface PartnerCreate {
  date: string;
  startMin: number;
  endMin: number;
  guestName: string;
  guestPhone: string;
  guestEmail?: string;
  notes?: string;
  serviceIds?: string[];
  staffId?: string;
  partySize?: number;
  /** The slot the partner offered, handed straight back where it asked for one. */
  token?: string;
  /** The same booking twice is one booking: passed through where the partner supports it. */
  idempotencyKey: string;
}

/** What the partner says a booking is, once it has one. */
export interface PartnerBookingRef {
  /** The partner's own id. Stored on the Belline booking. */
  id: string;
  /** What the guest would read out to the salon, where the partner has one. */
  ref?: string;
  /** The partner already had this booking; nothing new was created. */
  duplicate?: boolean;
}

/**
 * One partner system, as Belline talks to it.
 *
 * Every method may throw `PartnerNotConnected` (no credentials, no venue id,
 * the partner withdrew us) or `PartnerUnsupported` (the API has no such
 * operation — OpenTable cannot be asked to move a reservation, so the agent is
 * told to take a message rather than shown a button that fails).
 */
export interface PartnerApi {
  /** Bookable times the partner computed. Never Belline's own guess. */
  availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]>;
  create(input: PartnerCreate): Promise<PartnerBookingRef>;
  reschedule(ref: PartnerBookingRef, changes: { date: string; startMin: number; endMin: number; staffId?: string }): Promise<PartnerBookingRef>;
  cancel(ref: PartnerBookingRef, reason?: string): Promise<void>;
}

export class PartnerNotConnected extends Error {
  readonly partner: PartnerId;
  constructor(partner: PartnerId, detail: string) {
    super(detail);
    this.name = "PartnerNotConnected";
    this.partner = partner;
  }
}

export class PartnerUnsupported extends Error {
  readonly partner: PartnerId;
  constructor(partner: PartnerId, what: string) {
    super(what);
    this.name = "PartnerUnsupported";
    this.partner = partner;
  }
}

/**
 * One partner, end to end: the facts, and how to get an API for a venue.
 *
 * `apiFor` returns null when this deployment and this venue cannot reach the
 * partner — which is every deployment today. The provider turns that into
 * "not connected" without a request leaving the process.
 */
export interface PartnerConnector {
  readonly facts: PartnerFacts;
  /** Is a partner system of this kind recorded on the venue at all? */
  linked(location: PartnerVenue): boolean;
  /** Flag on, credentials present, venue ids present, partner not refusing us. */
  usable(location: PartnerVenue, env?: Env): boolean;
  apiFor(location: PartnerVenue, env?: Env): PartnerApi | null;
  /** The fields a booking carries once this partner holds it. */
  refFields(ref: PartnerBookingRef): Partial<Pick<Booking, "partnerBookingId" | "partnerRef">>;
}
