import type { Booking, CalendarEventRef, CalendarSync, Location } from "../types";
import { getBooking, getLocation, listBookings, saveBooking } from "../store";
import { googleUsable } from "../booking/destination";
import { openException } from "../exceptions";
import {
  bookingEventId,
  calendarFor,
  eventFor,
  noteWriteFailure,
  noteWriteSuccess,
  recheckMisconfigured,
  sweepAbandonedConnects,
  withAccess,
} from "./google";
import { GoogleAuthError, GoogleConfigError } from "./google-api";
import { todayIn } from "../time";

/**
 * Every booking at a venue with a Google Calendar, in the calendar.
 *
 * The Google provider writes the agent's own bookings as it makes them. Every
 * other way a booking is made, moved or cancelled — the desk, the calendar
 * drag, a guest's manage link, a guest renamed — came through the booking
 * engine and, at a venue booking into Google, never reached Google at all. A
 * receptionist's booking then existed only in Belline, and the team looking at
 * their Google Calendar saw a free hour.
 *
 * So each change is marked on the booking (`calendarSync`) before Google is
 * asked, and the booking is then driven to where it should be: an event, by the
 * booking's stored id, on the calendar for that person, or no event once it is
 * cancelled. Every write is a create-or-replace or a delete by id, so doing it
 * twice changes nothing.
 *
 * The booking is never lost to a calendar that will not answer. It is already
 * saved when this runs; a failure is recorded on it, the owner is told on the
 * connection, the sweep retries with a back-off, and a second failure in a row
 * opens a `google_sync_failed` exception for the team.
 */

/** A second failure in a row is the team's to look at; the first may be a blip. */
export const SYNC_EXCEPTION_AFTER = 2;
/** Minutes before the next try, by attempt. The last repeats. */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360];

export type SyncResult = "synced" | "skipped" | "waiting" | "failed";

const globalRef = globalThis as unknown as { __bellineGoogleSync?: Map<string, Promise<SyncResult>> };
const running = () => (globalRef.__bellineGoogleSync ??= new Map());

/** Merge calendar fields onto the booking as it is now, never onto a stale copy. */
function patch(bookingId: string, fields: Partial<Pick<Booking, "calendarEventId" | "calendarId">>, sync: Partial<CalendarSync>): Booking | undefined {
  const fresh = getBooking(bookingId);
  if (!fresh) return undefined;
  const base: CalendarSync = fresh.calendarSync ?? { state: "pending", attempts: 0 };
  return saveBooking({ ...fresh, ...fields, calendarSync: { ...base, ...sync } });
}

/**
 * Mark a booking as changed and start writing it to Google.
 *
 * Returns the booking as saved. Does nothing at a venue with no connection.
 * Not awaited by the engine: a slow Google must never hold a caller or a
 * receptionist, and the mark on the booking is what makes that safe.
 */
export function queueGoogleSync(location: Location, booking: Booking): Booking {
  if (!location.google) return booking;
  const prev = booking.calendarSync;
  const marked = saveBooking({
    ...booking,
    calendarSync: { ...(prev ?? { attempts: 0 }), state: "pending", rev: (prev?.rev ?? 0) + 1, nextAttemptAt: undefined },
  });
  void syncBooking(marked.id);
  return marked;
}

/** A booking the Google provider has just written itself. */
export function syncedByProvider(now = new Date()): CalendarSync {
  return { state: "synced", attempts: 0, rev: 0, syncedAt: now.toISOString() };
}

/**
 * Bring one booking's event in line with the booking. One run per booking at a
 * time: a second request waits for the first, then runs against the booking as
 * it is by then. Never throws.
 */
export function syncBooking(bookingId: string): Promise<SyncResult> {
  const map = running();
  const before = map.get(bookingId) ?? Promise.resolve<SyncResult>("skipped");
  const next = before.catch(() => "failed" as const).then(() => run(bookingId));
  map.set(bookingId, next);
  void next.finally(() => {
    if (map.get(bookingId) === next) map.delete(bookingId);
  });
  return next;
}

/** Wait for writes in flight: one booking's, or all of them. */
export async function settleGoogleSync(bookingId?: string): Promise<void> {
  for (;;) {
    const map = running();
    const pending = bookingId ? [map.get(bookingId)].filter(Boolean) : [...map.values()];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

async function run(bookingId: string, now = new Date()): Promise<SyncResult> {
  const booking = getBooking(bookingId);
  const sync = booking?.calendarSync;
  if (!booking || !sync) return "skipped";
  const location = getLocation(booking.locationId);

  // Disconnected since: there is no calendar to keep in step any more.
  if (!location?.google) {
    const { calendarSync: _dropped, ...rest } = booking;
    saveBooking(rest);
    return "skipped";
  }
  // Expired or switched off: kept pending, and written once it is reconnected.
  // The owner already has the banner and the team the exception for that.
  if (!googleUsable(location)) {
    patch(bookingId, {}, { state: "pending", lastError: "Waiting for Google Calendar to be connected again." });
    return "waiting";
  }

  const link = location.google;
  const eventId = booking.calendarEventId ?? bookingEventId(booking);
  // Where the event belongs now: the person's own calendar, or the venue's.
  // Not where it was last written — a booking moved to somebody with their
  // own calendar has to leave the first one.
  const target = calendarFor(link, booking.staffId);
  const rev = sync.rev;

  // Everything that may exist in Google for this booking and must not: events
  // already known to be left behind, the calendar it was last written to when
  // that is not the target, and a write that started and was never confirmed.
  const remove: CalendarEventRef[] = [];
  const add = (ref: CalendarEventRef | undefined) => {
    if (!ref) return;
    if (booking.status === "confirmed" && ref.calendarId === target && ref.eventId === eventId) return;
    if (!remove.some((r) => r.calendarId === ref.calendarId && r.eventId === ref.eventId)) remove.push(ref);
  };
  for (const ref of sync.stale ?? []) add(ref);
  add(sync.inflight);
  if (booking.calendarId) add({ calendarId: booking.calendarId, eventId });
  if (booking.status === "cancelled") add({ calendarId: target, eventId });
  // Recorded before Google is asked, so a crash between the new write and the
  // clean-up still knows what to clean up.
  patch(bookingId, {}, { lastTriedAt: now.toISOString(), stale: remove.length ? remove : undefined });

  try {
    if (booking.status === "confirmed") {
      // New before old: the time is never free in Google while it moves.
      patch(bookingId, {}, { inflight: { calendarId: target, eventId } });
      await withAccess(location, (token, api) => api.putEvent(token, target, eventFor(location, booking, eventId)));
      patch(bookingId, { calendarEventId: eventId, calendarId: target }, { inflight: undefined });
    }
    // Arrived, left or not shown: the time was the guest's either way, so the event stays.

    const left = [...remove];
    for (const ref of remove) {
      await withAccess(location, (token, api) => api.cancelEvent(token, ref.calendarId, ref.eventId));
      left.splice(left.indexOf(ref), 1);
      patch(bookingId, {}, { stale: left.length ? [...left] : undefined });
    }

    const fresh = getBooking(bookingId);
    const newer = fresh?.calendarSync?.rev !== rev;
    patch(bookingId, {}, {
      // A change that arrived while this ran is written by the run queued behind it.
      state: newer ? "pending" : "synced",
      inflight: undefined,
      attempts: 0,
      lastError: undefined,
      nextAttemptAt: undefined,
      syncedAt: now.toISOString(),
    });
    const stillFailing = listBookings({ locationId: location.id }).some((b) => b.calendarSync?.state === "failed");
    noteWriteSuccess(location.id, stillFailing, now);
    return "synced";
  } catch (err) {
    if (err instanceof GoogleAuthError || err instanceof GoogleConfigError) {
      // withAccess has marked the link expired or misconfigured: the venue is
      // on requests, the owner is told, the team has the exception. Written
      // once the connection works again.
      patch(bookingId, {}, { state: "pending", lastError: "Waiting for Google Calendar to be connected again." });
      return "waiting";
    }
    const attempts = (getBooking(bookingId)?.calendarSync?.attempts ?? 0) + 1;
    const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1];
    patch(bookingId, {}, {
      state: "failed",
      attempts,
      lastError: "Google Calendar did not accept this change. Belline tries again on its own.",
      nextAttemptAt: new Date(now.getTime() + wait * 60_000).toISOString(),
    });
    const detail = err instanceof Error ? err.message : String(err);
    noteWriteFailure(location.id, err);
    console.error(`[google] booking ${booking.ref} at ${location.name} not written to Google (attempt ${attempts}): ${detail}`);
    if (attempts >= SYNC_EXCEPTION_AFTER) {
      openException({
        tenantId: location.tenantId,
        locationId: location.id,
        kind: "google_sync_failed",
        reason: `Booking ${booking.ref} has failed to reach Google Calendar ${attempts} times in a row. Latest: ${detail}`,
        context: { bookingId },
        source: "system",
      });
    }
    return "failed";
  }
}

/**
 * The owner changed which calendar someone uses: their upcoming bookings'
 * events move with them, off the old calendar and onto the new one.
 */
export function resyncMovedCalendars(location: Location): number {
  const link = location.google;
  if (!link) return 0;
  const today = todayIn(location.timezone);
  let queued = 0;
  for (const booking of listBookings({ locationId: location.id, status: "confirmed" })) {
    if (booking.date < today || !booking.calendarId) continue;
    if (booking.calendarId === calendarFor(link, booking.staffId)) continue;
    queueGoogleSync(location, booking);
    queued++;
  }
  return queued;
}

/**
 * The sweep: every booking still waiting on Google whose back-off has passed.
 * Run from the server every few minutes. Returns what it did.
 */
export async function retryGoogleSyncs(now = new Date()): Promise<{ attempted: number; synced: number; failed: number; waiting: number }> {
  const due = listBookings().filter((b) => {
    const s = b.calendarSync;
    if (!s || s.state === "synced") return false;
    return !s.nextAttemptAt || Date.parse(s.nextAttemptAt) <= now.getTime();
  });
  const out = { attempted: 0, synced: 0, failed: 0, waiting: 0 };
  for (const booking of due) {
    await settleGoogleSync(booking.id);
    const result = await runQueued(booking.id, now);
    if (result === "skipped") continue;
    out.attempted++;
    if (result === "synced") out.synced++;
    else if (result === "failed") out.failed++;
    else out.waiting++;
  }
  return out;
}

/**
 * Everything the server does for Google every few minutes: connections that
 * never came back, venues Google was refusing that it may accept again, and
 * bookings still waiting to be written — in that order, so a venue cleared by
 * the recheck has its waiting bookings written in the same sweep.
 */
export async function sweepGoogle(now = new Date()) {
  const abandoned = sweepAbandonedConnects(now);
  const recovered = await recheckMisconfigured();
  const bookings = await retryGoogleSyncs(now);
  return { abandoned, recovered, ...bookings };
}

/** As `syncBooking`, with the sweep's clock. */
function runQueued(bookingId: string, now: Date): Promise<SyncResult> {
  const map = running();
  const next = run(bookingId, now);
  map.set(bookingId, next);
  void next.finally(() => {
    if (map.get(bookingId) === next) map.delete(bookingId);
  });
  return next;
}
