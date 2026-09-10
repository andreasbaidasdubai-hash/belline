import type {
  AvailabilityQuery,
  Booking,
  Location,
  Minutes,
  RestaurantConfig,
  ServiceWindow,
  Slot,
  Table,
} from "../types";
import { weekdayOf } from "../time";

/**
 * Restaurant availability.
 *
 * Three constraints have to hold at once, and skipping any one of them is how
 * an AI booking system earns a venue's distrust in week one:
 *
 *   1. A physical table (or a valid combination) that fits the party.
 *   2. That table free for the whole turn time — which grows with party size.
 *   3. Kitchen pacing — a cap on covers seated per slot, independent of how
 *      many tables happen to be empty.
 */

export interface Assignment {
  tableIds: string[];
  startMin: Minutes;
  endMin: Minutes;
}

export type Unavailable =
  | { ok: false; reason: "closed"; detail: string }
  | { ok: false; reason: "outside_service"; detail: string }
  | { ok: false; reason: "party_too_large"; detail: string }
  | { ok: false; reason: "no_table"; detail: string }
  | { ok: false; reason: "pacing"; detail: string };

export function turnTimeFor(config: RestaurantConfig, service: ServiceWindow, partySize: number): number {
  for (const t of service.turnTimes) {
    if (partySize <= t.upTo) return t.minutes;
  }
  return service.turnTimes[service.turnTimes.length - 1]?.minutes ?? 90;
}

export function serviceFor(
  config: RestaurantConfig,
  weekday: number,
  startMin: Minutes,
): ServiceWindow | undefined {
  return config.services.find(
    (s) => s.days.includes(weekday) && startMin >= s.start && startMin <= s.lastSeating,
  );
}

export function servicesOn(config: RestaurantConfig, weekday: number): ServiceWindow[] {
  return config.services.filter((s) => s.days.includes(weekday));
}

/** Bookings that still hold a table on the given date. */
function activeBookings(bookings: Booking[], date: string, excludeId?: string): Booking[] {
  return bookings.filter(
    (b) =>
      b.date === date &&
      b.status === "confirmed" &&
      b.id !== excludeId,
  );
}

function tablesFreeAt(
  tables: Table[],
  bookings: Booking[],
  startMin: Minutes,
  endMin: Minutes,
): Table[] {
  const busy = new Set<string>();
  for (const b of bookings) {
    if (b.startMin < endMin && startMin < b.endMin) {
      for (const t of b.tableIds ?? []) busy.add(t);
    }
  }
  return tables.filter((t) => !busy.has(t.id));
}

/**
 * Pick the tightest fit. Seating a two-top at a table for six on a Saturday
 * costs the venue four covers, so we always burn the smallest table that
 * works and only combine when nothing single fits.
 */
function chooseTables(free: Table[], partySize: number): string[] | null {
  const singles = free
    .filter((t) => partySize >= t.minSeats && partySize <= t.maxSeats)
    .sort((a, b) => a.maxSeats - b.maxSeats || a.name.localeCompare(b.name));
  if (singles.length > 0) return [singles[0].id];

  // Combinations: same section only — you cannot push the terrace table into
  // the main room. Pairs cover essentially every real large-party case.
  const bySection = new Map<string, Table[]>();
  for (const t of free) {
    const list = bySection.get(t.section) ?? [];
    list.push(t);
    bySection.set(t.section, list);
  }

  let best: { ids: string[]; waste: number } | null = null;
  for (const group of bySection.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const capacity = group[i].maxSeats + group[j].maxSeats;
        const floor = group[i].minSeats;
        if (capacity < partySize || partySize < floor) continue;
        const waste = capacity - partySize;
        if (!best || waste < best.waste) {
          best = { ids: [group[i].id, group[j].id], waste };
        }
      }
    }
  }
  return best?.ids ?? null;
}

/** Covers already seated in the slot bucket containing `startMin`. */
function coversInSlot(
  config: RestaurantConfig,
  bookings: Booking[],
  startMin: Minutes,
): number {
  const bucket = Math.floor(startMin / config.slotMinutes);
  return bookings
    .filter((b) => Math.floor(b.startMin / config.slotMinutes) === bucket)
    .reduce((sum, b) => sum + (b.partySize ?? 0), 0);
}

/**
 * Can this exact time be booked? Returns the table assignment or a structured
 * reason. The reason matters: the agent says something different for "we're
 * closed Mondays" than for "8pm is full but 8:45 is open".
 */
export function checkRestaurantSlot(
  location: Location,
  bookings: Booking[],
  query: { date: string; startMin: Minutes; partySize: number; excludeBookingId?: string },
): { ok: true; assignment: Assignment } | Unavailable {
  const config = location.restaurant!;
  const { date, startMin, partySize } = query;

  if (location.closures.includes(date)) {
    return { ok: false, reason: "closed", detail: "The venue is closed on that date." };
  }
  if (partySize > config.maxPartySize) {
    return {
      ok: false,
      reason: "party_too_large",
      detail: config.largePartyPolicy,
    };
  }

  const weekday = weekdayOf(date);
  const service = serviceFor(config, weekday, startMin);
  if (!service) {
    const open = servicesOn(config, weekday);
    return {
      ok: false,
      reason: open.length === 0 ? "closed" : "outside_service",
      detail:
        open.length === 0
          ? "The venue is closed that day."
          : `Seatings that day run ${open
              .map((s) => `${s.name} until ${Math.floor(s.lastSeating / 60)}:${String(s.lastSeating % 60).padStart(2, "0")}`)
              .join(", ")}.`,
    };
  }

  const turn = turnTimeFor(config, service, partySize);
  const endMin = startMin + turn;
  const dayBookings = activeBookings(bookings, date, query.excludeBookingId);

  const seated = coversInSlot(config, dayBookings, startMin);
  if (seated + partySize > config.maxCoversPerSlot) {
    return {
      ok: false,
      reason: "pacing",
      detail: "That exact time is at capacity for the kitchen.",
    };
  }

  const free = tablesFreeAt(config.tables, dayBookings, startMin, endMin);
  const tableIds = chooseTables(free, partySize);
  if (!tableIds) {
    return { ok: false, reason: "no_table", detail: "No table of that size is free then." };
  }

  return { ok: true, assignment: { tableIds, startMin, endMin } };
}

/** Bookable times near the caller's preference, nearest first. */
export function searchRestaurant(
  location: Location,
  bookings: Booking[],
  query: AvailabilityQuery,
  limit = 6,
): Slot[] {
  const config = location.restaurant!;
  const partySize = query.partySize ?? 2;
  const weekday = weekdayOf(query.date);
  const windowMin = query.windowMin ?? 120;

  const candidates: Minutes[] = [];
  for (const service of servicesOn(config, weekday)) {
    for (let t = service.start; t <= service.lastSeating; t += config.slotMinutes) {
      if (query.preferredMin !== undefined && Math.abs(t - query.preferredMin) > windowMin) {
        continue;
      }
      candidates.push(t);
    }
  }

  if (query.preferredMin !== undefined) {
    candidates.sort(
      (a, b) => Math.abs(a - query.preferredMin!) - Math.abs(b - query.preferredMin!) || a - b,
    );
  }

  const slots: Slot[] = [];
  for (const startMin of candidates) {
    const result = checkRestaurantSlot(location, bookings, {
      date: query.date,
      startMin,
      partySize,
      excludeBookingId: query.excludeBookingId,
    });
    if (result.ok) {
      slots.push({
        date: query.date,
        startMin,
        endMin: result.assignment.endMin,
        tableIds: result.assignment.tableIds,
      });
      if (slots.length >= limit) break;
    }
  }

  return slots.sort((a, b) => a.startMin - b.startMin);
}
