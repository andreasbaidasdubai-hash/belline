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

export interface Location {
  id: string;
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
  notes: string;
  // Restaurant
  partySize?: number;
  tableIds?: string[];
  // Salon
  serviceIds?: string[];
  staffId?: string;
  resourceId?: string;
  source: "voice" | "manual" | "web";
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
  channel: "browser" | "phone";
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
  email: string;
  name: string;
  role: Role;
  /** Empty means every venue — only meaningful for an owner. */
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
