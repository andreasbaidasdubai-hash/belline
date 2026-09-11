import type {
  AvailabilityQuery,
  Booking,
  Location,
  SalonService,
  Slot,
  StaffMember,
} from "../types";
import {
  cancelBooking as localCancel,
  createBooking as localCreate,
  findAvailability as localSearch,
  modifyBooking as localModify,
  type CreateInput,
  type BookingResult,
} from "./index";
import { findBookingByRef, findBookingsByPhone, getBooking } from "../store";

/**
 * Where a booking actually happens.
 *
 * Belline's own engine is one implementation of this, not the definition of
 * it. The venues worth the most already run on something — SevenRooms, Fresha,
 * a clinic system, a shared Google Calendar — and they do not want a second
 * source of truth. They want the agent writing into the book their staff
 * already stare at all day. Implementing this interface against that system is
 * the whole integration.
 *
 * A note on why this file exists at all, because the repository already
 * contained an interface called `BookingBackend` that promised the same thing.
 * It had no implementations and no call sites: every tool called the local
 * engine directly, and the abstraction was a type nobody had ever run through.
 * An interface that has never carried a second implementation is a guess about
 * what a second implementation would need — usually a wrong one. So the local
 * engine is now a provider like any other, which means the seam is exercised
 * by every booking the product takes and cannot silently rot.
 *
 * Two design decisions worth stating.
 *
 * **Everything is async.** The local engine is synchronous and always will be;
 * a remote one never is. Making the interface async costs the local path
 * nothing and means adding a provider is not a refactor of every caller.
 *
 * **`capabilities` is not decoration.** A provider that cannot reschedule must
 * make the agent *say so* and take a message — not attempt it, fail, and leave
 * a guest believing their appointment moved. The tool layer reads this before
 * offering an action, which is the difference between an honest limitation and
 * a bug.
 */

export interface ProviderContext {
  location: Location;
  /** Threads a request through the logs. Passed to a remote provider's calls. */
  traceId?: string;
}

export interface Capabilities {
  /** Can an existing booking be moved? */
  reschedule: boolean;
  cancel: boolean;
  /** Can a guest ask for a particular person? */
  staffSelection: boolean;
  /** Is there somewhere to put a guest whose time was gone? */
  waitlist: boolean;
}

export interface BookingProvider {
  /** Shown in the tool trace and in the dashboard. Not user-facing. */
  readonly name: string;
  readonly capabilities: Capabilities;

  getServices(ctx: ProviderContext): Promise<SalonService[]>;
  getStaff(ctx: ProviderContext): Promise<StaffMember[]>;

  checkAvailability(ctx: ProviderContext, query: AvailabilityQuery): Promise<Slot[]>;

  /**
   * Create it, or say why not.
   *
   * `idempotencyKey` is the caller's promise that a second call carrying the
   * same key is the same request arriving twice — a retried webhook, a caller
   * who repeated themselves, a worker that crashed after the write and before
   * the reply. A provider that supports keys natively should pass it through;
   * one that does not should fall back to a content fingerprint, as the local
   * engine does.
   */
  createBooking(
    ctx: ProviderContext,
    input: CreateInput,
    idempotencyKey?: string,
  ): Promise<BookingResult>;

  /** By reference, the way a guest reads it out. */
  getBookingByRef(ctx: ProviderContext, ref: string): Promise<Booking | null>;
  getBookingById(ctx: ProviderContext, id: string): Promise<Booking | null>;
  /** Upcoming bookings for a number, newest first. */
  findBookingsByPhone(ctx: ProviderContext, phone: string): Promise<Booking[]>;

  rescheduleBooking(
    ctx: ProviderContext,
    booking: Booking,
    changes: Parameters<typeof localModify>[2],
    idempotencyKey?: string,
  ): Promise<BookingResult>;

  cancelBooking(
    ctx: ProviderContext,
    booking: Booking,
    reason?: string,
  ): Promise<{ ok: true; booking: Booking } | { ok: false; detail: string }>;
}

// ---------------------------------------------------------------------------
// The local engine, as a provider
// ---------------------------------------------------------------------------

/**
 * Belline's own book.
 *
 * A thin wrapper and deliberately nothing more — the logic stays in
 * restaurant.ts and salon.ts, where 28 tests already hold it down. What this
 * adds is the shape, so that the first remote provider is a new file rather
 * than a rewrite of the tool layer.
 */
export const localProvider: BookingProvider = {
  name: "belline",

  capabilities: {
    reschedule: true,
    cancel: true,
    staffSelection: true,
    waitlist: true,
  },

  async getServices({ location }) {
    return location.salon?.services ?? [];
  },

  async getStaff({ location }) {
    return location.salon?.staff ?? [];
  },

  async checkAvailability({ location }, query) {
    return localSearch(location, query);
  },

  async createBooking({ location }, input) {
    // The key is not passed through: the local engine fingerprints the booking
    // itself (venue, day, time, guest, party or services), which is stronger
    // than a caller-supplied key because it also catches the same booking
    // arriving by two different routes. See booking/idempotency.ts.
    return localCreate(location, input);
  },

  async getBookingByRef({ location }, ref) {
    return findBookingByRef(location.id, ref) ?? null;
  },

  async getBookingById({ location }, id) {
    const booking = getBooking(id);
    // Scoped, not trusted: an id is not an entitlement, and a booking from
    // another venue is not this venue's to read.
    return booking && booking.locationId === location.id ? booking : null;
  },

  async findBookingsByPhone({ location }, phone) {
    return findBookingsByPhone(location.id, phone);
  },

  async rescheduleBooking({ location }, booking, changes) {
    return localModify(location, booking, changes);
  },

  async cancelBooking(_ctx, booking) {
    return { ok: true, booking: localCancel(booking) };
  },
};

/**
 * Which book this venue writes into.
 *
 * One provider today. The signature takes the venue rather than a provider id
 * because the choice belongs to the venue — a group with a restaurant on
 * SevenRooms and a spa on Fresha is two providers in one tenant, and anything
 * keyed higher up would have to be undone.
 */
export function providerFor(_location: Location): BookingProvider {
  return localProvider;
}
