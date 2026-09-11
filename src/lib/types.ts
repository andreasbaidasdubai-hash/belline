import type { BrainVersion } from "./brain";
import type { GoogleLink } from "./integrations/google";
import type { BillingCycle, PlanId } from "./billing/plans";

// Domain model.
//
// Two deliberate choices shape everything below:
//
// 1. Times are stored as `minutes from local midnight` plus a `YYYY-MM-DD`
//    date string, never as UTC instants. A 19:30 dinner booking is 19:30 in
//    the venue's own wall clock regardless of DST, server region, or where
//    the caller is. This is how real reservation systems model it and it
//    removes an entire category of off-by-an-hour bugs.
//
// 2. Everything a caller can change lives in the same shape whether the
//    tenant is a restaurant or a salon. The verticals differ only in how
//    availability is *computed* (tables + pacing vs. staff + resources), so
//    only the config and the search function are vertical-specific.

/**
 * `salon` and `clinic` share one engine: both are a diary of qualified people,
 * timed services, shared rooms and cleanup buffers. Only the vocabulary and
 * the house rules differ, so they differ in configuration rather than code.
 */
export type Vertical = "restaurant" | "salon" | "clinic";

/** Minutes from local midnight, e.g. 19 * 60 + 30 === 1170 for 19:30. */
export type Minutes = number;

/** `YYYY-MM-DD` in the location's own timezone. */
export type DateStr = string;

export interface TimeRange {
  start: Minutes;
  end: Minutes;
}

/** Index 0 = Sunday, matching `Date.getDay()`. */
export type WeeklyHours = Record<number, TimeRange[]>;

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

/**
 * A customer of Belline's.
 *
 * Everything a tenant owns carries its id, and every query in the data layer
 * takes one. That is not belt-and-braces — it is the only property a business
 * buying multi-tenant software will actually ask about, and the failure being
 * designed against is not an attack but a developer in six months writing a
 * query that forgets. A signature that makes forgetting impossible is worth
 * more than a review that catches it most of the time.
 *
 * Introduced after the fact, in 2026-09, because the product started as one
 * venue group and grew into SaaS. Existing data was migrated into a single
 * tenant, so nothing observable changed the day it landed — see
 * `ensureTenancy` in seed.ts.
 */
export interface Tenant {
  id: string;
  name: string;
  status: "active" | "suspended";
  createdAt: string;
  /**
   * Ours, not a customer's. Holds Belline's own demo venue, which runs on the
   * same engine as everybody else's and must never appear in anybody's data.
   */
  internal?: boolean;
}

/**
 * One business, which may have several locations.
 *
 * The layer the old model skipped. "Dental Group" with branches in Marina,
 * Jumeirah and Downtown is one business and three diaries: the services, the
 * staff and the hours differ per branch, the name, the category and the
 * policies do not. Without this, "which of your branches is closest?" has
 * nowhere to be answered from.
 */
export interface Business {
  id: string;
  tenantId: string;
  name: string;
  /** What the business is, in a word: "Dental practice", "Salon", "Restaurant". */
  category?: string;
  description?: string;
  phone?: string;
  email?: string;
  website?: string;
  /**
   * Whether this business may appear in a consumer search.
   *
   * Off unless a merchant turns it on, and off is the value a business gets by
   * existing. The future consumer product reads businesses with this set and
   * nothing else; a business that has never heard of it is not in it.
   */
  discoverable?: boolean;
  createdAt: string;
}

export interface Location {
  id: string;
  /**
   * Who owns this venue, and which of their businesses it belongs to.
   *
   * Both are backfilled for data that predates tenancy, so they can be relied
   * on everywhere rather than defended against at each call site.
   */
  tenantId: string;
  businessId: string;
  name: string;
  vertical: Vertical;
  timezone: string;
  phone: string;
  address: string;
  currency: string;
  hours: WeeklyHours;
  /** Dates the venue is fully closed (holidays, private hire). */
  closures: DateStr[];
  agent: AgentConfig;
  restaurant?: RestaurantConfig;
  salon?: SalonConfig;
  /** Set when this venue is a public showcase rather than a real business. */
  demo?: DemoConfig;
  /** Set when this venue was read off a prospect's website for a sales demo. */
  prospect?: ProspectConfig;
  /**
   * Every published configuration this venue has had, oldest first.
   *
   * The live fields above are what the agent reads on the next call; this is
   * the record of how they got that way. See `brain.ts` — the questions asked
   * after something goes wrong are who changed it, when, why, and which
   * version handled the call being complained about, and a prompt cannot
   * answer any of them.
   */
  brainHistory?: BrainVersion[];
  /** A connected Google Calendar, mirrored to one-way. */
  google?: GoogleLink;
  /**
   * What one booking is typically worth here.
   *
   * Entered by the venue or left alone. Belline never guesses it: an invented
   * ROI figure is the fastest way to lose an operator who knows their own
   * numbers better than we do, and unset shows no estimate rather than zero.
   */
  averageBookingValue?: number;
  /** What this venue pays, and what it is owed. Absent until it signs up. */
  subscription?: Subscription;
  /**
   * The handles Stripe knows this venue by.
   *
   * Two ids and nothing else. Belline stores what it needs to open a customer
   * portal and to match a webhook to a diary; everything else about the
   * subscription — the card, the invoices, the retry schedule — is Stripe's to
   * be authoritative about, and mirroring it here would be a second source of
   * truth for somebody else's data.
   */
  stripe?: { customerId?: string; subscriptionId?: string };
  /**
   * The booking is not complete without an email address.
   *
   * True for a venue whose booking *is* something sent — a video call, a link,
   * a joining instruction. Where it is set the agent must take an address,
   * spell it back, and have it confirmed before booking, because an address
   * misheard over a phone line fails silently: nothing bounces that anybody
   * reads, and the guest simply never hears from us again.
   */
  requiresEmail?: boolean;
  /**
   * Ours, not a customer's.
   *
   * Belline's own venue — the diary of demo calls behind the bell on the
   * website — runs on the same engine as everybody else's, which is the whole
   * point of it. But it is not a venue anybody signed up for, and it must
   * never appear in a customer's venue switcher, their call list or their
   * bookings. `listLocations()` leaves it out unless asked for it directly.
   */
  internal?: boolean;
  /**
   * A logo to show behind the call.
   *
   * The voice widget is the one place a venue's own customer sees Belline
   * rather than the venue, so it carries the venue's mark, not ours. Unset
   * falls back to the Belline bell — on our own line that is the right
   * answer, and on a venue with no logo to hand it is at least a bell rather
   * than an empty rectangle.
   */
  logoUrl?: string;
}

/**
 * A venue's plan.
 *
 * Per venue, not per company: the pricing card says "one Belline
 * receptionist", and a second venue is a second line, a second diary and a
 * second set of rules. Anything else would need a rewrite the moment somebody
 * with two branches asked an obvious question.
 *
 * `startedOn` anchors every billing period that follows — see `periodFor` in
 * billing/usage.ts, which remembers the anchor day rather than clamping it.
 */
export interface Subscription {
  planId: PlanId;
  cycle: BillingCycle;
  /** `YYYY-MM-DD`. The billing anniversary, for as long as the plan lasts. */
  startedOn: DateStr;
  status: "trialing" | "active" | "cancelled";
  /** Set when someone cancels. Service runs to the end of the paid period. */
  cancelledAt?: string;
  /** Trialing only. Nothing is charged, and the allowance is its own. */
  trial?: {
    endsOn: DateStr;
    minutes: number;
  };
}

/**
 * A demo built from a prospect's public website.
 *
 * Everything in a venue carrying this was read off a web page by a model. It
 * is unverified by definition, it impersonates a real business by design, and
 * so it expires — a personalised demo that outlives the conversation it was
 * built for is just a page on the internet pretending to be somebody.
 */
export interface ProspectConfig {
  /** The public URL segment: /demo/<slug>. */
  slug: string;
  /** The website it was read from, shown on the demo so the source is plain. */
  sourceUrl: string;
  createdAt: string;
  /** After this, the page is gone. Not hidden — gone. */
  expiresAt: string;
}

/**
 * A demo line is a number strangers can dial, and every minute of it spends
 * real money with three vendors. So it is capped, disclosed, and self-cleaning
 * — none of which a private test number needs.
 */
export interface DemoConfig {
  enabled: boolean;
  /** Hard stop on spend. Calls beyond this hear a polite message and end. */
  maxCallsPerDay: number;
  /** Shorter than a real call: a demo makes its point in three minutes. */
  maxCallSeconds: number;
  /** Delete bookings this demo took before today, so the diary stays legible. */
  clearBookingsDaily: boolean;
  /** Appended to the greeting so nobody thinks they booked a real table. */
  disclosure: string;
}

export interface AgentConfig {
  /** The name the agent introduces itself with. */
  displayName: string;
  greeting: string;
  /**
   * Spoken instead of `greeting` when the caller's number matches a past
   * guest. `{name}` is replaced with the name they booked under. Left blank,
   * returning guests get the standard greeting.
   */
  returningGreeting?: string;
  /** ElevenLabs voice id. */
  voiceId: string;
  /**
   * ElevenLabs model id — the latency/warmth trade. Unset falls back to
   * `DEFAULT_VOICE_MODEL`; see `VOICE_MODELS` for what is worth offering.
   */
  voiceModel?: string;
  /** Delivery pace, 0.8–1.2. Unset falls back to `DEFAULT_VOICE_SPEED`. */
  voiceSpeed?: number;
  model: string;
  /** Free-text tone/personality guidance folded into the system prompt. */
  persona: string;
  /** Hard rules the agent must not break (deposit policy, cut-off times...). */
  policies: string[];
  faqs: Faq[];
  /** Number to warm-transfer to when the agent escalates. */
  transferNumber?: string;
  maxCallSeconds: number;
  /** How far ahead the agent is allowed to book. */
  bookingHorizonDays: number;
}

export interface Faq {
  q: string;
  a: string;
}

// ---------------------------------------------------------------------------
// Restaurant
// ---------------------------------------------------------------------------

export interface Table {
  id: string;
  name: string;
  minSeats: number;
  maxSeats: number;
  section: string;
}

export interface ServiceWindow {
  id: string;
  name: string;
  /** Weekdays this service runs, 0 = Sunday. */
  days: number[];
  start: Minutes;
  end: Minutes;
  /** Latest time a party may be seated in this service. */
  lastSeating: Minutes;
  /** Turn time by party size: first entry whose `upTo` >= party size wins. */
  turnTimes: { upTo: number; minutes: number }[];
}

export interface RestaurantConfig {
  tables: Table[];
  services: ServiceWindow[];
  /**
   * Pacing. Kitchens fall over when twelve tables are seated at 20:00 even if
   * twelve tables are physically free, so we cap covers seated per slot.
   */
  maxCoversPerSlot: number;
  slotMinutes: number;
  maxPartySize: number;
  /** What the agent should say when a party exceeds `maxPartySize`. */
  largePartyPolicy: string;
  /**
   * Covers a manager may seat beyond the pacing cap, by hand.
   *
   * Never available to the agent — pacing exists so the pass survives eight
   * o'clock, and a caller is the last person who should be able to override
   * it. But a manager who knows two tables are about to leave, or that the
   * kitchen has a spare pair of hands tonight, is making a judgement the
   * software cannot. Zero means the cap is absolute.
   */
  overbookPerSlot?: number;
}

// ---------------------------------------------------------------------------
// Salon / clinic
// ---------------------------------------------------------------------------

export interface SalonService {
  id: string;
  name: string;
  durationMin: number;
  /** Cleanup/reset time held after the appointment but not shown to guests. */
  bufferMin: number;
  price: number;
  /** Optional shared equipment this service needs (colour room, basin...). */
  resourceType?: string;
}

export interface StaffMember {
  id: string;
  name: string;
  /** Services this person is qualified to perform. */
  serviceIds: string[];
  hours: WeeklyHours;
  timeOff: { date: DateStr; start: Minutes; end: Minutes }[];
}

export interface Resource {
  id: string;
  name: string;
  type: string;
}

export interface SalonConfig {
  services: SalonService[];
  staff: StaffMember[];
  resources: Resource[];
  slotMinutes: number;
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export type WaitStatus = "waiting" | "offered" | "converted" | "expired" | "cancelled";

/**
 * Somebody who wanted a time that was gone.
 *
 * A full Friday is not a lost caller, it is a caller nobody wrote down. The
 * difference between a restaurant that keeps a waitlist and one that does not
 * is entirely in what happens when a table frees at five o'clock — and the
 * thing Belline can do that a booking system cannot is ring them back itself.
 */
export interface WaitlistEntry {
  id: string;
  locationId: string;
  guestName: string;
  guestPhone: string;
  date: DateStr;
  /** The window they would accept, not a single time. */
  earliestMin: Minutes;
  latestMin: Minutes;
  partySize?: number;
  serviceIds?: string[];
  /** Named a particular person, and will not take anyone else. */
  staffId?: string;
  status: WaitStatus;
  notes: string;
  /** The call this came from, so the conversation is one click away. */
  callId?: string;
  createdAt: string;
  updatedAt: string;
  /** When a slot was found and they were told about it. */
  offeredAt?: string;
  /** The booking this turned into. */
  bookingId?: string;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export type BookingStatus =
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

export interface Booking {
  id: string;
  /** Short human-readable code the agent reads out loud, e.g. "R7K2". */
  ref: string;
  locationId: string;
  vertical: Vertical;
  status: BookingStatus;
  date: DateStr;
  startMin: Minutes;
  endMin: Minutes;
  guestName: string;
  guestPhone: string;
  /**
   * Only where the venue needs one — see `Location.requiresEmail`.
   *
   * A restaurant booking a table has no use for an email and should not be
   * asking a caller to spell one out loud. A venue whose whole booking *is* an
   * email (a video call, a link to send) cannot do without it.
   */
  guestEmail?: string;
  notes: string;
  // Restaurant
  partySize?: number;
  tableIds?: string[];
  // Salon
  serviceIds?: string[];
  staffId?: string;
  resourceId?: string;
  source: "voice" | "manual" | "web" | "whatsapp";
  callId?: string;
  /**
   * Fingerprint of what this booking *is* — venue, day, time, guest, party or
   * services. A second request carrying the same fingerprint is the same
   * booking arriving twice, whatever the transport did, and returns this one
   * instead of holding a second table. See `booking/idempotency.ts`.
   */
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export type CallOutcome =
  | "booking_created"
  | "booking_changed"
  | "booking_cancelled"
  | "answered_question"
  | "message_taken"
  | "transferred"
  /**
   * Sent somewhere else entirely — emergency care, most importantly. Distinct
   * from "transferred" on purpose: nobody at the venue picked this call up,
   * and counting it as a handled transfer would overstate what happened.
   */
  | "escalated"
  | "abandoned";

export interface TranscriptTurn {
  role: "caller" | "agent" | "system";
  text: string;
  at: string;
  /** For agent turns: ms from end of caller speech to first audio out. */
  latencyMs?: number;
}

export interface ToolTrace {
  at: string;
  name: string;
  input: unknown;
  output: unknown;
  ms: number;
  ok: boolean;
}

export interface Call {
  id: string;
  locationId: string;
  /**
   * Which way Belline dealt with this person.
   *
   * A "call" here means an episode, not a telephone line — a WhatsApp
   * conversation produces one too. The dashboard's whole premise is "what did
   * Belline do for me this week", and that question must not have two answers
   * depending on which channel somebody happened to use.
   *
   * Only  is billable; see billing/usage.ts, which checks this.
   */
  channel: "browser" | "phone" | "whatsapp";
  from: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "failed";
  outcome: CallOutcome | null;
  transcript: TranscriptTurn[];
  toolCalls: ToolTrace[];
  /** Per-turn response latency, first-audio-out minus end-of-speech. */
  latenciesMs: number[];
  bookingId?: string;
  summary?: string;
  /** Kept out of the venue's real analytics. */
  isDemo?: boolean;
  /** Set when the caller asked for something the agent could not do. */
  escalation?: string;
  /**
   * The authority rule that decided this call, when one did.
   *
   * "Why did it say that?" is the question asked afterwards, and on the calls
   * where it matters most the answer is a named, versioned rule rather than a
   * sentence in a prompt — which is the difference between a control you can
   * show someone and a claim you can only make.
   */
  authorityRuleId?: string;
  /**
   * The Business Brain version that handled this call.
   *
   * "Which configuration said that?" is unanswerable once a venue has edited
   * its policies twice, unless it was written down at the time. Recorded here
   * so a complaint about a call from three weeks ago can be read against the
   * rules that were actually live when it happened.
   */
  brainVersion?: number;
  /**
   * When somebody dealt with what this call needed.
   *
   * Only ever set by a person clearing it from the Action Inbox — an item is
   * derived from the call's own properties, so nothing else can decide it no
   * longer needs attention.
   */
  attentionResolvedAt?: string;
  attentionResolvedBy?: string;
}

// ---------------------------------------------------------------------------
// People who can open the dashboard
// ---------------------------------------------------------------------------

/**
 * `owner` runs the business: every venue, plus user management.
 * `manager` runs one or more venues: can change how the agent behaves there.
 * `staff` works the floor: can read the book and the calls, nothing else.
 */
export type Role = "owner" | "manager" | "staff";

export interface User {
  id: string;
  /**
   * The one tenant this person belongs to.
   *
   * Checked before `locationIds` and before any route-level rule: a venue id
   * from another tenant is refused even if it somehow appears in this user's
   * list. The list narrows access within a tenant; it cannot widen it across
   * one.
   */
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  /** Empty means every venue in the tenant — only meaningful for an owner. */
  locationIds: string[];
  /** scrypt digest; never leaves the server. */
  passwordHash: string;
  createdAt: string;
  lastSeenAt?: string;
  disabled?: boolean;
}

export interface Session {
  /** The opaque value held in the cookie. */
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface Slot {
  date: DateStr;
  startMin: Minutes;
  endMin: Minutes;
  /** Restaurant: tables that would be used. Salon: the staff member. */
  tableIds?: string[];
  staffId?: string;
  staffName?: string;
  resourceId?: string;
}

export interface AvailabilityQuery {
  locationId: string;
  date: DateStr;
  /** Preferred time; results are ranked by distance from it. */
  preferredMin?: Minutes;
  partySize?: number;
  serviceIds?: string[];
  staffId?: string;
  /** Minutes either side of `preferredMin` to search. */
  windowMin?: number;
  /** Ignore this booking when checking conflicts (used when modifying). */
  excludeBookingId?: string;
}
