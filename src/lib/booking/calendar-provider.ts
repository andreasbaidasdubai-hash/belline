import type { Location } from "../types";
import {
  cancelBooking as localCancel,
  createBooking as localCreate,
  findAvailability as localSearch,
  modifyBooking as localModify,
  type BookingResult,
  type CreateInput,
} from "./index";
import { findBookingByRef, findBookingsByPhone, getBooking, listBookings, saveBooking } from "../store";
import { holdForSlot, MAX_QUOTED_HOLDS } from "./holds";
import { bookingKey, describeWhat } from "./idempotency";
import { eventIdFor, type Busy, type CalendarConnector } from "../integrations/calendar-connector";
import { settleCalendarSync, syncedByProvider } from "../integrations/calendar-sync";
import type { BookingProvider } from "./provider";

/**
 * A business whose book is a calendar: Google Calendar or Outlook.
 *
 * Availability is Belline's rules first — hours, services, staff, notice,
 * tables — and then whatever the calendar says is busy is taken out. The
 * calendar can only remove times, never add one the rules would refuse.
 *
 * A booking is made in Belline's record and then created in the calendar with
 * an event key derived from the idempotency key, so the same booking arriving
 * twice is one event. If the calendar will not take it, the Belline record is
 * cancelled and the agent is told it could not confirm: a booking that exists
 * only on Belline's side is exactly the double-booking this adapter is for.
 *
 * A calendar Belline cannot read offers no times at all. When the token has
 * expired, the connector marks the link and the next call finds the venue on
 * requests (see destination.ts).
 *
 * Written for Google (google-provider.ts) and shared: `connector` is read
 * lazily because the connectors and the booking engine import each other.
 */

const CALENDAR_DOWN =
  "The business's calendar cannot be checked just now, so no time can be confirmed. Take their name, number and the time they want as a message, and say the team will confirm.";
const TAKEN = "That time is already taken in the business's calendar. Check availability again and offer another time.";
/** As many as the engine offers everywhere else. */
const OFFERED = 6;
/** How far the engine looks before busy times are taken out. */
const SEARCH_DEPTH = 200;

function refused(detail: string, reason = "calendar_unavailable"): BookingResult {
  return { ok: false, reason, detail, alternatives: [] };
}

export function calendarProvider(connector: () => CalendarConnector): BookingProvider {
  /** Busy times, or null when the calendar cannot be read. Never throws. */
  async function busyOrNull(location: Location, date: string): Promise<Busy | null> {
    const c = connector();
    try {
      return await c.busyFor(location, date);
    } catch (err) {
      console.warn(`[${c.tag}] could not read busy times for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  return {
    get name() {
      return connector().kind;
    },

    capabilities: {
      availability: true,
      confirms: true,
      reschedule: true,
      cancel: true,
      staffSelection: true,
      // The waitlist is Belline's own diary's; a slot freed in the calendar is not seen.
      waitlist: false,
    },

    async getServices({ location }) {
      return location.salon?.services ?? [];
    },

    async getStaff({ location }) {
      return location.salon?.staff ?? [];
    },

    async checkAvailability({ location, callId }, query) {
      const c = connector();
      if (!c.usable(location)) return [];
      // Every time the rules allow, then the busy ones out, then the usual six:
      // filtering the engine's first six would offer nothing on a busy morning
      // with a free afternoon.
      const slots = localSearch(location, query, { callId, limit: SEARCH_DEPTH });
      if (slots.length === 0) return slots;
      const busy = await busyOrNull(location, query.date);
      // Never a time that could not be checked.
      if (!busy) return [];
      const free = slots.filter((slot) => !c.isBusy(location, busy, slot)).slice(0, OFFERED);
      if (callId) {
        for (const slot of free.slice(0, MAX_QUOTED_HOLDS)) holdForSlot(location, slot, { callId });
      }
      return free;
    },

    async createBooking({ location }, input: CreateInput, idempotencyKey) {
      const c = connector();
      if (!c.usable(location)) return refused(CALENDAR_DOWN);

      // No key from the caller: the booking's own fingerprint, as the local
      // engine uses, so the same booking by two routes is still one event.
      const key =
        idempotencyKey ??
        bookingKey({
          locationId: location.id,
          date: input.date,
          startMin: input.startMin,
          guestPhone: input.guestPhone,
          guestName: input.guestName,
          what: describeWhat(input),
        });
      const eventKey = eventIdFor(location.id, key);
      const already = listBookings({ locationId: location.id, status: "confirmed" }).find(
        (b) => (b.calendarEventKey ?? b.calendarEventId) === eventKey,
      );
      if (already) return { ok: true, booking: already, duplicate: true };

      const busy = await busyOrNull(location, input.date);
      if (!busy) return refused(CALENDAR_DOWN);
      if (c.isBusy(location, busy, { date: input.date, startMin: input.startMin, endMin: input.startMin + 1, staffId: input.staffId })) {
        return refused(TAKEN, "unavailable");
      }

      const made = localCreate(location, { ...input, calendarWrittenBy: "provider" });
      if (!made.ok) return made;
      // Already in the calendar: written by this provider, or by the sync when it
      // was made at the desk or from a link. A second event would be a duplicate.
      if (made.duplicate && (made.booking.calendarEventId || made.booking.calendarSync)) return made;
      const booking = made.booking;

      // The engine may have picked the person; their own calendar counts too.
      if (c.isBusy(location, busy, booking)) {
        localCancel(booking, location, `Busy in ${c.name}`);
        return refused(TAKEN, "unavailable");
      }

      const calendarId = c.calendarFor(location, booking.staffId);
      let eventId: string;
      try {
        eventId = await c.insert(location, booking, calendarId, eventKey);
      } catch (err) {
        // The insert may have landed with only the answer lost. The key is kept
        // on the booking, so the cancellation removes that event if it exists.
        localCancel(saveBooking({ ...booking, ...c.refFields(eventKey), calendarId }), location, `${c.name} did not accept it`);
        console.warn(`[${c.tag}] event not created for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
        return refused(CALENDAR_DOWN);
      }
      const saved = saveBooking({ ...booking, ...c.refFields(eventKey, eventId), calendarId, calendarSync: syncedByProvider(new Date(), c.kind) });
      return made.duplicate ? { ok: true, booking: saved, duplicate: true } : { ok: true, booking: saved };
    },

    async getBookingByRef({ location }, ref) {
      return findBookingByRef(location.id, ref) ?? null;
    },

    async getBookingById({ location }, id) {
      const booking = getBooking(id);
      return booking && booking.locationId === location.id ? booking : null;
    },

    async findBookingsByPhone({ location }, phone) {
      return findBookingsByPhone(location.id, phone);
    },

    async rescheduleBooking({ location }, booking, changes) {
      const c = connector();
      if (!c.usable(location)) return refused(CALENDAR_DOWN);
      const date = changes.date ?? booking.date;
      const startMin = changes.startMin ?? booking.startMin;
      const busy = await busyOrNull(location, date);
      if (!busy) return refused(CALENDAR_DOWN);
      // Belline's own event for this booking is not counted as busy (it is tagged).
      const moved = { date, startMin, endMin: startMin + (booking.endMin - booking.startMin), staffId: changes.staffId ?? booking.staffId };
      if (c.isBusy(location, busy, moved)) return refused(TAKEN, "unavailable");
      // The engine saves the move and the sync moves the event, by the key stored
      // on the booking. Waited for here, so the caller is answered with the
      // calendar already changed; a failure stays on the booking and is retried.
      const out = localModify(location, booking, changes);
      if (!out.ok) return out;
      await settleCalendarSync(out.booking.id);
      return { ...out, booking: getBooking(out.booking.id) ?? out.booking };
    },

    async cancelBooking({ location }, booking, reason) {
      const c = connector();
      const key = booking.calendarEventKey ?? booking.calendarEventId;
      if (key && c.linked(location)) {
        try {
          await c.remove(location, booking, { calendarId: booking.calendarId ?? c.calendarFor(location), eventId: key });
        } catch {
          return { ok: false, detail: "I can't reach the business's calendar just now. Let me take a message and the team will cancel it." };
        }
      }
      return { ok: true, booking: localCancel(booking, location, reason) };
    },
  };
}
