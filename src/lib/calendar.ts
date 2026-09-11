import type { Booking, Location, Minutes } from "./types";
import { listBookings } from "./store";
import { isRestaurant } from "./verticals";
import { todayIn, nowMinutesIn } from "./time";

/**
 * The day, as the people working it see it.
 *
 * A list of bookings answers "what is booked". It does not answer the
 * questions a host or a receptionist actually has: is nine o'clock going to
 * fall over, who is free at two, can I fit this person in, why does that gap
 * exist. Those are spatial questions, and they need a grid — time down one
 * axis, the thing being booked along the other.
 *
 * What the columns are is the only real difference between the trades. A
 * restaurant books tables, so its columns are tables grouped by section. A
 * salon or a clinic books a person's diary, so its columns are people. The
 * arithmetic underneath is identical, which is why one engine has always been
 * able to serve both.
 */

export interface Column {
  id: string;
  name: string;
  /** Section for a restaurant, role for a diary. Groups the header. */
  group?: string;
  /** Seats, for a restaurant. Lets the grid show what a table can take. */
  capacity?: string;
}

export interface Block {
  booking: Booking;
  columnId: string;
  /** Guest-facing start and end. */
  startMin: Minutes;
  endMin: Minutes;
  /**
   * Where the diary is held beyond what the guest was told.
   *
   * The cleanup buffer is the thing every spreadsheet gets wrong: the guest
   * has a 45-minute appointment, the chair is gone for 55, and a diary that
   * only draws the 45 will cheerfully double-book the turnaround. Drawn, but
   * drawn differently — it is not the guest's time.
   */
  bufferEndMin: Minutes;
  title: string;
  detail: string;
}

export interface DayView {
  date: string;
  /** Grid bounds, in minutes from midnight. */
  openMin: Minutes;
  closeMin: Minutes;
  columns: Column[];
  blocks: Block[];
  /** Minutes from midnight, or null when the day being viewed is not today. */
  nowMin: number | null;
  /** Bookings that belong to the day but could not be placed in a column. */
  unplaced: Booking[];
  covers: number;
  appointments: number;
  /**
   * Covers seated per slot against the kitchen's cap.
   *
   * The single number a restaurant manager wants at a glance, and the one a
   * calendar normally cannot show: not "is there a free table" but "will the
   * pass survive eight o'clock".
   */
  pacing: { startMin: Minutes; covers: number; cap: number }[];
}

const FALLBACK_OPEN = 8 * 60;
const FALLBACK_CLOSE = 23 * 60;

function columnsFor(location: Location): Column[] {
  if (isRestaurant(location)) {
    return (location.restaurant?.tables ?? []).map((table) => ({
      id: table.id,
      name: table.name,
      group: table.section,
      capacity: table.minSeats === table.maxSeats ? `${table.maxSeats}` : `${table.minSeats}–${table.maxSeats}`,
    }));
  }
  return (location.salon?.staff ?? []).map((person) => ({
    id: person.id,
    name: person.name,
  }));
}

/** The window the grid draws, widened to cover anything booked outside it. */
function boundsFor(location: Location, date: string, bookings: Booking[]): [Minutes, Minutes] {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const ranges = location.hours[weekday] ?? [];

  let open = ranges.length ? Math.min(...ranges.map((r) => r.start)) : FALLBACK_OPEN;
  let close = ranges.length ? Math.max(...ranges.map((r) => r.end)) : FALLBACK_CLOSE;

  // A booking outside opening hours is a real thing — a fixed appointment, a
  // private event — and a grid that cropped it would hide it entirely.
  for (const booking of bookings) {
    open = Math.min(open, booking.startMin);
    close = Math.max(close, booking.endMin);
  }
  return [Math.max(0, open - 30), Math.min(24 * 60, close + 30)];
}

function titleFor(location: Location, booking: Booking): string {
  return booking.guestName || "Reservation";
}

function detailFor(location: Location, booking: Booking): string {
  if (isRestaurant(location)) {
    const covers = booking.partySize ?? 0;
    return `${covers} ${covers === 1 ? "cover" : "covers"}`;
  }
  const services = location.salon?.services ?? [];
  const names = (booking.serviceIds ?? [])
    .map((id) => services.find((s) => s.id === id)?.name)
    .filter(Boolean);
  return names.join(" + ") || "Appointment";
}

/**
 * Covers seated in each slot, against the kitchen's cap.
 *
 * Counted by *start* time, not by occupancy: the pass is overwhelmed by
 * everyone arriving at once, not by how many people are in the room.
 */
function pacingFor(location: Location, bookings: Booking[], open: Minutes, close: Minutes) {
  const config = location.restaurant;
  if (!config) return [];

  const slot = config.slotMinutes || 15;
  const out: { startMin: Minutes; covers: number; cap: number }[] = [];

  for (let at = open; at < close; at += slot) {
    const covers = bookings
      .filter((b) => b.startMin >= at && b.startMin < at + slot)
      .reduce((n, b) => n + (b.partySize ?? 0), 0);
    if (covers > 0) out.push({ startMin: at, covers, cap: config.maxCoversPerSlot });
  }
  return out;
}

export function dayView(location: Location, date: string): DayView {
  const bookings = listBookings({ locationId: location.id })
    .filter((b) => b.date === date && b.status === "confirmed")
    .sort((a, b) => a.startMin - b.startMin);

  const columns = columnsFor(location);
  const byId = new Set(columns.map((c) => c.id));
  const [openMin, closeMin] = boundsFor(location, date, bookings);

  const blocks: Block[] = [];
  const unplaced: Booking[] = [];

  for (const booking of bookings) {
    // A restaurant booking can hold two tables; it draws in both columns.
    const ids = isRestaurant(location)
      ? (booking.tableIds ?? []).filter((id) => byId.has(id))
      : booking.staffId && byId.has(booking.staffId)
        ? [booking.staffId]
        : [];

    if (ids.length === 0) {
      unplaced.push(booking);
      continue;
    }

    for (const columnId of ids) {
      blocks.push({
        booking,
        columnId,
        startMin: booking.startMin,
        // For a diary the stored end already includes the buffer; the guest
        // was told the shorter time, so the two are drawn separately.
        endMin: guestEnd(location, booking),
        bufferEndMin: booking.endMin,
        title: titleFor(location, booking),
        detail: detailFor(location, booking),
      });
    }
  }

  return {
    date,
    openMin,
    closeMin,
    columns,
    blocks,
    nowMin: date === todayIn(location.timezone) ? nowMinutesIn(location.timezone) : null,
    unplaced,
    covers: bookings.reduce((n, b) => n + (b.partySize ?? 0), 0),
    appointments: bookings.length,
    pacing: pacingFor(location, bookings, openMin, closeMin),
  };
}

export interface WeekDay {
  date: string;
  /** 0 = Sunday, matching Date.getDay(). */
  weekday: number;
  covers: number;
  appointments: number;
  /** Busiest quarter-hour, for the restaurant strip. */
  peak: { startMin: Minutes; covers: number; cap: number } | null;
  /** Fraction of the day's capacity taken, 0–1, for the bar height. */
  load: number;
  closed: boolean;
  isToday: boolean;
}

/**
 * Seven days at a glance.
 *
 * A day view answers "what is happening now"; a week answers "where are we
 * thin". Restaurants plan staffing a week out and salons chase the empty
 * Tuesday, and neither question is visible one day at a time.
 *
 * Load is deliberately coarse — a bar, not a number. Precision here would be
 * false: it is a shape to scan, and anyone who wants the detail clicks the
 * day.
 */
export function weekView(location: Location, from: string): WeekDay[] {
  const today = todayIn(location.timezone);
  const out: WeekDay[] = [];

  for (let i = 0; i < 7; i++) {
    const date = shiftDate(from, i);
    const weekday = new Date(`${date}T12:00:00`).getDay();
    const ranges = location.hours[weekday] ?? [];
    const closed = ranges.length === 0 || location.closures.includes(date);

    const bookings = listBookings({ locationId: location.id }).filter(
      (b) => b.date === date && b.status === "confirmed",
    );
    const covers = bookings.reduce((n, b) => n + (b.partySize ?? 0), 0);

    let peak: WeekDay["peak"] = null;
    let load = 0;

    if (isRestaurant(location) && location.restaurant) {
      const openMin = ranges.length ? Math.min(...ranges.map((r) => r.start)) : FALLBACK_OPEN;
      const closeMin = ranges.length ? Math.max(...ranges.map((r) => r.end)) : FALLBACK_CLOSE;
      const slots = pacingFor(location, bookings, openMin, closeMin);
      peak = slots.sort((a, b) => b.covers - a.covers)[0] ?? null;

      // Against the room's total seats, which is the honest denominator: a
      // restaurant is full when the seats are gone, not when the slots are.
      const seats = (location.restaurant.tables ?? []).reduce((n, t) => n + t.maxSeats, 0);
      load = seats > 0 ? Math.min(1, covers / seats) : 0;
    } else {
      // A diary is full when its people are. Minutes booked against minutes
      // available is the only measure that survives different service lengths.
      const staff = location.salon?.staff ?? [];
      const available = staff.reduce((total, person) => {
        const hours = person.hours[weekday] ?? [];
        return total + hours.reduce((n, r) => n + (r.end - r.start), 0);
      }, 0);
      const booked = bookings.reduce((n, b) => n + (b.endMin - b.startMin), 0);
      load = available > 0 ? Math.min(1, booked / available) : 0;
    }

    out.push({
      date,
      weekday,
      covers,
      appointments: bookings.length,
      peak,
      load,
      closed,
      isToday: date === today,
    });
  }
  return out;
}

/** Monday of the week containing this date. Weeks start on Monday in trade. */
export function weekStart(date: string): string {
  const day = new Date(`${date}T12:00:00`).getDay();
  // getDay() puts Sunday at 0; a working week starts the day after.
  const back = day === 0 ? 6 : day - 1;
  return shiftDate(date, -back);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What the guest was told, as opposed to what the diary holds. */
function guestEnd(location: Location, booking: Booking): Minutes {
  if (isRestaurant(location)) return booking.endMin;
  const services = location.salon?.services ?? [];
  const worked = (booking.serviceIds ?? []).reduce((total, id) => {
    const service = services.find((s) => s.id === id);
    return total + (service?.durationMin ?? 0);
  }, 0);
  return worked > 0 ? booking.startMin + worked : booking.endMin;
}
