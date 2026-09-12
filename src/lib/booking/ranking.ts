import type { Booking, Location, Minutes, Slot } from "../types";
import { listBookings } from "../store";
import { isRestaurant } from "../verticals";

/**
 * Which three times to say out loud.
 *
 * A search returns six bookable slots; a person on the phone will listen to
 * about three. Which three is not a cosmetic decision — it is the only lever
 * this product has over a venue's own yield, and it is the one thing the
 * incumbents charge extra for. SevenRooms sells shift optimisation, Fresha
 * nudges clients into the gaps, and both are doing the same arithmetic:
 * between two times the guest would accept equally, offer the one that leaves
 * the book in better shape.
 *
 * Two rules keep it honest, and they are why the weighting is as timid as it
 * is:
 *
 *   - **The caller's preference dominates.** A guest who asked for eight and
 *     is offered six because six suits the venue notices, and correctly
 *     concludes the venue is not listening. Yield is a tie-breaker between
 *     near-equal times, never an argument with the guest.
 *   - **Nothing here is ever the reason a time is withheld.** Ranking reorders
 *     what the engine already said yes to. A slot that exists is a slot the
 *     guest can have if they ask for it.
 */

export interface RankContext {
  /** What the caller actually asked for. Absent means they were flexible. */
  preferredMin?: Minutes;
  /** The day's book. Read from the store when not supplied. */
  bookings?: Booking[];
  partySize?: number;
}

/** Distance in minutes past which a slot stops being what the caller asked for. */
const PATIENCE_MIN = 120;

export function rankSlots(location: Location, slots: Slot[], ctx: RankContext = {}): Slot[] {
  if (slots.length <= 1) return slots.map((s) => ({ ...s, score: 1 }));

  const day = slots[0].date;
  const bookings = (ctx.bookings ?? listBookings({ locationId: location.id })).filter(
    (b) => b.date === day && b.status === "confirmed",
  );

  const scored = slots.map((slot) => ({
    slot,
    score:
      0.75 * proximity(slot, ctx.preferredMin) +
      0.25 * (isRestaurant(location) ? floorFit(location, slot, bookings, ctx) : diaryFit(slot, bookings)),
  }));

  return scored
    .sort((a, b) => b.score - a.score || a.slot.startMin - b.slot.startMin)
    .map(({ slot, score }) => ({ ...slot, score: Number(score.toFixed(3)) }));
}

/** 1 at the requested time, falling to 0 two hours away. */
function proximity(slot: Slot, preferredMin?: Minutes): number {
  if (preferredMin === undefined) return 1;
  const off = Math.abs(slot.startMin - preferredMin);
  return Math.max(0, 1 - off / PATIENCE_MIN);
}

/**
 * How good this seating is for the room.
 *
 * Two things, both of which a host does by eye. Wasting a six-top on a deuce
 * costs covers, and so does seating everybody at eight — a room that turns
 * evenly serves better food and sells a second sitting.
 */
function floorFit(
  location: Location,
  slot: Slot,
  bookings: Booking[],
  ctx: RankContext,
): number {
  const config = location.restaurant;
  if (!config) return 0.5;

  const party = ctx.partySize ?? 2;
  const seats = (slot.tableIds ?? []).reduce((n, id) => {
    const table = config.tables.find((t) => t.id === id);
    return n + (table?.maxSeats ?? 0);
  }, 0);
  // 1 for an exact fit, falling away as seats go unsold.
  const fit = seats > 0 ? Math.max(0, 1 - (seats - party) / Math.max(seats, 1)) : 0.5;

  const bucket = Math.floor(slot.startMin / config.slotMinutes);
  const seated = bookings
    .filter((b) => Math.floor(b.startMin / config.slotMinutes) === bucket)
    .reduce((n, b) => n + (b.partySize ?? 0), 0);
  const cap = config.maxCoversPerSlot || 1;
  // Emptier slots score higher, so a caller who does not much mind gets
  // steered off the crush at eight without ever being refused it.
  const spread = Math.max(0, 1 - seated / cap);

  return 0.6 * fit + 0.4 * spread;
}

/**
 * How good this appointment is for the diary.
 *
 * One thing, and it is the thing that decides whether a salon sells its
 * afternoon: a slot butted against work already booked leaves the day whole,
 * and a slot dropped into the middle of an empty afternoon cuts it into two
 * pieces too short to sell.
 */
function diaryFit(slot: Slot, bookings: Booking[]): number {
  const theirs = bookings.filter((b) => !slot.staffId || b.staffId === slot.staffId);
  if (theirs.length === 0) return 0.5;

  const gaps = theirs.map((b) =>
    b.endMin <= slot.startMin
      ? slot.startMin - b.endMin
      : b.startMin >= slot.endMin
        ? b.startMin - slot.endMin
        : Infinity,
  );
  const nearest = Math.min(...gaps.filter((g) => Number.isFinite(g)));
  if (!Number.isFinite(nearest)) return 0.5;

  // Touching existing work is perfect; an hour adrift of it is no better than
  // an empty day.
  return Math.max(0, 1 - nearest / 60);
}
