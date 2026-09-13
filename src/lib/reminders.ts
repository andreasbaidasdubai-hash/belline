import type { Booking, Location } from "./types";
import { getBooking, getTenant, listBookings, listLocations, saveBooking } from "./store";
import { sendSms, smsEnabled } from "./providers/sms";
import { serviceState } from "./billing/entitlement";
import { dateToSpoken, minutesToSpoken, todayIn } from "./time";

/**
 * The text the day before.
 *
 * The cheapest no-show reduction there is, and the one every booking platform
 * a venue is comparing us with already sends. A guest who has forgotten is not
 * a guest who has decided not to come.
 *
 * Four rules, each one a complaint avoided:
 *
 *   Never twice. The booking is marked *before* the text goes, so a crash
 *   mid-send cannot become a second reminder on the next sweep. A reminder
 *   that fails is recorded as failed and not retried — two texts about one
 *   table read as two tables.
 *
 *   Not for a booking made inside the window. Somebody who booked this
 *   afternoon for tonight has just had a confirmation; a reminder an hour
 *   later is noise.
 *
 *   Not in the last hour. A reminder that arrives as the guest walks in is not
 *   a reminder.
 *
 *   Not for venues that are not ours to text for — demo lines, prospect demos,
 *   and venues whose trial has run out.
 */

export const DEFAULT_REMINDER_HOURS = 24;
const MIN_LEAD_MS = 60 * 60 * 1000;

export function remindersEnabled(location: Location): boolean {
  return location.reminders?.enabled ?? true;
}

export function reminderHours(location: Location): number {
  const h = location.reminders?.hoursBefore ?? DEFAULT_REMINDER_HOURS;
  return Math.min(72, Math.max(2, Math.round(h)));
}

/**
 * The instant a wall-clock time in a venue's timezone happens.
 *
 * Bookings are stored as a date and minutes from local midnight, which is
 * right for a diary and useless for "is this within 24 hours". Two passes,
 * because the offset has to be read at the answer, not at the guess — they
 * differ on the day a timezone changes its clocks.
 */
export function instantOf(date: string, minutes: number, timezone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - offsetMs(guess, timezone);
  return guess;
}

function offsetMs(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Bookings at this venue whose reminder should go out now. Pure apart from its inputs. */
export function dueReminders(location: Location, bookings: Booking[], now: number): Booking[] {
  if (!remindersEnabled(location)) return [];
  const window = reminderHours(location) * 60 * 60 * 1000;

  return bookings.filter((b) => {
    if (b.locationId !== location.id || b.status !== "confirmed") return false;
    if (b.reminder?.sentAt || b.reminder?.failedAt) return false;
    if (b.guestPhone.replace(/\D/g, "").length < 8) return false;

    const start = instantOf(b.date, b.startMin, location.timezone);
    const ahead = start - now;
    if (ahead < MIN_LEAD_MS || ahead > window) return false;

    // Booked inside the window: the confirmation was the reminder.
    const created = Date.parse(b.createdAt);
    if (Number.isFinite(created) && start - created <= window) return false;
    return true;
  });
}

export function reminderMessage(location: Location, booking: Booking): string {
  const when = `${dateToSpoken(booking.date, location.timezone)} at ${minutesToSpoken(booking.startMin)}`;
  const what =
    booking.vertical === "restaurant"
      ? `table for ${booking.partySize ?? ""}`.trim()
      : (booking.serviceIds ?? [])
          .map((id) => location.salon?.services.find((s) => s.id === id)?.name)
          .filter(Boolean)
          .join(" + ") || "appointment";

  const deposit =
    booking.deposit?.status === "required" && booking.deposit.link
      ? ` The ${booking.deposit.currency} ${booking.deposit.amount} deposit is still open: ${booking.deposit.link}`
      : "";
  const change = location.phone ? ` To change or cancel, call ${location.phone}.` : "";

  return `${location.name}: a reminder of your ${what} ${when}. Reference ${booking.ref}.${change}${deposit}`;
}

function textsFor(location: Location): boolean {
  if (location.demo?.enabled || location.prospect || location.internal) return false;
  if (getTenant(location.tenantId)?.internal) return false;
  return serviceState(location, todayIn(location.timezone)).answering;
}

/** One sweep over every venue. Safe to call as often as you like. */
export async function sendDueReminders(now = Date.now()): Promise<{ sent: number; failed: number }> {
  const tally = { sent: 0, failed: 0 };
  if (!smsEnabled()) return tally;

  for (const location of listLocations()) {
    if (!textsFor(location)) continue;
    const due = dueReminders(location, listBookings({ locationId: location.id }), now);

    for (const booking of due) {
      // Claimed before sending. See "never twice" above.
      saveBooking({ ...booking, reminder: { sentAt: new Date(now).toISOString() } });
      const result = await sendSms(booking.guestPhone, reminderMessage(location, booking));
      if (result.sent) {
        tally.sent++;
        continue;
      }
      tally.failed++;
      const latest = getBooking(booking.id) ?? booking;
      saveBooking({
        ...latest,
        reminder: { failedAt: new Date().toISOString(), reason: result.reason },
      });
    }
  }
  return tally;
}
