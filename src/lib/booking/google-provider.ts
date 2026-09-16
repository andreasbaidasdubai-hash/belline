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
import { googleUsable } from "./destination";
import { busyFor, calendarFor, eventFor, eventIdFor, isBusy, withAccess, type Busy } from "../integrations/google";
import { settleGoogleSync, syncedByProvider } from "../integrations/google-sync";
import type { BookingProvider } from "./provider";

/**
 * A business whose book is a Google Calendar.
 *
 * Availability is Belline's rules first — hours, services, staff, notice,
 * tables — and then whatever the calendar says is busy is taken out. The
 * calendar can only remove times, never add one the rules would refuse.
 *
 * A booking is made in Belline's record and then created in the calendar with
 * an event id derived from the idempotency key, so the same booking arriving
 * twice is one event. If the calendar will not take it, the Belline record is
 * cancelled and the agent is told it could not confirm: a booking that exists
 * only on Belline's side is exactly the double-booking this adapter is for.
 *
 * A calendar Belline cannot read offers no times at all. When the token has
 * expired, `withAccess` marks the link and the next call finds the venue on
 * requests (see destination.ts).
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

/** Busy times, or null when the calendar cannot be read. Never throws. */
async function busyOrNull(location: Location, date: string): Promise<Busy | null> {
  try {
    return await busyFor(location, date);
  } catch (err) {
    console.warn(`[google] could not read busy times for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export const googleCalendarProvider: BookingProvider = {
  name: "google",

  capabilities: {
    availability: true,
    confirms: true,
    reschedule: true,
    cancel: true,
    staffSelection: true,
    // The waitlist is Belline's own diary's; a slot freed in Google is not seen.
    waitlist: false,
  },

  async getServices({ location }) {
    return location.salon?.services ?? [];
  },

  async getStaff({ location }) {
    return location.salon?.staff ?? [];
  },

  async checkAvailability({ location, callId }, query) {
    if (!googleUsable(location)) return [];
    // Every time the rules allow, then the busy ones out, then the usual six:
    // filtering the engine's first six would offer nothing on a busy morning
    // with a free afternoon.
    const slots = localSearch(location, query, { callId, limit: SEARCH_DEPTH });
    if (slots.length === 0) return slots;
    const busy = await busyOrNull(location, query.date);
    // Never a time that could not be checked.
    if (!busy) return [];
    const free = slots.filter((slot) => !isBusy(location, busy, slot)).slice(0, OFFERED);
    if (callId) {
      for (const slot of free.slice(0, MAX_QUOTED_HOLDS)) holdForSlot(location, slot, { callId });
    }
    return free;
  },

  async createBooking({ location }, input: CreateInput, idempotencyKey) {
    if (!googleUsable(location)) return refused(CALENDAR_DOWN);

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
    const eventId = eventIdFor(location.id, key);
    const already = listBookings({ locationId: location.id, status: "confirmed" }).find((b) => b.calendarEventId === eventId);
    if (already) return { ok: true, booking: already, duplicate: true };

    const busy = await busyOrNull(location, input.date);
    if (!busy) return refused(CALENDAR_DOWN);
    if (isBusy(location, busy, { date: input.date, startMin: input.startMin, endMin: input.startMin + 1, staffId: input.staffId })) {
      return refused(TAKEN, "unavailable");
    }

    const made = localCreate(location, { ...input, calendarWrittenBy: "provider" });
    if (!made.ok) return made;
    // Already in the calendar: written by this provider, or by the sync when it
    // was made at the desk or from a link. A second event would be a duplicate.
    if (made.duplicate && (made.booking.calendarEventId || made.booking.calendarSync)) return made;
    const booking = made.booking;

    // The engine may have picked the person; their own calendar counts too.
    if (isBusy(location, busy, booking)) {
      localCancel(booking, location, "Busy in Google Calendar");
      return refused(TAKEN, "unavailable");
    }

    const calendarId = calendarFor(location.google!, booking.staffId);
    try {
      await withAccess(location, (token, api) => api.insertEvent(token, calendarId, eventFor(location, booking, eventId)));
    } catch (err) {
      // The insert may have landed with only the answer lost. The id is kept
      // on the booking, so the cancellation removes that event if it exists.
      localCancel(saveBooking({ ...booking, calendarEventId: eventId, calendarId }), location, "Google Calendar did not accept it");
      console.warn(`[google] event not created for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
      return refused(CALENDAR_DOWN);
    }
    const saved = saveBooking({ ...booking, calendarEventId: eventId, calendarId, calendarSync: syncedByProvider() });
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
    if (!googleUsable(location)) return refused(CALENDAR_DOWN);
    const date = changes.date ?? booking.date;
    const startMin = changes.startMin ?? booking.startMin;
    const busy = await busyOrNull(location, date);
    if (!busy) return refused(CALENDAR_DOWN);
    // Belline's own event for this booking is not counted as busy (it is tagged).
    const moved = { date, startMin, endMin: startMin + (booking.endMin - booking.startMin), staffId: changes.staffId ?? booking.staffId };
    if (isBusy(location, busy, moved)) return refused(TAKEN, "unavailable");
    // The engine saves the move and the sync moves the event, by the id stored
    // on the booking. Waited for here, so the caller is answered with the
    // calendar already changed; a failure stays on the booking and is retried.
    const out = localModify(location, booking, changes);
    if (!out.ok) return out;
    await settleGoogleSync(out.booking.id);
    return { ...out, booking: getBooking(out.booking.id) ?? out.booking };
  },

  async cancelBooking({ location }, booking, reason) {
    if (booking.calendarEventId && location.google) {
      try {
        await withAccess(location, (token, api) =>
          api.cancelEvent(token, booking.calendarId ?? location.google!.calendarId, booking.calendarEventId!),
        );
      } catch {
        return { ok: false, detail: "I can't reach the business's calendar just now. Let me take a message and the team will cancel it." };
      }
    }
    return { ok: true, booking: localCancel(booking, location, reason) };
  },
};
