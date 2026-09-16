import crypto from "node:crypto";
import type { Booking, CalendarEventRef, ExceptionKind, Location } from "../types";

/**
 * What the shared calendar machinery needs from one calendar service.
 *
 * Google Calendar was built first, with its provider and its sync written
 * against Google directly. Outlook needs exactly the same behaviour — busy
 * times taken out of Belline's own availability, the same booking twice being
 * one event, every change driven to the calendar with retries and exceptions —
 * so that behaviour lives once, in booking/calendar-provider.ts and
 * integrations/calendar-sync.ts, and each service supplies this.
 *
 * One idea carries across both: every event Belline writes has a **key**, a
 * string that depends only on the booking (or the caller's idempotency key).
 * Google lets the caller choose the event id, so for Google the key *is* the
 * id. Microsoft Graph assigns ids itself, so for Outlook the key is written on
 * the event as a private extended property and looked up before any create,
 * and Graph's id is stored beside it. The sync's bookkeeping (`stale`,
 * `inflight`) records keys, which are known before the calendar answers.
 */

/** Busy intervals, epoch ms, per calendar id. */
export type Busy = Map<string, [number, number][]>;

export interface BusySlot {
  date: string;
  startMin: number;
  endMin: number;
  staffId?: string;
}

export interface CalendarConnector {
  readonly kind: "google" | "outlook";
  /** "Google Calendar", "Outlook": for the owner's and the team's sentences. */
  readonly name: string;
  /** The log prefix, without brackets. */
  readonly tag: string;
  /** The team's exception when a booking keeps failing to reach the calendar. */
  readonly failedException: ExceptionKind;

  /** A link exists on the venue, usable or not. */
  linked(location: Location): boolean;
  /** Flag on, token sealed, not expired, not refused by the service. */
  usable(location: Location): boolean;
  /** The calendar a booking for this person goes into. */
  calendarFor(location: Location, staffId?: string): string;
  /** The key of this booking's event. */
  keyOf(booking: Booking): string;
  /** The booking fields that record an event: its key and, where the service assigns one, its id. */
  refFields(key: string, id?: string): Partial<Pick<Booking, "calendarEventId" | "calendarEventKey">>;

  /** Create or replace the booking's event on this calendar. Returns the event id to store. */
  put(location: Location, booking: Booking, calendarId: string, key: string): Promise<string>;
  /** Create the event unless one with this key exists. Returns its id. */
  insert(location: Location, booking: Booking, calendarId: string, key: string): Promise<string>;
  /** Remove the event with this key from this calendar. Already gone counts as removed. */
  remove(location: Location, booking: Booking, ref: CalendarEventRef): Promise<void>;

  busyFor(location: Location, date: string): Promise<Busy>;
  isBusy(location: Location, busy: Busy, slot: BusySlot): boolean;

  /** The service refused because the connection needs a person (expired, misconfigured): wait, do not count a failure. */
  waiting(err: unknown): boolean;
  noteWriteFailure(locationId: string, raw: unknown): void;
  noteWriteSuccess(locationId: string, stillFailing: boolean, now?: Date): void;
}

/**
 * A calendar event key from an idempotency key.
 *
 * Valid as a Google event id (base32hex, 5–1024 characters), which Google lets
 * the caller choose: the same key arriving twice — a retried webhook, a caller
 * who said yes twice — can only ever make one event. Outlook stores it on the
 * event and finds it again before creating.
 */
export function eventIdFor(locationId: string, key: string): string {
  return `bl${crypto.createHash("sha256").update(`${locationId}|${key}`).digest("hex").slice(0, 40)}`;
}

/**
 * The key for a booking that did not come through a calendar provider: made at
 * the desk, from a guest's link, or before keys were stored. It depends only on
 * the booking's own id, so every write for one booking lands on one event, and
 * it is the id Google's one-way mirror has always used.
 */
export function bookingEventId(booking: Booking): string {
  return `belline${booking.id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 60);
}

/** Does anything on these calendars overlap [from, to)? */
export function overlapsBusy(busy: Busy, calendarIds: Iterable<string>, from: number, to: number): boolean {
  for (const calendarId of calendarIds) {
    for (const [start, end] of busy.get(calendarId) ?? []) {
      if (start < to && end > from) return true;
    }
  }
  return false;
}
