import type { Booking, Location, Slot } from "../types";
import {
  cancelBooking as localCancel,
  createBooking as localCreate,
  modifyBooking as localModify,
  type BookingResult,
  type CreateInput,
} from "./index";
import { findBookingByRef, findBookingsByPhone, getBooking, listBookings, saveBooking } from "../store";
import { holdForSlot, MAX_QUOTED_HOLDS } from "./holds";
import { bookingKey, describeWhat } from "./idempotency";
import { calendlyUsable } from "./destination";
import type { BookingProvider } from "./provider";
import { zonedInstant } from "../integrations/google-api";
import { dateIn, weekdayOf } from "../time";
import { openException } from "../exceptions";
import {
  CALENDLY_RATE_TEXT,
  CalendlyPlanError,
  CalendlyRateLimitError,
  CalendlyTimeTakenError,
  bookCalendlyInvitee,
  calendlyOpenTimes,
  calendlyStaffSelection,
  cancelCalendlyEvent,
  eventTypeForServices,
  markCalendlyCancelPending,
  markCalendlyPlanBlocked,
  noteCalendlyWriteFailure,
  noteCalendlyWriteSuccess,
} from "../integrations/calendly";

/**
 * A business whose book is a Calendly.
 *
 * Google's and Outlook's adapters share one provider (calendar-provider.ts)
 * because they are the same idea: Belline's rules generate every time the venue
 * could take, the calendar's busy times remove some, and a booking is an event
 * written at whatever minute is left. Calendly is not that idea, and forcing it
 * into the same shape would mean lying somewhere.
 *
 * **Calendly decides the times.** `GET /event_type_available_times` is the
 * owner's real availability: their linked calendars, their buffers, their
 * minimum notice, their daily caps, their working hours. Belline does not
 * reconstruct that and then hope the two agree — it asks, and offers what
 * Calendly says. Belline's own rules can still take a time away (a venue that
 * is closed on a Sunday does not offer Sunday however open Calendly is), and
 * never add one.
 *
 * **Calendly decides the length.** The event type's duration is the
 * appointment. Belline's service length is used to *choose* the event type and
 * to say the right thing on the phone; it never overrides Calendly.
 *
 * What that costs, honestly:
 *
 * - `confirms` is true — a Calendly booking really is a booking, and the
 *   customer gets Calendly's own confirmation.
 * - `staffSelection` is true only where every event type in use is a solo one.
 *   A round-robin or collective type lets Calendly choose the host, and Belle
 *   must not promise a caller a person Calendly may not give them.
 * - `reschedule` is true, but it is not a move: Calendly has no endpoint that
 *   moves a booking. Belline makes the new one **first** and cancels the old
 *   one after, so a failure leaves the guest holding the time they already had
 *   rather than nothing at all.
 * - `waitlist` is false, as for the other two: a slot freed in Calendly is not
 *   Belline's to hand out.
 *
 * A booking Calendly refuses is refused to the caller at the time, and the
 * Belline record is rolled back — the double-booking this adapter exists to
 * prevent is a booking that lives only on Belline's side. A *cancellation*
 * Calendly refuses is different: the guest has already been told, so the
 * booking keeps a mark and integrations/calendly.ts retries it, opens
 * `calendly_cancel_failed` for the team, and tells the owner on the connection.
 */

const NOT_CONNECTED =
  "The business's Calendly cannot be checked just now, so no time can be confirmed. Take their name, number and the time they want as a message, and say the team will confirm.";
const NEEDS_EMAIL =
  "This business books through Calendly, which needs an email address for the confirmation. Ask for one, read it back to them, and book again. If they would rather not give one, take the booking as a request instead.";
const NO_EVENT_TYPE =
  "This business's Calendly has nothing set up for that. Take the details as a request with take_booking_request and say the team will confirm.";
const ONE_AT_A_TIME =
  "Calendly books one kind of appointment at a time, so two services in one appointment cannot be booked here. Offer to book one of them, or take it as a request.";
const TAKEN = "That time has just gone in the business's Calendly. Check availability again and offer another time.";
const CAPPED =
  "The business's Calendly will not take any more bookings today. Take the customer's name, number and the time they want as a message, and say the team will confirm.";

/** As many as the engine offers everywhere else. */
const OFFERED = 6;

function refused(detail: string, reason = "calendar_unavailable"): BookingResult {
  return { ok: false, reason, detail, alternatives: [] };
}

/** An ISO instant as the venue's own local date and minute-of-day. */
function localOf(location: Location, iso: string): { date: string; startMin: number } {
  const date = dateIn(iso, location.timezone);
  const midnight = zonedInstant(date, 0, location.timezone);
  return { date, startMin: Math.round((Date.parse(iso) - midnight) / 60_000) };
}

/**
 * Is this time one the venue's own rules would allow at all?
 *
 * Calendly knows the owner's Calendly availability. It does not know the things
 * Belline was told: that the salon closes at six on a Monday, that this service
 * needs two days' notice, that the venue is shut for a bank holiday. Those can
 * only remove a time Calendly offered, never add one, so this is a filter and
 * not a search.
 */
function allowedByVenue(location: Location, slot: { date: string; startMin: number; endMin: number }): boolean {
  if ((location.closures ?? []).includes(slot.date)) return false;
  const ranges = location.hours?.[weekdayOf(slot.date)] ?? [];
  return ranges.some((r) => slot.startMin >= r.start && slot.endMin <= r.end);
}

/**
 * The provider for one venue.
 *
 * Built per venue rather than as a module constant, because `staffSelection`
 * depends on the shape of *this* owner's event types: a solo Calendly can
 * promise a named person and a round-robin one cannot, and a single shared
 * object could only answer one of them.
 */
export function calendlyProvider(venue: Location): BookingProvider {
  return {
    name: "calendly",

    capabilities: {
      availability: true,
      confirms: true,
      // A move is a new booking followed by a cancellation; see `rescheduleBooking`.
      reschedule: true,
      cancel: true,
      staffSelection: calendlyStaffSelection(venue),
      // A slot freed in Calendly is not Belline's to hand out.
      waitlist: false,
    },

    async getServices({ location }) {
      const link = location.calendly;
      const services = location.salon?.services ?? [];
      if (!link) return services;
      // A service with no Calendly event type cannot be booked, so it is not
      // offered. The owner is told which on the Calendars page (`calendlyLimits`).
      return services.filter((s) => eventTypeForServices(link, [s.id]));
    },

    async getStaff({ location }) {
      // Only where Calendly would honour the choice. A pooled event type hands
      // the appointment to whoever Calendly picks, so naming a person would be
      // a promise Belline cannot keep.
      return calendlyStaffSelection(location) ? (location.salon?.staff ?? []) : [];
    },

    async checkAvailability({ location, callId }, query) {
      if (!calendlyUsable(location)) return [];
      const link = location.calendly!;
      const type = eventTypeForServices(link, query.serviceIds);
      if (!type) return [];

      const from = new Date(zonedInstant(query.date, 0, location.timezone));
      const to = new Date(zonedInstant(query.date, 24 * 60, location.timezone));
      let open;
      try {
        open = await calendlyOpenTimes(location, type.uri, from, to);
      } catch (err) {
        console.warn(`[calendly] could not read open times for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
        // Never a time that could not be checked.
        return [];
      }

      const slots: Slot[] = [];
      for (const s of open) {
        if (s.inviteesRemaining <= 0) continue;
        const { date, startMin } = localOf(location, s.startTime);
        // Calendly answers in instants, and a window that starts at local
        // midnight can still end up on the day before or after.
        if (date !== query.date) continue;
        const slot: Slot = { date, startMin, endMin: startMin + type.duration };
        if (!allowedByVenue(location, slot)) continue;
        slots.push(slot);
      }
      // Nearest the time they asked for, as the engine orders everywhere else.
      const wanted = query.preferredMin;
      if (typeof wanted === "number") slots.sort((a, b) => Math.abs(a.startMin - wanted) - Math.abs(b.startMin - wanted));
      else slots.sort((a, b) => a.startMin - b.startMin);
      const offered = slots.slice(0, OFFERED);
      if (callId) {
        for (const slot of offered.slice(0, MAX_QUOTED_HOLDS)) holdForSlot(location, slot, { callId });
      }
      return offered;
    },

    async createBooking({ location }, input: CreateInput, idempotencyKey) {
      if (!calendlyUsable(location)) return refused(NOT_CONNECTED);
      const link = location.calendly!;

      if ((input.serviceIds ?? []).length > 1) return refused(ONE_AT_A_TIME, "unsupported");
      const type = eventTypeForServices(link, input.serviceIds);
      if (!type) return refused(NO_EVENT_TYPE, "unsupported");
      // Calendly will not take a booking without one, and it is where the
      // confirmation and the cancellation link go. Refused before anything is
      // written, so nothing is half-made.
      const email = input.guestEmail?.trim();
      if (!email) return refused(NEEDS_EMAIL, "needs_email");

      const startTime = new Date(zonedInstant(input.date, input.startMin, location.timezone)).toISOString();

      // The same booking arriving twice is one booking. Belline's own
      // fingerprint first (as the local engine uses), and then Calendly's own
      // record of this email at this instant inside `bookCalendlyInvitee`.
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
      const already = listBookings({ locationId: location.id, status: "confirmed" }).find((b) => b.idempotencyKey === key);
      if (already) return { ok: true, booking: already, duplicate: true };

      // Belline's own rules first: hours, notice, the venue's closures, and
      // whoever is free. The Belline record keeps the service's length and
      // Calendly's keeps the event type's; where the two disagree the customer
      // gets Calendly's, and `calendlyLimits` says so on the Calendars page
      // rather than letting the owner find out from a double-booked chair.
      const made = localCreate(location, {
        ...input,
        guestEmail: email,
        calendarWrittenBy: "provider",
      });
      if (!made.ok) return made;
      if (made.duplicate && made.booking.calendarEventId) return made;
      const booking = made.booking;

      try {
        const invitee = await bookCalendlyInvitee(location, {
          eventType: type.uri,
          startTime,
          name: input.guestName,
          email,
          timezone: location.timezone,
          phone: input.guestPhone,
        });
        const saved = saveBooking({
          ...booking,
          calendarEventId: invitee.eventUri,
          calendarId: type.uri,
          calendlyInvitee: invitee.uri,
          calendarSync: { state: "synced", provider: "calendly", attempts: 0, syncedAt: new Date().toISOString() },
        });
        noteCalendlyWriteSuccess(location.id, false);
        return made.duplicate ? { ok: true, booking: saved, duplicate: true } : { ok: true, booking: saved };
      } catch (err) {
        // Nothing was promised: the Belline record goes, and the agent is told
        // to take a message. A booking that exists only on Belline's side is
        // exactly the failure this adapter is for.
        localCancel(booking, location, "Calendly did not accept it");
        return calendlyRefusal(location, booking, err);
      }
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

    /**
     * Move a booking: a new Calendly booking, then a cancellation of the old.
     *
     * In that order, deliberately. Calendly has no endpoint that moves a
     * booking, so a move is two calls, and whichever way round they go one of
     * them can fail. Cancelling first and failing to rebook would leave a guest
     * with nothing; booking first and failing to cancel leaves a slot held in
     * Calendly, which the retry and the exception clear up. Only one of those
     * is recoverable, so that is the order.
     *
     * The guest gets two emails from Calendly — a cancellation and a new
     * confirmation — and it costs two of the account's daily bookings. Both are
     * said on the Calendars page at connect time (`calendlyLimits`).
     */
    async rescheduleBooking({ location }, booking, changes) {
      if (!calendlyUsable(location)) return refused(NOT_CONNECTED);
      const link = location.calendly!;
      const date = changes.date ?? booking.date;
      const startMin = changes.startMin ?? booking.startMin;
      const serviceIds = changes.serviceIds ?? booking.serviceIds;
      const type = eventTypeForServices(link, serviceIds);
      if (!type) return refused(NO_EVENT_TYPE, "unsupported");
      const email = booking.guestEmail?.trim();
      if (!email) return refused(NEEDS_EMAIL, "needs_email");

      // Belline's own rules on the new time, and the booking moved in Belline's
      // record — but not committed to Calendly until the new invitee exists.
      const moved = localModify(location, booking, changes);
      if (!moved.ok) return moved;

      const startTime = new Date(zonedInstant(date, startMin, location.timezone)).toISOString();
      const oldEvent = booking.calendarEventId;
      let invitee;
      try {
        invitee = await bookCalendlyInvitee(location, {
          eventType: type.uri,
          startTime,
          name: booking.guestName,
          email,
          timezone: location.timezone,
          phone: booking.guestPhone,
        });
      } catch (err) {
        // The old booking still stands, in Belline and in Calendly. Put the
        // record back and tell the caller the time did not move.
        localModify(location, getBooking(booking.id) ?? booking, {
          date: booking.date,
          startMin: booking.startMin,
          serviceIds: booking.serviceIds,
          staffId: booking.staffId,
          staffOverride: true,
        });
        return calendlyRefusal(location, booking, err);
      }

      const saved = saveBooking({
        ...(getBooking(moved.booking.id) ?? moved.booking),
        calendarEventId: invitee.eventUri,
        calendarId: type.uri,
        calendlyInvitee: invitee.uri,
        calendarSync: { state: "synced", provider: "calendly", attempts: 0, syncedAt: new Date().toISOString() },
      });

      if (oldEvent && oldEvent !== invitee.eventUri) {
        try {
          await cancelCalendlyEvent(location, oldEvent, "Moved to another time in Belline");
        } catch (err) {
          // The guest has the new time. The old one is still held in Calendly,
          // so it is marked, retried by the sweep and raised for the team.
          console.warn(`[calendly] ${location.name}: the old event for ${saved.ref} is still in Calendly: ${err instanceof Error ? err.message : String(err)}`);
          noteCalendlyWriteFailure(location.id, err);
          openException({
            tenantId: location.tenantId,
            locationId: location.id,
            kind: "calendly_cancel_failed",
            reason:
              `Booking ${saved.ref} was moved, the new time is in Calendly, but Calendly refused to cancel the old one. ` +
              `That slot is still held in the owner's Calendly and should be cancelled there by hand. Latest: ${err instanceof Error ? err.message : String(err)}`,
            context: { bookingId: saved.id, eventUri: oldEvent },
            source: "system",
          });
        }
      }
      return { ...moved, booking: saved };
    },

    async cancelBooking({ location }, booking, reason) {
      const eventUri = booking.calendarEventId;
      if (eventUri && location.calendly && calendlyUsable(location)) {
        try {
          await cancelCalendlyEvent(location, eventUri, reason ?? "Cancelled in Belline");
        } catch (err) {
          // The guest is told it is cancelled and the Belline record says so,
          // because refusing here would leave them believing they are still
          // booked. The Calendly side is marked and retried instead, and the
          // team is told if it keeps failing (integrations/calendly.ts).
          noteCalendlyWriteFailure(location.id, err);
          const cancelled = localCancel(booking, location, reason);
          return { ok: true, booking: markCalendlyCancelPending(cancelled) };
        }
      }
      return { ok: true, booking: localCancel(booking, location, reason) };
    },
  };
}

/**
 * What the agent is told when Calendly refuses, and what the owner and the team
 * are told at the same time. Every branch ends with a message the agent can act
 * on: no time is ever quietly lost.
 */
function calendlyRefusal(location: Location, booking: Booking, err: unknown): BookingResult {
  if (err instanceof CalendlyTimeTakenError) {
    // Somebody took it while the caller was deciding. Nothing is wrong.
    return refused(TAKEN, "unavailable");
  }
  if (err instanceof CalendlyPlanError) {
    markCalendlyPlanBlocked(location.id, err.message);
    return refused(NOT_CONNECTED);
  }
  if (err instanceof CalendlyRateLimitError) {
    noteCalendlyWriteFailure(location.id, err, CALENDLY_RATE_TEXT);
    openException({
      tenantId: location.tenantId,
      locationId: location.id,
      kind: "calendly_rate_limited",
      reason:
        `Calendly refused a booking for ${location.name} because the account has hit its API booking limit ` +
        `(${err.daily ? "the daily one" : "a short-term one"}; Calendly allows about 10 a minute, 50 an hour and 100 a day on a paid plan, and five a day on a trial). ` +
        "The caller was taken as a request, so nothing is lost. If this venue books more than a hundred a day, Calendly is the wrong destination for them and they should be told.",
      context: { bookingRef: booking.ref, daily: err.daily },
      source: "system",
    });
    return refused(CAPPED);
  }
  noteCalendlyWriteFailure(location.id, err);
  openException({
    tenantId: location.tenantId,
    locationId: location.id,
    kind: "calendly_booking_failed",
    reason:
      `Calendly refused a booking for ${location.name}. The caller was told Belline could not confirm and was taken as a message, ` +
      `so nothing was promised — but somebody should check the connection. Guest ${booking.guestName}, ${booking.date} ${booking.startMin}. ` +
      `Latest: ${err instanceof Error ? err.message : String(err)}`,
    context: { bookingRef: booking.ref },
    source: "system",
  });
  return refused(NOT_CONNECTED);
}
