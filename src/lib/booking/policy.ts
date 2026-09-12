import type {
  Booking,
  DateStr,
  DepositRule,
  Location,
  Minutes,
} from "../types";
import { addDays, daysBetween, minutesToSpoken, nowMinutesIn, todayIn, weekdayOf } from "../time";
import { normalisePhone } from "../guests";

/**
 * The house rules, as opposed to the floor plan.
 *
 * `restaurant.ts` and `salon.ts` answer one question — is the room free — and
 * they answer it well. They cannot answer the other one, which is whether the
 * business will take this booking at all. A table being empty at nine tomorrow
 * morning does not mean a clinic will schedule a two-hour extraction for it
 * when the patient rings at ten to nine tonight, and an agent that cannot tell
 * the two questions apart will confidently do exactly that.
 *
 * Kept deliberately free of the store: every function here takes what it needs
 * as an argument, including the current time, which is what makes the rules
 * testable at all — a rule about notice periods that can only be tested by
 * waiting is a rule nobody tests.
 */

export interface Now {
  date: DateStr;
  min: Minutes;
}

export function nowIn(location: Location): Now {
  return { date: todayIn(location.timezone), min: nowMinutesIn(location.timezone) };
}

export type PolicyReason =
  | "past"
  | "too_soon"
  | "too_far"
  | "cutoff"
  | "needs_review"
  | "too_many_open";

export interface PolicyRefusal {
  ok: false;
  reason: PolicyReason;
  /** Said to the caller. Written as a sentence, not a code. */
  detail: string;
}

export interface PolicyRequest {
  date: DateStr;
  startMin: Minutes;
  /**
   * Extra notice this particular thing needs, beyond the venue's own rule — a
   * tasting menu, a treatment that needs a patch test. The larger of the two
   * applies.
   */
  minNoticeMin?: number;
  /** The caller, for the rules that depend on their history. */
  guestPhone?: string;
  /** Their bookings here. Pass the venue's book; this filters it. */
  history?: Booking[];
  /**
   * A person working the diary rather than a caller on the line.
   *
   * Every rule below exists to stop the *agent* promising something the venue
   * cannot do. A manager taking a booking by hand has already decided, and
   * software that argues with them gets worked around within a week.
   */
  staffOverride?: boolean;
  now?: Now;
}

/** How far ahead this venue will take a booking. */
export function horizonDays(location: Location): number {
  return location.policy?.maxHorizonDays ?? location.agent.bookingHorizonDays;
}

/**
 * Minutes between `now` and a booking's start. Negative means it has passed.
 *
 * Dates are whole days apart in the venue's own calendar and times are minutes
 * from its own midnight, so this is arithmetic rather than timezone work —
 * which is the entire reason the domain model stores them that way.
 */
export function noticeMinutes(now: Now, date: DateStr, startMin: Minutes): number {
  return daysBetween(now.date, date) * 24 * 60 + (startMin - now.min);
}

/**
 * Will this venue take this booking, at this moment, from this person?
 *
 * Returns null when it will. The refusals are phrased for the caller to hear,
 * because the alternative — a code the prompt has to translate — is a sentence
 * the model writes itself, and the one thing a venue cannot have is its own
 * cancellation policy improvised on the phone.
 */
export function checkPolicy(
  location: Location,
  request: PolicyRequest,
): PolicyRefusal | null {
  const now = request.now ?? nowIn(location);
  const policy = location.policy ?? {};
  const notice = noticeMinutes(now, request.date, request.startMin);

  // Before every other rule, because a person working the book is allowed to
  // do things the agent is not — including writing down a walk-in that has
  // already happened, which is the one legitimate reason to book into the past.
  if (request.staffOverride) return null;

  if (notice < 0) {
    return { ok: false, reason: "past", detail: "That time has already passed." };
  }

  const required = Math.max(policy.minNoticeMin ?? 0, request.minNoticeMin ?? 0);
  if (required > 0 && notice < required) {
    return {
      ok: false,
      reason: "too_soon",
      detail: `That is inside the ${spokenNotice(required)} notice we need. The earliest I can do is ${earliestSpoken(now, required)}.`,
    };
  }

  if (
    policy.sameDayCutoffMin !== undefined &&
    request.date === now.date &&
    now.min >= policy.sameDayCutoffMin
  ) {
    return {
      ok: false,
      reason: "cutoff",
      detail: `We stop taking bookings for the same day at ${minutesToSpoken(policy.sameDayCutoffMin)}. I can look at tomorrow.`,
    };
  }

  const horizon = horizonDays(location);
  if (horizon > 0 && daysBetween(now.date, request.date) > horizon) {
    return {
      ok: false,
      reason: "too_far",
      detail: `We only take bookings ${horizon} days ahead, so that is not open yet.`,
    };
  }

  const mine = bookingsOf(request.history ?? [], request.guestPhone);

  const limit = policy.noShowsBeforeReview ?? 0;
  if (limit > 0 && mine.filter((b) => b.status === "no_show").length >= limit) {
    return {
      ok: false,
      reason: "needs_review",
      // Never says why. A guest being told by a machine that they are on a
      // list is a review the venue reads for years; a call back from a person
      // is a conversation the venue can actually have.
      detail: "I will need to have someone confirm this one with you.",
    };
  }

  const open = policy.maxOpenPerGuest ?? 0;
  if (open > 0) {
    const upcoming = mine.filter(
      (b) => b.status === "confirmed" && b.date >= now.date,
    ).length;
    if (upcoming >= open) {
      return {
        ok: false,
        reason: "too_many_open",
        detail: `You already have ${upcoming} booking${upcoming === 1 ? "" : "s"} with us. I can move one of those, or put you through to the team.`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

export interface DepositRequest {
  date: DateStr;
  partySize?: number;
  /** What the services come to, for a diary venue. */
  value?: number;
  guestPhone?: string;
  history?: Booking[];
}

/**
 * Whether money is wanted up front, and how much.
 *
 * Works it out and says so. It does not take it — a voice agent reading a card
 * number back over a phone line is not a feature this product will have, and a
 * venue that wants the money takes it through its own payment link with the
 * booking reference this returns alongside.
 */
export function depositFor(
  location: Location,
  request: DepositRequest,
): NonNullable<Booking["deposit"]> | undefined {
  const rule = location.policy?.deposit;
  if (!rule) return undefined;
  if (!depositApplies(rule, request)) return undefined;

  const amount =
    rule.per === "person" ? rule.amount * (request.partySize ?? 1) : rule.amount;

  return { amount, currency: location.currency, status: "required" };
}

function depositApplies(rule: DepositRule, request: DepositRequest): boolean {
  if (rule.minPartySize !== undefined && (request.partySize ?? 0) < rule.minPartySize) {
    return false;
  }
  if (rule.minValue !== undefined && (request.value ?? 0) < rule.minValue) return false;
  if (rule.weekdays?.length && !rule.weekdays.includes(weekdayOf(request.date))) {
    return false;
  }
  if (rule.newGuestsOnly) {
    const mine = bookingsOf(request.history ?? [], request.guestPhone);
    const been = mine.some((b) => b.status === "completed" || b.status === "confirmed");
    if (been) return false;
  }
  return true;
}

/** What the agent says about the deposit, in the venue's words where it has some. */
export function depositWording(
  location: Location,
  deposit: NonNullable<Booking["deposit"]>,
): string {
  const rule = location.policy?.deposit;
  if (rule?.wording) return rule.wording;
  return `There is a ${deposit.currency} ${deposit.amount} deposit on this booking. The team will send a link to settle it.`;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/** Inside the venue's own cancellation window, and therefore a late cancellation. */
export function isLateCancel(
  location: Location,
  booking: Booking,
  now?: Now,
): boolean {
  const hours = location.policy?.cancellationWindowHours;
  if (!hours) return false;
  const at = now ?? nowIn(location);
  return noticeMinutes(at, booking.date, booking.startMin) < hours * 60;
}

/**
 * What to say when somebody cancels inside the window.
 *
 * Deliberately does not threaten. Belline charges nobody and has no way to; it
 * states the policy the venue set and marks the booking, and the venue decides.
 * Anything stronger is a machine making a commercial decision on a call it
 * cannot see the context of.
 */
export function lateCancelNotice(location: Location): string | null {
  const policy = location.policy;
  if (!policy?.cancellationWindowHours) return null;
  const fee = policy.lateCancelFee;
  return fee
    ? `That is inside our ${policy.cancellationWindowHours}-hour cancellation window, so a ${location.currency} ${fee} charge may apply. I have cancelled it and noted the time you called.`
    : `That is inside our ${policy.cancellationWindowHours}-hour cancellation window. I have cancelled it and let the team know.`;
}

// ---------------------------------------------------------------------------

function bookingsOf(history: Booking[], phone?: string): Booking[] {
  if (!phone) return [];
  const key = normalisePhone(phone);
  if (key.length < 6) return [];
  return history.filter((b) => normalisePhone(b.guestPhone) === key);
}

function spokenNotice(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? "24 hours" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The first moment that would satisfy the notice rule, said as a time. */
function earliestSpoken(now: Now, requiredMin: number): string {
  const total = now.min + requiredMin;
  const days = Math.floor(total / (24 * 60));
  const min = total % (24 * 60);
  const when = minutesToSpoken(min);
  if (days === 0) return when;
  if (days === 1) return `${when} tomorrow`;
  return `${when} on ${addDays(now.date, days)}`;
}
