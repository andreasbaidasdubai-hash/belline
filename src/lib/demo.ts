import type { Call, Location } from "./types";
import { listBookings, listCalls, saveBooking } from "./store";
import { todayIn } from "./time";

/**
 * The public demo line.
 *
 * A number a stranger can dial is not the same object as a private test
 * number, and the difference is entirely about what happens when it is
 * abused. Someone will leave it off the hook, someone will call it forty
 * times, and someone will try to make it say something embarrassing. Each of
 * those costs money with three vendors at once, so the line is capped before
 * it is clever.
 */

export function isDemo(location: Location): boolean {
  return Boolean(location.demo?.enabled);
}

/** Calls this demo has taken today, in the venue's own timezone. */
export function callsToday(location: Location): number {
  const today = todayIn(location.timezone);
  return listCalls(location.id).filter(
    (c) => c.isDemo && dayOf(c, location) === today,
  ).length;
}

function dayOf(call: Call, location: Location): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: location.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(call.startedAt));
}

export interface DemoGate {
  allowed: boolean;
  used: number;
  limit: number;
  /** Spoken to the caller when the line is closed for the day. */
  message?: string;
}

/**
 * Decide whether to accept an incoming demo call.
 *
 * Checked in the webhook, before any media stream opens — a rejected call
 * costs one TwiML response instead of three vendor connections.
 */
export function checkDemoGate(location: Location): DemoGate {
  const config = location.demo;
  if (!config?.enabled) {
    return { allowed: true, used: 0, limit: 0 };
  }

  const used = callsToday(location);
  if (used < config.maxCallsPerDay) {
    return { allowed: true, used, limit: config.maxCallsPerDay };
  }

  return {
    allowed: false,
    used,
    limit: config.maxCallsPerDay,
    message:
      "Thanks for calling the Belline demonstration line. It has reached its limit of calls for today. Please try again tomorrow, or get in touch and we will set up a line for your own venue.",
  };
}

/**
 * Remove bookings this demo took on previous days.
 *
 * Without it the demo diary fills with strangers' test reservations and the
 * next prospect is told there is no availability — which demonstrates the
 * opposite of what it is meant to. Today's are kept, so a caller who books
 * can still hear it read back and see it in the dashboard.
 */
export function clearOldDemoBookings(location: Location): number {
  if (!location.demo?.clearBookingsDaily) return 0;

  const today = todayIn(location.timezone);
  const stale = listBookings({ locationId: location.id }).filter(
    (b) => b.source === "voice" && b.date < today && b.status === "confirmed",
  );

  for (const booking of stale) {
    saveBooking({ ...booking, status: "cancelled", updatedAt: new Date().toISOString() });
  }
  return stale.length;
}

/**
 * How long a call on this venue may run. A demo makes its point in three
 * minutes; a real caller sorting out a booking sometimes needs seven.
 */
export function maxCallSeconds(location: Location, channel: Call["channel"]): number {
  let limit = location.agent.maxCallSeconds;
  if (location.demo?.enabled) limit = Math.min(limit, location.demo.maxCallSeconds);
  // The widget's own ceiling, on the widget's own calls and nowhere else. It
  // was configurable, shown on the dashboard, and read by nothing — a venue
  // that set it to 300 got 480. Applied to the telephone it would be wrong the
  // other way: a stranger's browser call is not a caller sorting out a booking.
  if (channel === "embed" && location.embed?.enabled) {
    limit = Math.min(limit, location.embed.maxCallSeconds);
  }
  return limit;
}

/**
 * Calls a venue's own test console has made today.
 *
 * The console is behind a session, and for a while that was the whole gate:
 * anyone who could sign in could run eight-minute calls back to back for as
 * long as they liked, at our cost with three vendors, and a signup takes a
 * minute. Not billed — the pricing page promises test calls do not count, and
 * that promise stands — but bounded. Forty a day is a venue genuinely testing
 * its agent; four hundred is something else.
 */
export const CONSOLE_CALLS_PER_DAY = 40;

export function checkConsoleGate(location: Location): DemoGate {
  const today = todayIn(location.timezone);
  const used = listCalls(location.id).filter(
    (c) => c.channel === "browser" && !c.isDemo && dayOf(c, location) === today,
  ).length;
  if (used < CONSOLE_CALLS_PER_DAY) {
    return { allowed: true, used, limit: CONSOLE_CALLS_PER_DAY };
  }
  return {
    allowed: false,
    used,
    limit: CONSOLE_CALLS_PER_DAY,
    message: "The test console has had its day's worth of calls. It opens again tomorrow.",
  };
}

/** Every venue currently acting as a public demo. */
export function demoLocations(locations: Location[]): Location[] {
  return locations.filter(isDemo);
}
