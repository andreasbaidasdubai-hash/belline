import type { Booking, CalendarEventRef, CalendarSync, Location } from "../types";
import { getBooking, getLocation, listBookings, saveBooking } from "../store";
import { destinationOf } from "../booking/destination";
import { openException } from "../exceptions";
import { todayIn } from "../time";
import type { CalendarConnector } from "./calendar-connector";
import { googleConnector } from "./google";
import { outlookConnector } from "./outlook";

/**
 * Every booking at a venue with a connected calendar, in the calendar.
 *
 * Written for Google Calendar (the history is in google-sync.ts) and shared
 * with Outlook: the calendar service is a `CalendarConnector`, everything else
 * is the same.
 *
 * The calendar provider writes the agent's own bookings as it makes them.
 * Every other way a booking is made, moved or cancelled — the desk, the
 * calendar drag, a guest's manage link, a guest renamed — comes through the
 * booking engine, which marks the change on the booking (`calendarSync`)
 * before the calendar is asked, and the booking is then driven to where it
 * should be: an event, by the booking's key, on the calendar for that person,
 * or no event once it is cancelled. Every write is a create-or-replace or a
 * delete by key, so doing it twice changes nothing.
 *
 * The booking is never lost to a calendar that will not answer. It is already
 * saved when this runs; a failure is recorded on it, the owner is told on the
 * connection, the sweep retries with a back-off, and a second failure in a row
 * opens the service's `*_sync_failed` exception for the team.
 */

/** A second failure in a row is the team's to look at; the first may be a blip. */
export const SYNC_EXCEPTION_AFTER = 2;
/** Minutes before the next try, by attempt. The last repeats. */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360];

export type SyncResult = "synced" | "skipped" | "waiting" | "failed";

const globalRef = globalThis as unknown as { __bellineGoogleSync?: Map<string, Promise<SyncResult>> };
const running = () => (globalRef.__bellineGoogleSync ??= new Map());

/**
 * The calendar this venue's bookings are written to. One per venue: the routes
 * refuse a second. Were both ever present, the one the venue books into wins.
 */
export function connectorFor(location: Location): CalendarConnector | null {
  if (location.outlook && (destinationOf(location) === "outlook" || !location.google)) return outlookConnector;
  if (location.google) return googleConnector;
  return null;
}

/** Which service a booking's calendar fields belong to. Absent is Google, which came first. */
const serviceOf = (sync: CalendarSync) => sync.provider ?? "google";

/** Merge calendar fields onto the booking as it is now, never onto a stale copy. */
function patch(
  bookingId: string,
  fields: Partial<Pick<Booking, "calendarEventId" | "calendarId" | "calendarEventKey">>,
  sync: Partial<CalendarSync>,
): Booking | undefined {
  const fresh = getBooking(bookingId);
  if (!fresh) return undefined;
  const base: CalendarSync = fresh.calendarSync ?? { state: "pending", attempts: 0 };
  return saveBooking({ ...fresh, ...fields, calendarSync: { ...base, ...sync } });
}

/**
 * Mark a booking as changed and start writing it to the venue's calendar.
 *
 * Returns the booking as saved. Does nothing at a venue with no connection.
 * Not awaited by the engine: a slow calendar must never hold a caller or a
 * receptionist, and the mark on the booking is what makes that safe.
 */
export function queueCalendarSync(location: Location, booking: Booking): Booking {
  if (!connectorFor(location)) return booking;
  const prev = booking.calendarSync;
  const marked = saveBooking({
    ...booking,
    calendarSync: { ...(prev ?? { attempts: 0 }), state: "pending", rev: (prev?.rev ?? 0) + 1, nextAttemptAt: undefined },
  });
  void syncBooking(marked.id);
  return marked;
}

/** A booking a calendar provider has just written itself. */
export function syncedByProvider(now = new Date(), service: CalendarConnector["kind"] = "google"): CalendarSync {
  return { state: "synced", attempts: 0, rev: 0, syncedAt: now.toISOString(), ...(service === "google" ? {} : { provider: service }) };
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
export async function settleCalendarSync(bookingId?: string): Promise<void> {
  for (;;) {
    const map = running();
    const pending = bookingId ? [map.get(bookingId)].filter(Boolean) : [...map.values()];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

async function run(bookingId: string, now = new Date()): Promise<SyncResult> {
  let booking = getBooking(bookingId);
  let sync = booking?.calendarSync;
  if (!booking || !sync) return "skipped";
  const location = getLocation(booking.locationId);
  const c = location ? connectorFor(location) : null;

  // Disconnected since: there is no calendar to keep in step any more.
  if (!location || !c) {
    const { calendarSync: _dropped, ...rest } = booking;
    saveBooking(rest);
    return "skipped";
  }
  // The booking's event was written to the other service, which has since been
  // disconnected: that event stays in that calendar, which is the venue's, and
  // this one starts clean. Nothing of the old service is asked of the new.
  if (serviceOf(sync) !== c.kind) {
    booking = saveBooking({
      ...booking,
      calendarEventId: undefined,
      calendarId: undefined,
      calendarEventKey: undefined,
      calendarSync: { ...sync, stale: undefined, inflight: undefined, provider: c.kind === "google" ? undefined : c.kind },
    });
    sync = booking.calendarSync!;
  }

  const waitingText = `Waiting for ${c.name} to be connected again.`;
  // Expired or switched off: kept pending, and written once it is reconnected.
  // The owner already has the banner and the team the exception for that.
  if (!c.usable(location)) {
    // Written once, not on every sweep: a venue that never reconnects must not
    // rewrite its book every few minutes.
    if (sync.state !== "pending" || sync.lastError !== waitingText) patch(bookingId, {}, { state: "pending", lastError: waitingText });
    return "waiting";
  }

  const key = c.keyOf(booking);
  // Where the event belongs now: the person's own calendar, or the venue's.
  // Not where it was last written — a booking moved to somebody with their
  // own calendar has to leave the first one.
  const target = c.calendarFor(location, booking.staffId);
  const rev = sync.rev;

  // Everything that may exist in the calendar for this booking and must not:
  // events already known to be left behind, the calendar it was last written to
  // when that is not the target, and a write that started and was never confirmed.
  const remove: CalendarEventRef[] = [];
  const add = (ref: CalendarEventRef | undefined) => {
    if (!ref) return;
    if (booking!.status === "confirmed" && ref.calendarId === target && ref.eventId === key) return;
    if (!remove.some((r) => r.calendarId === ref.calendarId && r.eventId === ref.eventId)) remove.push(ref);
  };
  for (const ref of sync.stale ?? []) add(ref);
  add(sync.inflight);
  if (booking.calendarId) add({ calendarId: booking.calendarId, eventId: key });
  if (booking.status === "cancelled") add({ calendarId: target, eventId: key });
  // Recorded before the calendar is asked, so a crash between the new write and
  // the clean-up still knows what to clean up.
  patch(bookingId, {}, { lastTriedAt: now.toISOString(), stale: remove.length ? remove : undefined });

  try {
    if (booking.status === "confirmed") {
      // New before old: the time is never free in the calendar while it moves.
      patch(bookingId, {}, { inflight: { calendarId: target, eventId: key } });
      const eventId = await c.put(location, booking, target, key);
      patch(bookingId, { ...c.refFields(key, eventId), calendarId: target }, { inflight: undefined });
    }
    // Arrived, left or not shown: the time was the guest's either way, so the event stays.

    const left = [...remove];
    for (const ref of remove) {
      await c.remove(location, booking, ref);
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
    c.noteWriteSuccess(location.id, stillFailing, now);
    return "synced";
  } catch (err) {
    if (c.waiting(err)) {
      // The connector has marked the link expired or misconfigured: the venue
      // is on requests, the owner is told, the team has the exception. Written
      // once the connection works again.
      patch(bookingId, {}, { state: "pending", lastError: waitingText });
      return "waiting";
    }
    const attempts = (getBooking(bookingId)?.calendarSync?.attempts ?? 0) + 1;
    const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1];
    patch(bookingId, {}, {
      state: "failed",
      attempts,
      lastError: `${c.name} did not accept this change. Belline tries again on its own.`,
      nextAttemptAt: new Date(now.getTime() + wait * 60_000).toISOString(),
    });
    const detail = err instanceof Error ? err.message : String(err);
    c.noteWriteFailure(location.id, err);
    console.error(`[${c.tag}] booking ${booking.ref} at ${location.name} not written to ${c.name} (attempt ${attempts}): ${detail}`);
    if (attempts >= SYNC_EXCEPTION_AFTER) {
      openException({
        tenantId: location.tenantId,
        locationId: location.id,
        kind: c.failedException,
        reason: `Booking ${booking.ref} has failed to reach ${c.name} ${attempts} times in a row. Latest: ${detail}`,
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
  const c = connectorFor(location);
  if (!c) return 0;
  const today = todayIn(location.timezone);
  let queued = 0;
  for (const booking of listBookings({ locationId: location.id, status: "confirmed" })) {
    if (booking.date < today || !booking.calendarId) continue;
    if (booking.calendarId === c.calendarFor(location, booking.staffId)) continue;
    queueCalendarSync(location, booking);
    queued++;
  }
  return queued;
}

/** A venue that has just connected, on Belline's own diary: what is already booked is copied out. */
export async function copyUpcoming(location: Location, limit = 50): Promise<number> {
  if (destinationOf(location) !== "belline") return 0;
  const today = todayIn(location.timezone);
  const upcoming = listBookings({ locationId: location.id, status: "confirmed" })
    .filter((b) => b.date >= today)
    .slice(0, limit);
  for (const booking of upcoming) queueCalendarSync(location, booking);
  await settleCalendarSync();
  return upcoming.length;
}

/**
 * Every booking still waiting on its calendar whose back-off has passed.
 * Run from the server's sweep. Returns what it did.
 */
export async function retryCalendarSyncs(now = new Date()): Promise<{ attempted: number; synced: number; failed: number; waiting: number }> {
  const due = listBookings().filter((b) => {
    const s = b.calendarSync;
    if (!s || s.state === "synced") return false;
    return !s.nextAttemptAt || Date.parse(s.nextAttemptAt) <= now.getTime();
  });
  const out = { attempted: 0, synced: 0, failed: 0, waiting: 0 };
  for (const booking of due) {
    await settleCalendarSync(booking.id);
    const result = await runQueued(booking.id, now);
    if (result === "skipped") continue;
    // Waiting on a reconnect is not an attempt: nothing was asked of the calendar.
    if (result === "waiting") {
      out.waiting++;
      continue;
    }
    out.attempted++;
    if (result === "synced") out.synced++;
    else out.failed++;
  }
  return out;
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
