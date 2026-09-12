import type { Booking, Location, Minutes, SalonService, TimeRange } from "./types";
import { listBookings } from "./store";
import { isRestaurant } from "./verticals";
import { todayIn, nowMinutesIn, weekdayOf } from "./time";
import { staffWorkingRanges, soldMinutes } from "./booking/salon";
import {
  bookingStaffBusy,
  rangeMinutes,
  resourceTypesOf,
  serviceShape,
} from "./booking/services";

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
 * able to serve both — and why the room axis, below, is the same function with
 * a different `columnsFor`.
 *
 * Three things this produces that a calendar does not, and each is the reason
 * somebody would rather look at this than at the diary they already have:
 *
 *   - **Shifts, drawn.** A grid that runs 08:00 to 23:00 for everybody is
 *     lying about four of the five people in it. Every column carries the
 *     hours that person is actually on.
 *   - **The gap inside an appointment.** Colour develops for forty minutes
 *     with the stylist standing free, and a block drawn as one solid bar hides
 *     the most sellable time in the day.
 *   - **The gaps between.** Named, measured and priced, because a
 *     forty-minute hole at two o'clock is not a scheduling curiosity, it is
 *     the thing an outbound call is for.
 */

export interface Column {
  id: string;
  name: string;
  /** Section for a restaurant, role for a diary. Groups the header. */
  group?: string;
  /** Seats, for a restaurant. Lets the grid show what a table can take. */
  capacity?: string;
  /** When this column is actually available — a shift, or opening hours. */
  shift: TimeRange[];
  /** Minutes of that shift already sold. */
  soldMin: number;
  /** Minutes the shift contains at all. */
  availableMin: number;
  /** Sold over available, 0–1. The number a manager scans the row for. */
  utilisation: number;
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
  /**
   * The stretches inside this block where the practitioner is genuinely
   * occupied. Anything between them is processing time: the chair is taken,
   * the person is not, and with dovetailing on somebody else is already in it.
   * Absent for a restaurant, and for a service with no phases.
   */
  busy?: TimeRange[];
  title: string;
  detail: string;
  /** Front-of-house progress, for the colour of the block. */
  arrived?: boolean;
  seated?: boolean;
  /** Set where money was asked for and has not been confirmed. */
  depositDue?: boolean;
}

/** A table out of play, or a room being cleaned. Drawn, but not a booking. */
export interface OffBlock {
  columnId: string;
  startMin: Minutes;
  endMin: Minutes;
  reason: string;
}

/**
 * Time nobody has bought, in a stretch long enough to sell.
 *
 * The unit of an outbound campaign. A diary with four of these on a Tuesday is
 * a diary worth ringing the waitlist about, and until something computes them
 * nobody ever does.
 */
export interface Gap {
  columnId: string;
  columnName: string;
  startMin: Minutes;
  endMin: Minutes;
  minutes: number;
  /** The shortest thing that would fit, where the price list says. */
  fits?: string;
  /** What filling it would be worth, at list price. */
  value: number;
}

export interface DayView {
  date: string;
  /** Grid bounds, in minutes from midnight. */
  openMin: Minutes;
  closeMin: Minutes;
  columns: Column[];
  blocks: Block[];
  offBlocks: OffBlock[];
  /** Minutes from midnight, or null when the day being viewed is not today. */
  nowMin: number | null;
  /** Bookings that belong to the day but could not be placed in a column. */
  unplaced: Booking[];
  covers: number;
  appointments: number;
  /** Sold over available across every column, 0–1. */
  utilisation: number;
  /** Sellable holes, longest first. */
  gaps: Gap[];
  /** What the day is worth so far, at the prices actually quoted. */
  revenue: number;
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

/** Below this, a hole in the diary is a turnaround rather than an opportunity. */
const MIN_SELLABLE_GAP = 20;

function openHours(location: Location, date: string): TimeRange[] {
  return location.hours[weekdayOf(date)] ?? [];
}

function columnsFor(location: Location, date: string): Omit<Column, "soldMin" | "availableMin" | "utilisation">[] {
  if (isRestaurant(location)) {
    const hours = openHours(location, date);
    return (location.restaurant?.tables ?? []).map((table) => ({
      id: table.id,
      name: table.name,
      group: table.section,
      capacity:
        table.minSeats === table.maxSeats
          ? `${table.maxSeats}`
          : `${table.minSeats}–${table.maxSeats}`,
      // A table is available whenever the room is; there is no such thing as a
      // table's own shift.
      shift: hours,
    }));
  }
  return (location.salon?.staff ?? []).map((person) => ({
    id: person.id,
    name: person.name,
    group: person.role,
    shift: staffWorkingRanges(person, date),
  }));
}

/** The window the grid draws, widened to cover anything booked outside it. */
function boundsFor(location: Location, date: string, bookings: Booking[]): [Minutes, Minutes] {
  const ranges = openHours(location, date);

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

/**
 * Holes in one column's shift, once everything booked into it is taken out.
 *
 * For a diary this uses the *practitioner's* busy stretches rather than the
 * appointment spans, so a processing gap shows up as exactly what it is:
 * sellable time in the middle of a booking.
 */
function gapsIn(
  location: Location,
  column: { id: string; name: string; shift: TimeRange[] },
  busy: TimeRange[],
  /**
   * Restricts what this column could take. Absent means anything on the list.
   *
   * It is never absent on the room axis, and that is the point: a whitening
   * lamp standing idle all afternoon is not a root canal's worth of lost
   * revenue, however long the gap is, and a number arrived at that way is one
   * the practice stops believing after the first look.
   */
  eligible?: (service: SalonService) => boolean,
): Gap[] {
  const config = location.salon;
  // What could be sold into a hole, not merely what would physically fit. The
  // shortest thing on the list is usually a patch test or a consultation,
  // both of which are free — pricing every gap at nothing would make the whole
  // number useless, which is the sort of metric a venue stops looking at.
  const sellable = (config?.services ?? [])
    .filter((s) => !s.addOnOnly && s.price > 0 && (!eligible || eligible(s)))
    .map((s) => ({ name: s.name, minutes: s.durationMin + s.bufferMin, price: s.price }))
    .sort((a, b) => b.price - a.price || a.minutes - b.minutes);

  const sorted = busy.slice().sort((a, b) => a.start - b.start);
  const out: Gap[] = [];

  for (const range of column.shift) {
    let cursor = range.start;
    for (const block of sorted) {
      if (block.end <= cursor || block.start >= range.end) continue;
      if (block.start > cursor) push(cursor, Math.min(block.start, range.end));
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < range.end) push(cursor, range.end);
  }

  function push(start: Minutes, end: Minutes) {
    const minutes = end - start;
    if (minutes < MIN_SELLABLE_GAP) return;
    const fits = sellable.find((s) => s.minutes <= minutes) ?? null;
    out.push({
      columnId: column.id,
      columnName: column.name,
      startMin: start,
      endMin: end,
      minutes,
      fits: fits?.name,
      // What could actually be sold into it, not what the empty minutes would
      // theoretically be worth — a 90-minute hole that only fits one 40-minute
      // service is worth two of them, and a 25-minute one is worth whatever
      // the best 25-minute thing on the list is.
      value: fits ? fits.price * Math.floor(minutes / fits.minutes) : 0,
    });
  }

  return out;
}

export function dayView(location: Location, date: string): DayView {
  const bookings = listBookings({ locationId: location.id })
    .filter((b) => b.date === date && b.status === "confirmed")
    .sort((a, b) => a.startMin - b.startMin);

  const bare = columnsFor(location, date);
  const byId = new Set(bare.map((c) => c.id));
  const [openMin, closeMin] = boundsFor(location, date, bookings);
  const config = location.salon;

  const blocks: Block[] = [];
  const unplaced: Booking[] = [];
  const busyByColumn = new Map<string, TimeRange[]>();
  let revenue = 0;

  for (const booking of bookings) {
    // A restaurant booking can hold two tables; it draws in both columns.
    const ids = isRestaurant(location)
      ? (booking.tableIds ?? []).filter((id) => byId.has(id))
      : booking.staffId && byId.has(booking.staffId)
        ? [booking.staffId]
        : [];

    if (config) {
      const staff = config.staff.find((s) => s.id === booking.staffId);
      revenue += serviceShape(config, booking.serviceIds ?? [], { staff }).price;
    }

    if (ids.length === 0) {
      unplaced.push(booking);
      continue;
    }

    const busy = config ? bookingStaffBusy(config, booking) : undefined;

    for (const columnId of ids) {
      blocks.push({
        booking,
        columnId,
        startMin: booking.startMin,
        // For a diary the stored end already includes the buffer; the guest
        // was told the shorter time, so the two are drawn separately.
        endMin: guestEnd(location, booking),
        bufferEndMin: booking.endMin,
        // One interval covering the whole block tells the reader nothing they
        // cannot see from the block itself; only a real gap is worth drawing.
        busy: busy && busy.length > 1 ? busy : undefined,
        title: titleFor(location, booking),
        detail: detailFor(location, booking),
        arrived: Boolean(booking.service?.arrivedAt),
        seated: Boolean(booking.service?.seatedAt),
        depositDue: booking.deposit?.status === "required",
      });

      const held = busyByColumn.get(columnId) ?? [];
      // The restaurant grid has no phases: the table is gone for the turn.
      held.push(
        ...(busy && !isRestaurant(location)
          ? busy
          : [{ start: booking.startMin, end: booking.endMin }]),
      );
      busyByColumn.set(columnId, held);
    }

    // The second person on an appointment is busy too, and a dentist who looks
    // free during every hygiene visit is the whole reason this was modelled.
    if (booking.secondaryStaffId && byId.has(booking.secondaryStaffId) && config) {
      const held = busyByColumn.get(booking.secondaryStaffId) ?? [];
      const shape = serviceShape(config, booking.serviceIds ?? []);
      for (const need of shape.secondary) {
        held.push({
          start: booking.startMin + need.start,
          end: booking.startMin + need.end,
        });
      }
      busyByColumn.set(booking.secondaryStaffId, held);
    }
  }

  const offBlocks: OffBlock[] = [];
  for (const block of location.restaurant?.blocks ?? []) {
    if (block.date !== date) continue;
    for (const tableId of block.tableIds) {
      if (!byId.has(tableId)) continue;
      offBlocks.push({
        columnId: tableId,
        startMin: block.startMin,
        endMin: block.endMin,
        reason: block.reason,
      });
      const held = busyByColumn.get(tableId) ?? [];
      held.push({ start: block.startMin, end: block.endMin });
      busyByColumn.set(tableId, held);
    }
  }

  const columns: Column[] = bare.map((column) => {
    const availableMin = rangeMinutes(column.shift);
    const soldMin =
      config && !isRestaurant(location)
        ? soldMinutes(config, bookings, column.id)
        : rangeMinutes(busyByColumn.get(column.id) ?? []);
    return {
      ...column,
      availableMin,
      soldMin: Math.min(soldMin, availableMin || soldMin),
      utilisation: availableMin > 0 ? Math.min(1, soldMin / availableMin) : 0,
    };
  });

  // Only where a gap means something. An empty table between two sittings is
  // not lost revenue — it is how a restaurant works, and a list saying table
  // four has been free since noon would be scrolled past forever. What a
  // restaurant wants from this grid is pacing, which is already above it.
  const gaps = isRestaurant(location)
    ? []
    : columns
        .flatMap((column) => gapsIn(location, column, busyByColumn.get(column.id) ?? []))
        .sort((a, b) => b.minutes - a.minutes);

  const totalAvailable = columns.reduce((n, c) => n + c.availableMin, 0);
  const totalSold = columns.reduce((n, c) => n + c.soldMin, 0);

  return {
    date,
    openMin,
    closeMin,
    columns,
    blocks,
    offBlocks,
    nowMin: date === todayIn(location.timezone) ? nowMinutesIn(location.timezone) : null,
    unplaced,
    covers: bookings.reduce((n, b) => n + (b.partySize ?? 0), 0),
    appointments: bookings.length,
    utilisation: totalAvailable > 0 ? Math.min(1, totalSold / totalAvailable) : 0,
    gaps,
    revenue,
    pacing: pacingFor(location, bookings, openMin, closeMin),
  };
}

/**
 * The same day, down the other axis: rooms, chairs and machines.
 *
 * A practice manager's question is not "is Dr Haddad free at two", it is "is
 * surgery two free at two" — the constraint that actually binds in a clinic is
 * almost always the room, and a diary that can only be read by practitioner
 * cannot answer it. Same grid, same arithmetic, different columns.
 */
export function resourceView(location: Location, date: string): DayView {
  const config = location.salon;
  const view = dayView(location, date);
  if (!config || config.resources.length === 0) {
    return { ...view, columns: [], blocks: [], gaps: [] };
  }

  const hours = openHours(location, date);
  const bookings = listBookings({ locationId: location.id }).filter(
    (b) => b.date === date && b.status === "confirmed",
  );

  const columns: Column[] = config.resources.map((resource) => {
    const down = (resource.outOfService ?? []).filter((o) => o.date === date);
    const shift = down.length
      ? hours.flatMap((r) => cutOut(r, down))
      : hours.map((r) => ({ ...r }));
    const availableMin = rangeMinutes(shift) * (resource.capacity ?? 1);
    const soldMin = bookings
      .filter((b) => resourcesOf(b).includes(resource.id))
      .reduce((n, b) => n + (b.endMin - b.startMin), 0);
    return {
      id: resource.id,
      name: resource.name,
      group: humanise(resource.type),
      capacity: (resource.capacity ?? 1) > 1 ? `×${resource.capacity}` : undefined,
      shift,
      availableMin,
      soldMin: Math.min(soldMin, availableMin || soldMin),
      utilisation: availableMin > 0 ? Math.min(1, soldMin / availableMin) : 0,
    };
  });

  const blocks = view.blocks.flatMap((block) =>
    resourcesOf(block.booking).map((resourceId) => ({ ...block, columnId: resourceId, busy: undefined })),
  );

  const busyByColumn = new Map<string, TimeRange[]>();
  for (const block of blocks) {
    const held = busyByColumn.get(block.columnId) ?? [];
    held.push({ start: block.booking.startMin, end: block.booking.endMin });
    busyByColumn.set(block.columnId, held);
  }

  const typeOf = new Map(config.resources.map((r) => [r.id, r.type]));

  return {
    ...view,
    columns,
    blocks,
    gaps: columns
      .flatMap((column) =>
        gapsIn(location, column, busyByColumn.get(column.id) ?? [], (service) =>
          resourceTypesOf(service).includes(typeOf.get(column.id) ?? ""),
        ),
      )
      .sort((a, b) => b.minutes - a.minutes),
  };
}

/** `treatment_room` → `Treatment room`. Config keys are not labels. */
function humanise(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function resourcesOf(booking: Booking): string[] {
  return booking.resourceIds ?? (booking.resourceId ? [booking.resourceId] : []);
}

function cutOut(range: TimeRange, blocks: TimeRange[]): TimeRange[] {
  let out = [{ ...range }];
  for (const block of blocks) {
    const next: TimeRange[] = [];
    for (const r of out) {
      if (block.end <= r.start || block.start >= r.end) {
        next.push(r);
        continue;
      }
      if (block.start > r.start) next.push({ start: r.start, end: block.start });
      if (block.end < r.end) next.push({ start: block.end, end: r.end });
    }
    out = next;
  }
  return out;
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
  const book = listBookings({ locationId: location.id });
  const out: WeekDay[] = [];

  for (let i = 0; i < 7; i++) {
    const date = shiftDate(from, i);
    const weekday = weekdayOf(date);
    const ranges = location.hours[weekday] ?? [];
    const closed = ranges.length === 0 || location.closures.includes(date);

    const bookings = book.filter((b) => b.date === date && b.status === "confirmed");
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
    } else if (location.salon) {
      // A diary is full when its people are. Minutes sold against minutes
      // rostered is the only measure that survives different service lengths —
      // and it counts the practitioner's real occupancy, so a morning of
      // colour with the gaps sold does not read as over 100%.
      const available = location.salon.staff.reduce(
        (total, person) => total + rangeMinutes(staffWorkingRanges(person, date)),
        0,
      );
      const sold = location.salon.staff.reduce(
        (total, person) => total + soldMinutes(location.salon!, bookings, person.id),
        0,
      );
      load = available > 0 ? Math.min(1, sold / available) : 0;
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
  const config = location.salon;
  if (!config) return booking.endMin;
  const staff = config.staff.find((s) => s.id === booking.staffId);
  const shape = serviceShape(config, booking.serviceIds ?? [], { staff });
  return shape.durationMin > 0 ? booking.startMin + shape.durationMin : booking.endMin;
}
