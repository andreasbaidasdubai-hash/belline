import type { Call, Location } from "./types";
import { listBookings, listCalls } from "./store";
import { attentionFor, type AttentionItem } from "./attention";
import { currentVersion } from "./brain";
import { connectionState } from "./integrations/google";
import { outlookConnectionState } from "./integrations/outlook";
import { todayIn, nowMinutesIn } from "./time";
import { isRestaurant, terms } from "./verticals";

/**
 * What Belline did for this business.
 *
 * The home page was stat tiles — calls, containment, p50 latency. All true,
 * none of it the question the owner opened the app to ask. They want to know
 * whether the thing is earning its keep and whether anything needs them, and
 * a latency percentile answers neither.
 *
 * So this derives three things, in the order they matter:
 *
 *   What it did today. Outcomes, not volume. "Eleven bookings" is worth
 *   something; "forty-two calls" is worth nothing on its own.
 *
 *   What that was worth. Only ever from numbers the venue entered itself, and
 *   labelled as the estimate it is. Inventing an ROI figure is the fastest way
 *   to lose an operator who knows their own business better than we do.
 *
 *   Whether anything is broken. A voice agent failing silently is the worst
 *   failure this product has, because the calls simply stop and nobody is told.
 */

export interface DidToday {
  answered: number;
  booked: number;
  moved: number;
  cancelled: number;
  questions: number;
  messages: number;
  escalated: number;
  /** Rang off part-way through. Answered, but not seen through. */
  abandoned: number;
  /** Calls taken when the venue was shut. Nobody else would have answered. */
  outsideHours: number;
}

/**
 * What is outstanding.
 *
 * A bare number was wrong twice over: the sidebar counts every venue this user
 * can see and the page counts one, so the same words showed two figures on the
 * same screen; and not every item is a call — a freed slot with somebody
 * waiting for it has no call attached at all.
 */
export interface NeedsYou {
  total: number;
  /** The single most urgent thing, so the banner can say what to actually do. */
  top: AttentionItem | null;
}

export interface Worth {
  bookings: number;
  /** Only set when the venue has told us what a booking is worth to them. */
  estimate: number | null;
  currency: string;
  /** Over how many days the estimate runs. */
  days: number;
}

export interface Health {
  label: string;
  ok: boolean;
  /** What is true. Shown everywhere. */
  detail: string;
  /**
   * What to do about it. Only the banner shows this, so a failing check does
   * not print the same sentence twice on one screen.
   */
  fix?: string;
  /** Belline's own configuration. Shown to Belline staff, never to an owner. */
  staffOnly?: boolean;
}

/**
 * The health lines a person may see. An owner is not shown "model key
 * missing": it is not theirs to fix, and the words mean nothing to them.
 */
export function visibleHealth(health: Health[], staff: boolean): Health[] {
  return staff ? health : health.filter((h) => !h.staffOnly);
}

export interface Overview {
  did: DidToday;
  worth: Worth;
  health: Health[];
  needsYou: NeedsYou;
  recent: Call[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Was the venue open when this call came in?
 *
 * In the venue's own timezone, which is the only one that means anything —
 * a Dubai restaurant's "after hours" is not the server's. Read out of Intl
 * parts rather than parsed back out of a formatted string, because the
 * formatted shape changes with locale and the parts do not.
 */
function withinHours(location: Location, call: Call): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: location.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(call.startedAt));

  const find = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAYS.indexOf(find("weekday"));
  if (weekday < 0) return true; // Unparseable: do not claim it was after hours.

  const minutes = Number(find("hour")) * 60 + Number(find("minute"));
  return (location.hours[weekday] ?? []).some((r) => minutes >= r.start && minutes < r.end);
}

export function overviewFor(location: Location): Overview {
  const today = todayIn(location.timezone);
  const calls = listCalls(location.id).filter((c) => !c.isDemo);

  const todays = calls.filter(
    (c) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: location.timezone }).format(
        new Date(c.startedAt),
      ) === today,
  );
  const done = todays.filter((c) => c.status === "completed");

  const did: DidToday = {
    answered: done.length,
    booked: done.filter((c) => c.outcome === "booking_created").length,
    moved: done.filter((c) => c.outcome === "booking_changed").length,
    cancelled: done.filter((c) => c.outcome === "booking_cancelled").length,
    questions: done.filter((c) => c.outcome === "answered_question").length,
    messages: done.filter((c) => c.outcome === "message_taken").length,
    escalated: done.filter((c) => c.outcome === "escalated" || c.outcome === "transferred").length,
    abandoned: done.filter((c) => c.outcome === "abandoned").length,
    outsideHours: done.filter((c) => !withinHours(location, c)).length,
  };

  // A month, because a week of a new venue is noise and a year is a report
  // nobody reads on a phone.
  const DAYS = 30;
  const since = new Date();
  since.setDate(since.getDate() - DAYS);
  const sinceDate = since.toISOString().slice(0, 10);

  const bookings = listBookings({ locationId: location.id, status: "confirmed" }).filter(
    (b) => b.source === "voice" && b.createdAt.slice(0, 10) >= sinceDate,
  );

  const perBooking = location.averageBookingValue ?? 0;
  const worth: Worth = {
    bookings: bookings.length,
    // Null, not zero. "No estimate" and "worth nothing" are different, and
    // showing £0 to a venue that simply has not filled the field in is worse
    // than showing nothing at all.
    estimate: perBooking > 0 ? Math.round(bookings.length * perBooking) : null,
    currency: location.currency,
    days: DAYS,
  };

  // The venue's one calendar connection: Outlook where it has one, Google otherwise.
  const google = location.outlook ? outlookConnectionState(location) : connectionState(location);
  const version = currentVersion(location);
  const lastCall = calls[0];
  const hoursSinceCall = lastCall
    ? (Date.now() - new Date(lastCall.startedAt).getTime()) / 3_600_000
    : Infinity;

  // Calls that arrive and then go nowhere. The panel checked that calls were
  // coming in and that the vendors were configured, and would have reported
  // both green while every caller in the list hung up part-way through —
  // which is precisely the silent failure it exists to catch.
  //
  // Judged over the recent run rather than today, because a venue that takes
  // four calls a day has no signal in a single day. Five is the floor for
  // saying anything at all: one hang-up out of two is noise, not a pattern.
  const RUN = 20;
  const FLOOR = 5;
  const run = calls.filter((c) => c.status === "completed").slice(0, RUN);
  const rangOff = run.filter((c) => c.outcome === "abandoned").length;
  const share = run.length ? rangOff / run.length : 0;

  const health: Health[] = [
    {
      label: "Calls arriving",
      // Not proof the line is forwarded — but a venue that has taken nothing
      // in three days either is not forwarded or has a problem, and that is
      // exactly the silence nobody notices.
      // The phone is optional: a business on its website chat or chat link
      // alone has no line to go quiet, and "needs fixing" in red would be false.
      ok: hoursSinceCall < 72 || !location.bellineNumber?.number.trim(),
      detail: lastCall
        ? `Last call ${new Date(lastCall.startedAt).toLocaleString()}`
        : location.bellineNumber?.number.trim()
          ? "No calls yet. Check the number is forwarded."
          : "No Belline number yet. Get one under Channels, Phone.",
    },
    {
      label: "Calls completing",
      ok: run.length < FLOOR || share <= 1 / 3,
      detail:
        run.length < FLOOR
          ? "Too few calls yet to tell."
          : rangOff === 0
            ? `Nobody rang off in the last ${run.length}.`
            : `${rangOff} of the last ${run.length} callers rang off part-way through.`,
      fix:
        run.length >= FLOOR && share > 1 / 3
          ? "Read a couple back — that is high enough to be Belline's fault rather than theirs."
          : undefined,
    },
    {
      label: "Agent configured",
      ok: Boolean(version),
      detail: version
        ? `Version ${version.number}, ${version.authorName}, ${new Date(version.createdAt).toLocaleDateString()}`
        : "No published configuration.",
    },
    {
      label: "Calendar",
      ok: !google.connected || google.healthy,
      detail: google.detail,
    },
    ...(location.subscription?.paymentFailedAt
      ? [
          {
            label: "Payment",
            ok: false,
            detail: "The last payment did not go through. Belline is still answering.",
            fix: "Update the card under Plan and usage.",
          },
        ]
      : []),
    {
      label: "Speech and model",
      // Our configuration, not the owner's: nothing on their side fixes it.
      staffOnly: true,
      ok: Boolean(
        process.env.ANTHROPIC_API_KEY && process.env.DEEPGRAM_API_KEY && process.env.ELEVENLABS_API_KEY,
      ),
      detail: [
        process.env.ANTHROPIC_API_KEY ? null : "model key missing",
        process.env.DEEPGRAM_API_KEY ? null : "speech-to-text key missing",
        process.env.ELEVENLABS_API_KEY ? null : "voice key missing",
      ]
        .filter(Boolean)
        .join(", ") || "All three vendors configured",
    },
  ];

  const outstanding = attentionFor(location);

  return {
    did,
    worth,
    health,
    // Already sorted most urgent first by attentionFor.
    needsYou: { total: outstanding.length, top: outstanding[0] ?? null },
    recent: calls.slice(0, 6),
  };
}

/**
 * What Belline handled over the last `days` days, for Home.
 *
 * The reports page said how many calls "ended in a booking", which for an
 * account that takes requests is always nought and reads as failure. What an
 * owner wants to know is how much Belline dealt with for them, so this counts
 * handled conversations: real ones (not a demo, not a forwarding test, not the
 * owner in the test console) that finished without the caller ringing off.
 *
 * Calls are the phone and the website's voice button; chats are the website
 * chat and the chat link. WhatsApp threads live in the messages database and
 * are not counted here, and Home says so rather than folding them in.
 */
export interface Handled {
  days: number;
  calls: number;
  chats: number;
  /** Booking requests taken in the same conversations. */
  requests: number;
  /** Put through to a person, or sent on to someone else. */
  toPerson: number;
  /** Real conversations where the caller rang off part-way. Said, not hidden. */
  rangOff: number;
}

export function handledOver(location: Location, days: number, now: Date = new Date()): Handled {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const real = listCalls(location.id).filter((c) => !c.isDemo && !c.isTest && c.channel !== "browser" && c.startedAt >= since && c.status === "completed");
  const handled = real.filter((c) => c.outcome !== "abandoned");
  return {
    days,
    calls: handled.filter((c) => c.channel === "phone" || c.channel === "embed").length,
    chats: handled.filter((c) => c.channel === "webchat").length,
    requests: handled.reduce((n, c) => n + (c.bookingRequests?.length ?? 0), 0),
    toPerson: handled.filter((c) => c.outcome === "transferred" || c.outcome === "escalated").length,
    rangOff: real.length - handled.length,
  };
}

/** One line saying what Belline did, in the venue's own words. */
export function summarise(location: Location, did: DidToday): string {
  const t = terms(location);
  if (did.answered === 0) {
    return `Nothing yet today. Belline is listening — ${t.guests} who ring will be answered.`;
  }

  const parts: string[] = [];
  if (did.booked) parts.push(`${did.booked} ${did.booked === 1 ? t.booking : `${t.booking}s`} taken`);
  if (did.moved) parts.push(`${did.moved} moved`);
  if (did.cancelled) parts.push(`${did.cancelled} cancelled`);
  if (did.questions) parts.push(`${did.questions} ${did.questions === 1 ? "question" : "questions"} answered`);
  if (did.messages) parts.push(`${did.messages} ${did.messages === 1 ? "message" : "messages"} taken`);

  const work = parts.length ? parts.join(", ") : "nothing booked yet";
  const after = did.outsideHours
    ? ` ${did.outsideHours} of them when you were closed.`
    : "";
  // Said out loud rather than buried in the tiles. A hang-up counted silently
  // as an answered call is the page flattering itself.
  const off = did.abandoned
    ? ` ${did.abandoned} rang off part-way through.`
    : "";

  return `${did.answered} ${did.answered === 1 ? "call" : "calls"} answered — ${work}.${after}${off}`;
}

export { isRestaurant };
