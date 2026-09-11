import type {
  AvailabilityQuery,
  Booking,
  DateStr,
  Location,
  Minutes,
  Slot,
} from "../types";
import {
  bookingRef,
  id,
  listBookings,
  saveBooking,
} from "../store";
import { minutesToSpoken, dateToSpoken } from "../time";
import { checkRestaurantSlot, searchRestaurant } from "./restaurant";
import { checkSalonSlot, chainDuration, resolveServices, searchSalon } from "./salon";
import { bookingKey, describeWhat, findDuplicate, type BookingIdentity } from "./idempotency";
import { pushBooking } from "../integrations/google";

/**
 * The booking facade the agent talks to.
 *
 * Everything vertical-specific stays in restaurant.ts / salon.ts; this file
 * is what the tool layer calls, and it is also the seam where a venue's
 * existing system takes over. A venue already on SevenRooms or Fresha does
 * not want a second source of truth — it wants the agent writing into the
 * book their staff already stare at all day. Implementing `BookingBackend`
 * against their API is the whole integration.
 */
export interface BookingBackend {
  name: string;
  search(location: Location, query: AvailabilityQuery): Promise<Slot[]>;
  create(location: Location, input: CreateInput): Promise<BookingResult>;
  cancel(location: Location, booking: Booking, reason?: string): Promise<void>;
}

export interface CreateInput {
  date: DateStr;
  startMin: Minutes;
  guestName: string;
  guestPhone: string;
  notes?: string;
  partySize?: number;
  serviceIds?: string[];
  staffId?: string;
  callId?: string;
  source?: Booking["source"];
  /** Set only from the calendar, by a person who can see the room. */
  overbook?: boolean;
}

export type BookingResult =
  | {
      ok: true;
      booking: Booking;
      /**
       * True when this booking already existed and was returned rather than
       * created. The agent should read it back as a confirmation, not
       * announce a second reservation — and the caller, who may simply have
       * repeated themselves, should never learn there was a question.
       */
      duplicate?: boolean;
    }
  | { ok: false; reason: string; detail: string; alternatives: Slot[] };

// ---------------------------------------------------------------------------

export function findAvailability(location: Location, query: AvailabilityQuery): Slot[] {
  const bookings = listBookings({ locationId: location.id });
  return location.vertical === "restaurant"
    ? searchRestaurant(location, bookings, query)
    : searchSalon(location, bookings, query);
}

export function createBooking(location: Location, input: CreateInput): BookingResult {
  const bookings = listBookings({ locationId: location.id });
  const now = new Date().toISOString();

  // Before anything is held: is this booking already on the book? A retried
  // tool call, a redelivered webhook, or a caller repeating themselves all
  // arrive here looking like a fresh request, and a restaurant that finds two
  // tables held for the same six people at eight o'clock does not forgive it.
  const identity: BookingIdentity = {
    locationId: location.id,
    date: input.date,
    startMin: input.startMin,
    guestPhone: input.guestPhone,
    guestName: input.guestName,
    what: describeWhat(input),
  };
  const already = findDuplicate(location, identity);
  if (already) return { ok: true, booking: already, duplicate: true };
  const idempotencyKey = bookingKey(identity);

  if (location.vertical === "restaurant") {
    const partySize = input.partySize ?? 2;
    const check = checkRestaurantSlot(location, bookings, {
      date: input.date,
      startMin: input.startMin,
      partySize,
      overbook: input.overbook,
    });
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        detail: check.detail,
        alternatives: findAvailability(location, {
          locationId: location.id,
          date: input.date,
          preferredMin: input.startMin,
          partySize,
        }),
      };
    }
    const booking: Booking = {
      id: id("bk"),
      ref: bookingRef(),
      locationId: location.id,
      vertical: "restaurant",
      status: "confirmed",
      date: input.date,
      startMin: check.assignment.startMin,
      endMin: check.assignment.endMin,
      guestName: input.guestName,
      guestPhone: input.guestPhone,
      notes: input.notes ?? "",
      partySize,
      tableIds: check.assignment.tableIds,
      source: input.source ?? "voice",
      callId: input.callId,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
    return { ok: true, booking: mirrored(location, saveBooking(booking)) };
  }

  const check = checkSalonSlot(location, bookings, {
    date: input.date,
    startMin: input.startMin,
    serviceIds: input.serviceIds ?? [],
    staffId: input.staffId,
  });
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      detail: check.detail,
      alternatives: findAvailability(location, {
        locationId: location.id,
        date: input.date,
        preferredMin: input.startMin,
        serviceIds: input.serviceIds,
        staffId: input.staffId,
      }),
    };
  }
  const booking: Booking = {
    id: id("bk"),
    ref: bookingRef(),
    locationId: location.id,
    // Not hardcoded: a clinic runs the same engine and its bookings must
    // carry their own vertical, or every read-back calls a patient a client.
    vertical: location.vertical,
    status: "confirmed",
    date: input.date,
    startMin: check.assignment.startMin,
    // The diary holds the buffer; the guest is told `endMin`.
    endMin: check.assignment.blockEndMin,
    guestName: input.guestName,
    guestPhone: input.guestPhone,
    notes: input.notes ?? "",
    serviceIds: check.assignment.serviceIds,
    staffId: check.assignment.staffId,
    resourceId: check.assignment.resourceId,
    source: input.source ?? "voice",
    callId: input.callId,
    idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, booking: mirrored(location, saveBooking(booking)) };
}

export function modifyBooking(
  location: Location,
  booking: Booking,
  changes: {
    date?: DateStr;
    startMin?: Minutes;
    partySize?: number;
    serviceIds?: string[];
    staffId?: string;
    notes?: string;
  },
): BookingResult {
  const bookings = listBookings({ locationId: location.id });
  const date = changes.date ?? booking.date;
  const startMin = changes.startMin ?? booking.startMin;

  if (location.vertical === "restaurant") {
    const partySize = changes.partySize ?? booking.partySize ?? 2;
    const check = checkRestaurantSlot(location, bookings, {
      date,
      startMin,
      partySize,
      excludeBookingId: booking.id,
    });
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        detail: check.detail,
        alternatives: findAvailability(location, {
          locationId: location.id,
          date,
          preferredMin: startMin,
          partySize,
          excludeBookingId: booking.id,
        }),
      };
    }
    const updated: Booking = {
      ...booking,
      date,
      startMin: check.assignment.startMin,
      endMin: check.assignment.endMin,
      partySize,
      tableIds: check.assignment.tableIds,
      notes: changes.notes ?? booking.notes,
      // The fingerprint describes where the booking *is*. Leaving the old one
      // in place would make this booking look like a duplicate of the slot it
      // just vacated, and block the next guest who genuinely wants it.
      idempotencyKey: bookingKey({
        locationId: location.id,
        date,
        startMin: check.assignment.startMin,
        guestPhone: booking.guestPhone,
        guestName: booking.guestName,
        what: describeWhat({ partySize }),
      }),
      updatedAt: new Date().toISOString(),
    };
    return { ok: true, booking: mirrored(location, saveBooking(updated)) };
  }

  const serviceIds = changes.serviceIds ?? booking.serviceIds ?? [];
  const check = checkSalonSlot(location, bookings, {
    date,
    startMin,
    serviceIds,
    staffId: changes.staffId ?? booking.staffId,
    excludeBookingId: booking.id,
  });
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      detail: check.detail,
      alternatives: findAvailability(location, {
        locationId: location.id,
        date,
        preferredMin: startMin,
        serviceIds,
        staffId: changes.staffId ?? booking.staffId,
        excludeBookingId: booking.id,
      }),
    };
  }
  const updated: Booking = {
    ...booking,
    date,
    startMin: check.assignment.startMin,
    endMin: check.assignment.blockEndMin,
    serviceIds: check.assignment.serviceIds,
    staffId: check.assignment.staffId,
    resourceId: check.assignment.resourceId,
    notes: changes.notes ?? booking.notes,
    // As above: the fingerprint follows the booking to its new slot, or it
    // would keep guarding the one this guest has just given up.
    idempotencyKey: bookingKey({
      locationId: location.id,
      date,
      startMin: check.assignment.startMin,
      guestPhone: booking.guestPhone,
      guestName: booking.guestName,
      what: describeWhat({ serviceIds: check.assignment.serviceIds }),
    }),
    updatedAt: new Date().toISOString(),
  };
  return { ok: true, booking: mirrored(location, saveBooking(updated)) };
}

export function cancelBooking(booking: Booking): Booking {
  return saveBooking({
    ...booking,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Phrasing helpers — these produce the strings the agent reads back, so they
// live next to the logic that produced the numbers rather than in the prompt.
// ---------------------------------------------------------------------------

export function describeSlot(location: Location, slot: Slot): string {
  const time = minutesToSpoken(slot.startMin);
  if (location.vertical === "restaurant") return time;
  return slot.staffName ? `${time} with ${slot.staffName}` : time;
}

/**
 * Just what the booking is, with no name or date — for lists that already
 * carry those in their own columns.
 */
export function describeBookingShort(location: Location, booking: Booking): string {
  if (booking.vertical === "restaurant") {
    const tables = (booking.tableIds ?? []).join(" + ");
    return `party of ${booking.partySize}${tables ? ` · table ${tables}` : ""}`;
  }
  const { services } = resolveServices(location.salon!, booking.serviceIds ?? []);
  const staff = location.salon!.staff.find((s) => s.id === booking.staffId);
  const { price } = chainDuration(services);
  return `${services.map((s) => s.name).join(" + ")}${staff ? ` · ${staff.name}` : ""} · ${
    location.currency
  } ${price}`;
}

/** The confirmation text a guest receives. Short — it is read on a lock screen. */
export function confirmationMessage(location: Location, booking: Booking): string {
  const when = `${dateToSpoken(booking.date, location.timezone)} at ${minutesToSpoken(booking.startMin)}`;
  const what =
    booking.vertical === "restaurant"
      ? `table for ${booking.partySize}`
      : resolveServices(location.salon!, booking.serviceIds ?? [])
          .services.map((s) => s.name)
          .join(" + ");

  return `${location.name}: ${what} confirmed for ${when}. Reference ${booking.ref}. Call ${location.phone} to change it.`;
}

export function describeBooking(location: Location, booking: Booking): string {
  const when = `${dateToSpoken(booking.date, location.timezone)} at ${minutesToSpoken(booking.startMin)}`;
  if (booking.vertical === "restaurant") {
    return `${booking.guestName}, party of ${booking.partySize}, ${when} (ref ${booking.ref})`;
  }
  const { services } = resolveServices(location.salon!, booking.serviceIds ?? []);
  const staff = location.salon!.staff.find((s) => s.id === booking.staffId);
  const { price } = chainDuration(services);
  return `${booking.guestName}, ${services.map((s) => s.name).join(" + ")}${
    staff ? ` with ${staff.name}` : ""
  }, ${when}, ${location.currency} ${price} (ref ${booking.ref})`;
}

/**
 * Mirror a booking into the venue's own calendar, if one is connected.
 *
 * Not awaited on purpose. The booking is already saved and is real either
 * way; a slow or broken Google must never hold a caller on the line. Failures
 * land on the connection so the dashboard can say so.
 */
function mirrored(location: Location, booking: Booking): Booking {
  if (location.google) void pushBooking(location, booking);
  return booking;
}