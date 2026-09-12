import type {
  AvailabilityQuery,
  Booking,
  DateStr,
  Location,
  Minutes,
  Slot,
} from "../types";
import { bookingRef, id, listBookings, saveBooking } from "../store";
import { addDays, minutesToSpoken, dateToSpoken } from "../time";
import { normalisePhone } from "../guests";
import { checkRestaurantSlot, searchRestaurant } from "./restaurant";
import { checkSalonSlot, chainDuration, resolveServices, searchSalon } from "./salon";
import { serviceShape } from "./services";
import {
  checkPolicy,
  depositFor,
  isLateCancel,
  nowIn,
  type Now,
  type PolicyReason,
} from "./policy";
import { asBookings as holdsAsBookings, releaseCall } from "./holds";
import { bookingKey, describeWhat, findDuplicate, type BookingIdentity } from "./idempotency";
import { pushBooking } from "../integrations/google";
import { listWaitlist } from "../store";
import { markConverted } from "../waitlist";

/**
 * The booking facade the agent talks to.
 *
 * Everything vertical-specific stays in restaurant.ts / salon.ts; this file is
 * what the tool layer calls, and it is where the two questions are put
 * together: is the room free (the engines) and will the business take it (the
 * policy). It is also the seam where a venue's existing system takes over — a
 * venue already on SevenRooms or Fresha does not want a second source of
 * truth, it wants the agent writing into the book its staff already stare at
 * all day. See provider.ts.
 */
export interface CreateInput {
  date: DateStr;
  startMin: Minutes;
  guestName: string;
  guestPhone: string;
  /** Only where `Location.requiresEmail` is set. Validated before it gets here. */
  guestEmail?: string;
  notes?: string;
  partySize?: number;
  serviceIds?: string[];
  staffId?: string;
  callId?: string;
  source?: Booking["source"];
  /** Set only from the calendar, by a person who can see the room. */
  overbook?: boolean;
  /**
   * A person working the book rather than a caller on the line. Lifts the
   * rules that exist to stop the agent over-promising, and none of the rules
   * that stop anybody double-booking a room.
   */
  staffOverride?: boolean;
  /** The recall this booking answers, so the due list can close itself out. */
  recallOf?: string;
  /** Freeze the clock. Tests only — a notice-period rule is untestable without it. */
  now?: Now;
}

export type BookingResult =
  | {
      ok: true;
      booking: Booking;
      /**
       * True when this booking already existed and was returned rather than
       * created. The agent should read it back as a confirmation, not announce
       * a second reservation — and the caller, who may simply have repeated
       * themselves, should never learn there was a question.
       */
      duplicate?: boolean;
    }
  | {
      ok: false;
      reason: string;
      detail: string;
      alternatives: Slot[];
      /**
       * Set when the business said no rather than the room. The difference
       * matters to the agent: a full room is answered with other times, a
       * notice period is answered with an apology and the earliest date that
       * works, and offering alternatives to somebody who has been told they
       * need to call back is worse than saying nothing.
       */
      policy?: PolicyReason;
    };

// ---------------------------------------------------------------------------

/**
 * Free times, with anything another live call is currently holding taken out.
 *
 * `callId` is the conversation asking. Its own holds are invisible to it, or
 * the agent would offer a caller a time and then refuse to book it — which is
 * the bug every first implementation of quote-holding ships with.
 */
export function findAvailability(
  location: Location,
  query: AvailabilityQuery,
  opts: { callId?: string } = {},
): Slot[] {
  const bookings = withHolds(location, query.date, opts.callId);
  return location.vertical === "restaurant"
    ? searchRestaurant(location, bookings, query)
    : searchSalon(location, bookings, query);
}

export function createBooking(location: Location, input: CreateInput): BookingResult {
  const all = listBookings({ locationId: location.id });
  const bookings = withHolds(location, input.date, input.callId, all);
  const now = input.now ?? nowIn(location);
  const stamp = new Date().toISOString();

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

  const newGuest = isNewGuest(all, input.guestPhone);

  // The house rules, before the floor plan. A table being empty tomorrow
  // morning is not the same question as whether the business will take a
  // booking for it from somebody ringing tonight.
  const refused = checkPolicy(location, {
    date: input.date,
    startMin: input.startMin,
    minNoticeMin: noticeNeededFor(location, input),
    guestPhone: input.guestPhone,
    history: all,
    staffOverride: input.staffOverride,
    now,
  });
  if (refused) {
    return {
      ok: false,
      reason: refused.reason,
      detail: refused.detail,
      policy: refused.reason,
      alternatives: [],
    };
  }

  if (location.vertical === "restaurant") {
    const partySize = input.partySize ?? 2;
    const check = checkRestaurantSlot(location, bookings, {
      date: input.date,
      startMin: input.startMin,
      partySize,
      overbook: input.overbook,
      staffOverride: input.staffOverride,
    });
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        detail: check.detail,
        alternatives: findAvailability(
          location,
          {
            locationId: location.id,
            date: input.date,
            preferredMin: input.startMin,
            partySize,
            staffOverride: input.staffOverride,
          },
          { callId: input.callId },
        ),
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
      deposit: depositFor(location, {
        date: input.date,
        partySize,
        guestPhone: input.guestPhone,
        history: all,
      }),
      source: input.source ?? "voice",
      callId: input.callId,
      recallOf: input.recallOf,
      idempotencyKey,
      createdAt: stamp,
      updatedAt: stamp,
    };
    return { ok: true, booking: settled(location, booking, input.callId) };
  }

  const check = checkSalonSlot(location, bookings, {
    date: input.date,
    startMin: input.startMin,
    serviceIds: input.serviceIds ?? [],
    staffId: input.staffId,
    newGuest,
    staffOverride: input.staffOverride,
  });
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      detail: check.detail,
      alternatives: findAvailability(
        location,
        {
          locationId: location.id,
          date: input.date,
          preferredMin: input.startMin,
          serviceIds: input.serviceIds,
          staffId: input.staffId,
          newGuest,
          staffOverride: input.staffOverride,
        },
        { callId: input.callId },
      ),
    };
  }

  const recall = recallFor(location, input.date, check.assignment.serviceIds);
  const booking: Booking = {
    id: id("bk"),
    ref: bookingRef(),
    locationId: location.id,
    // Not hardcoded: a clinic runs the same engine and its bookings must carry
    // their own vertical, or every read-back calls a patient a client.
    vertical: location.vertical,
    status: "confirmed",
    date: input.date,
    startMin: check.assignment.startMin,
    // The diary holds the buffer; the guest is told `endMin`.
    endMin: check.assignment.blockEndMin,
    guestName: input.guestName,
    guestPhone: input.guestPhone,
    guestEmail: input.guestEmail,
    notes: input.notes ?? "",
    serviceIds: check.assignment.serviceIds,
    staffId: check.assignment.staffId,
    resourceId: check.assignment.resourceId,
    resourceIds: check.assignment.resourceIds.length ? check.assignment.resourceIds : undefined,
    secondaryStaffId: check.assignment.secondaryStaffId,
    deposit: depositFor(location, {
      date: input.date,
      value: check.assignment.price,
      guestPhone: input.guestPhone,
      history: all,
    }),
    recallDueOn: recall?.dueOn,
    recallServiceId: recall?.serviceId,
    recallOf: input.recallOf,
    source: input.source ?? "voice",
    callId: input.callId,
    idempotencyKey,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return { ok: true, booking: settled(location, booking, input.callId) };
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
    staffOverride?: boolean;
    now?: Now;
  },
): BookingResult {
  const all = listBookings({ locationId: location.id });
  const date = changes.date ?? booking.date;
  const startMin = changes.startMin ?? booking.startMin;
  const bookings = withHolds(location, date, booking.callId, all);

  // Moving a booking is taking a new one, as far as the house rules go. A
  // clinic that needs a day's notice needs it for the new time, not the old.
  const refused = checkPolicy(location, {
    date,
    startMin,
    guestPhone: booking.guestPhone,
    history: all,
    staffOverride: changes.staffOverride,
    now: changes.now ?? nowIn(location),
  });
  if (refused) {
    return {
      ok: false,
      reason: refused.reason,
      detail: refused.detail,
      policy: refused.reason,
      alternatives: [],
    };
  }

  if (location.vertical === "restaurant") {
    const partySize = changes.partySize ?? booking.partySize ?? 2;
    const check = checkRestaurantSlot(location, bookings, {
      date,
      startMin,
      partySize,
      excludeBookingId: booking.id,
      staffOverride: changes.staffOverride,
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
          staffOverride: changes.staffOverride,
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
    staffOverride: changes.staffOverride,
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
        staffOverride: changes.staffOverride,
      }),
    };
  }
  const recall = recallFor(location, date, check.assignment.serviceIds);
  const updated: Booking = {
    ...booking,
    date,
    startMin: check.assignment.startMin,
    endMin: check.assignment.blockEndMin,
    serviceIds: check.assignment.serviceIds,
    staffId: check.assignment.staffId,
    resourceId: check.assignment.resourceId,
    resourceIds: check.assignment.resourceIds.length ? check.assignment.resourceIds : undefined,
    secondaryStaffId: check.assignment.secondaryStaffId,
    recallDueOn: recall?.dueOn,
    recallServiceId: recall?.serviceId,
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

/**
 * Cancel it, and record whether it was late.
 *
 * The venue is passed in where the caller has it, because "late" is the
 * venue's own definition and a cancellation with no record of which side of
 * the window it fell on is a cancellation the venue cannot act on. Belline
 * charges nobody — see `lateCancelNotice`, which states the policy and stops
 * there.
 */
export function cancelBooking(
  booking: Booking,
  location?: Location,
  reason?: string,
): Booking {
  const at = new Date().toISOString();
  return saveBooking({
    ...booking,
    status: "cancelled",
    cancelledAt: at,
    cancelReason: reason,
    lateCancel: location ? isLateCancel(location, booking) : booking.lateCancel,
    updatedAt: at,
  });
}

export type Progress = "arrived" | "seated" | "left" | "no_show" | "reopen";

/**
 * What actually happened, as against what was booked.
 *
 * This is the smallest piece of the product and one of the load-bearing ones,
 * because three things already read it and until now nothing could write it:
 * `noShowsBeforeReview` in the house rules, the recall list, and every guest
 * record. A venue that had set "hand to a person after two no-shows" had set a
 * rule that could never fire, and every guest showed nought no-shows for ever
 * — which is worse than not having the number, because it reads as a fact.
 *
 * Arriving and being seated leave the booking confirmed: a seated party still
 * holds its table. Leaving and not turning up both end it, which is what frees
 * the table and what keeps the covers report honest.
 */
export function markProgress(booking: Booking, event: Progress): Booking {
  const at = new Date().toISOString();

  // Putting a booking back is a correction, not an event — somebody ticked the
  // wrong row. It clears the trail rather than adding to it, because a guest
  // marked absent and then found in the bar was never absent.
  if (event === "reopen") {
    const reopened = { ...booking, status: "confirmed" as const, updatedAt: at };
    delete reopened.service;
    return saveBooking(reopened);
  }

  if (event === "no_show") {
    return saveBooking({ ...booking, status: "no_show", service: undefined, updatedAt: at });
  }

  const service = { ...(booking.service ?? {}) };
  if (event === "arrived") service.arrivedAt = at;
  if (event === "seated") service.seatedAt = at;
  if (event === "left") service.leftAt = at;

  return saveBooking({
    ...booking,
    service,
    // A party that has been and gone is completed, and counting them as a live
    // booking is what makes a venue's own covers report wrong.
    status: event === "left" ? "completed" : booking.status,
    updatedAt: at,
  });
}

// ---------------------------------------------------------------------------
// Phrasing helpers — these produce the strings the agent reads back, so they
// live next to the logic that produced the numbers rather than in the prompt.
// ---------------------------------------------------------------------------

/**
 * Just what the booking is, with no name or date — for lists that already
 * carry those in their own columns.
 */
export function describeBookingShort(location: Location, booking: Booking): string {
  if (booking.vertical === "restaurant") {
    const tables = (booking.tableIds ?? []).join(" + ");
    return `party of ${booking.partySize}${tables ? ` · table ${tables}` : ""}`;
  }
  const config = location.salon!;
  const staff = config.staff.find((s) => s.id === booking.staffId);
  const shape = serviceShape(config, booking.serviceIds ?? [], { staff });
  return `${shape.services.map((s) => s.name).join(" + ")}${staff ? ` · ${staff.name}` : ""} · ${
    location.currency
  } ${shape.price}`;
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
  const config = location.salon!;
  const staff = config.staff.find((s) => s.id === booking.staffId);
  const shape = serviceShape(config, booking.serviceIds ?? [], { staff });
  return `${booking.guestName}, ${shape.services.map((s) => s.name).join(" + ")}${
    staff ? ` with ${staff.name}` : ""
  }, ${when}, ${location.currency} ${shape.price} (ref ${booking.ref})`;
}

// ---------------------------------------------------------------------------

/** The book, plus whatever other live calls are holding right now. */
function withHolds(
  location: Location,
  date: DateStr,
  callId?: string,
  book?: Booking[],
): Booking[] {
  const bookings = book ?? listBookings({ locationId: location.id });
  const held = holdsAsBookings(location.id, date, callId);
  return held.length === 0 ? bookings : [...bookings, ...held];
}

/** Nobody has been here before under this number. */
function isNewGuest(history: Booking[], phone: string): boolean {
  const key = normalisePhone(phone);
  if (key.length < 6) return false;
  return !history.some(
    (b) =>
      normalisePhone(b.guestPhone) === key &&
      (b.status === "completed" || b.status === "confirmed"),
  );
}

/** Extra notice this particular booking needs, beyond the venue's own rule. */
function noticeNeededFor(location: Location, input: CreateInput): number | undefined {
  if (location.vertical !== "restaurant") return undefined;
  const config = location.restaurant;
  if (!config) return undefined;
  const service = config.services.find(
    (s) => input.startMin >= s.start && input.startMin <= s.lastSeating,
  );
  return service?.minNoticeMin;
}

/**
 * When this visit brings the guest back.
 *
 * The longest interval among the services booked wins: somebody having a
 * cleaning and a filling is due back for the cleaning in six months, not for
 * the filling in none. Written onto the booking so the due list is a query
 * rather than a nightly job with somewhere to fail silently.
 */
function recallFor(
  location: Location,
  date: DateStr,
  serviceIds: string[],
): { dueOn: DateStr; serviceId: string } | undefined {
  const config = location.salon;
  if (!config) return undefined;

  let best: { days: number; serviceId: string } | undefined;
  for (const serviceId of serviceIds) {
    const service = config.services.find((s) => s.id === serviceId);
    if (!service?.recallDays) continue;
    if (!best || service.recallDays > best.days) {
      best = { days: service.recallDays, serviceId };
    }
  }
  return best ? { dueOn: addDays(date, best.days), serviceId: best.serviceId } : undefined;
}

/**
 * Save it, let the caller's hold go, and mirror it outward.
 *
 * The hold is released the moment the booking is real. Leaving it would cost
 * the venue the next ninety seconds of that table for no reason, and the
 * commonest next thing a caller says is "actually, can we make it two tables".
 */
function settled(location: Location, booking: Booking, callId?: string): Booking {
  const saved = saveBooking(booking);
  if (callId) releaseCall(callId);
  convertWaitlist(saved);
  return mirrored(location, saved);
}

/**
 * The waitlist entry this booking answers, if there is one.
 *
 * `markConverted` existed, was documented, and was called by nothing — so the
 * conversion the waitlist page reports was zero for every venue for ever. A
 * booking by the same number on the same day, inside the window the guest
 * said they would accept, is that guest taking the slot they were waiting for.
 */
function convertWaitlist(booking: Booking): void {
  const key = normalisePhone(booking.guestPhone);
  if (key.length < 6) return;
  for (const entry of listWaitlist({ locationId: booking.locationId, date: booking.date })) {
    if (entry.status !== "waiting" && entry.status !== "offered") continue;
    if (normalisePhone(entry.guestPhone) !== key) continue;
    if (booking.startMin < entry.earliestMin || booking.startMin > entry.latestMin) continue;
    markConverted(entry.id, booking);
    return;
  }
}

/**
 * Mirror a booking into the venue's own calendar, if one is connected.
 *
 * Not awaited on purpose. The booking is already saved and is real either way;
 * a slow or broken Google must never hold a caller on the line. Failures land
 * on the connection so the dashboard can say so.
 */
function mirrored(location: Location, booking: Booking): Booking {
  if (location.google) void pushBooking(location, booking);
  return booking;
}

export { chainDuration, resolveServices };
