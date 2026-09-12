import type {
  AvailabilityQuery,
  Booking,
  Location,
  Minutes,
  RestaurantConfig,
  Section,
  ServiceWindow,
  Slot,
  Table,
  TimeRange,
} from "../types";
import { weekdayOf } from "../time";

/**
 * Restaurant availability.
 *
 * Five constraints have to hold at once, and skipping any one of them is how
 * an AI booking system earns a venue's distrust in week one:
 *
 *   1. A physical table, or a combination that can actually be pushed
 *      together, that fits the party.
 *   2. That table free for the whole turn — which grows with party size — plus
 *      the minutes it takes to clear and re-lay it afterwards.
 *   3. Kitchen pacing: a cap on covers seated per slot, independent of how
 *      many tables happen to be empty, and different for a Saturday brunch
 *      than for a Tuesday lunch.
 *   4. The section's own limits. A terrace closes when it rains, a bar paces
 *      differently because the kitchen barely touches it, and the private room
 *      is something the venue sells rather than something a caller may take.
 *   5. Whatever the floor has been held back for — a table out of play, covers
 *      kept for walk-ins.
 */

export interface Assignment {
  tableIds: string[];
  startMin: Minutes;
  endMin: Minutes;
  /** When the table is genuinely free again, cleared and re-laid. */
  resetEndMin: Minutes;
  section: string;
  /** True when the table is bigger than the party needed. Used for ranking. */
  wastedSeats: number;
}

export type Unavailable =
  | { ok: false; reason: "closed"; detail: string }
  | { ok: false; reason: "outside_service"; detail: string }
  | { ok: false; reason: "party_too_large"; detail: string }
  | { ok: false; reason: "no_table"; detail: string }
  | { ok: false; reason: "pacing"; detail: string };

export function turnTimeFor(
  config: RestaurantConfig,
  service: ServiceWindow,
  partySize: number,
): number {
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

function sectionOf(config: RestaurantConfig, id: string): Section | undefined {
  return config.sections?.find((s) => s.id === id);
}

/** Bookings that still hold a table on the given date. */
function activeBookings(bookings: Booking[], date: string, excludeId?: string): Booking[] {
  return bookings.filter(
    (b) => b.date === date && b.status === "confirmed" && b.id !== excludeId,
  );
}

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Which tables are genuinely available for this window.
 *
 * Occupancy runs past the end of a turn by `resetMinutes`, in both directions:
 * a table cannot be promised to the next party before it has been cleared, and
 * the party after that cannot be slotted in before this one's own reset. The
 * old engine compared bare turns, which is how a booking system promises
 * 21:30 on a table whose 20:00 sitting is still putting their coats on.
 */
function tablesFreeAt(
  config: RestaurantConfig,
  bookings: Booking[],
  window: TimeRange,
  date: string,
): Table[] {
  const reset = config.resetMinutes ?? 0;
  const wanted = { start: window.start, end: window.end + reset };
  const busy = new Set<string>();

  for (const b of bookings) {
    if (!overlaps(wanted, { start: b.startMin, end: b.endMin + reset })) continue;
    for (const t of b.tableIds ?? []) busy.add(t);
  }

  for (const block of config.blocks ?? []) {
    if (block.date !== date) continue;
    if (!overlaps(wanted, { start: block.startMin, end: block.endMin })) continue;
    for (const t of block.tableIds) busy.add(t);
  }

  return config.tables.filter((t) => !busy.has(t.id));
}

/**
 * Can these tables actually be pushed together?
 *
 * `combinesWith` is a floor plan talking. Where a venue has not drawn one, the
 * old rule applies — same section, and trust the host — because inventing
 * adjacency the venue never stated would be worse than the assumption it has
 * lived with.
 */
function combinable(tables: Table[], section: Section | undefined): boolean {
  if (section?.combinable === false) return false;
  return tables.every((table) => {
    const allowed = table.combinesWith;
    if (!allowed) return true;
    return tables.every((other) => other.id === table.id || allowed.includes(other.id));
  });
}

/**
 * Pick the tightest fit.
 *
 * Seating a two-top at a table for six on a Saturday costs the venue four
 * covers, so we always burn the smallest table that works, and only combine
 * when nothing single fits. Between equal fits, the venue's own preference
 * order wins — that is where "fill the bar before you open the terrace" lives.
 */
function chooseTables(
  config: RestaurantConfig,
  free: Table[],
  partySize: number,
): { ids: string[]; section: string; waste: number } | null {
  const rank = (t: Table) => -(t.priority ?? sectionOf(config, t.section)?.priority ?? 0);

  const singles = free
    .filter((t) => partySize >= t.minSeats && partySize <= t.maxSeats)
    .sort(
      (a, b) =>
        a.maxSeats - b.maxSeats || rank(a) - rank(b) || a.name.localeCompare(b.name),
    );
  if (singles.length > 0) {
    return {
      ids: [singles[0].id],
      section: singles[0].section,
      waste: singles[0].maxSeats - partySize,
    };
  }

  const bySection = new Map<string, Table[]>();
  for (const t of free) {
    const list = bySection.get(t.section) ?? [];
    list.push(t);
    bySection.set(t.section, list);
  }

  // Three is as far as anyone pushes tables together in practice, and the
  // search is exhaustive, so the cap is what keeps it cheap on a floor with a
  // lot of small tables free.
  const maxCombine = Math.max(2, Math.min(config.maxCombine ?? 2, 3));
  let best: { ids: string[]; section: string; waste: number } | null = null;

  for (const [sectionId, group] of bySection) {
    const section = sectionOf(config, sectionId);
    if (section?.combinable === false) continue;
    const sorted = group.slice().sort((a, b) => rank(a) - rank(b) || a.maxSeats - b.maxSeats);

    const consider = (combo: Table[]) => {
      const capacity = combo.reduce((n, t) => n + t.maxSeats, 0);
      if (capacity < partySize) return;
      // The smallest table still has to be worth laying: a party of seven on a
      // six and a two is fine, on a six and a ten is two wasted covers and a
      // room that looks empty.
      if (partySize < Math.min(...combo.map((t) => t.minSeats))) return;
      if (!combinable(combo, section)) return;
      const waste = capacity - partySize;
      if (
        !best ||
        waste < best.waste ||
        (waste === best.waste && combo.length < best.ids.length)
      ) {
        best = { ids: combo.map((t) => t.id), section: sectionId, waste };
      }
    };

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        consider([sorted[i], sorted[j]]);
        if (maxCombine < 3) continue;
        for (let k = j + 1; k < sorted.length; k++) consider([sorted[i], sorted[j], sorted[k]]);
      }
    }
  }

  return best;
}

/** Covers already seated in the slot bucket containing `startMin`. */
function coversInSlot(
  config: RestaurantConfig,
  bookings: Booking[],
  startMin: Minutes,
  where?: (b: Booking) => boolean,
): number {
  const bucket = Math.floor(startMin / config.slotMinutes);
  return bookings
    .filter(
      (b) =>
        Math.floor(b.startMin / config.slotMinutes) === bucket && (!where || where(b)),
    )
    .reduce((sum, b) => sum + (b.partySize ?? 0), 0);
}

/**
 * Sections this party may be seated in, given who is asking and what is
 * already going into each one this slot.
 */
function openSections(
  config: RestaurantConfig,
  bookings: Booking[],
  query: { date: string; startMin: Minutes; partySize: number; staffOverride?: boolean },
): Set<string> | null {
  const sections = config.sections;
  if (!sections || sections.length === 0) return null;

  const tablesIn = new Map<string, Set<string>>();
  for (const table of config.tables) {
    const set = tablesIn.get(table.section) ?? new Set<string>();
    set.add(table.id);
    tablesIn.set(table.section, set);
  }

  const open = new Set<string>();
  for (const section of sections) {
    if (section.closedOn?.includes(query.date)) continue;
    if (section.online === false && !query.staffOverride) continue;

    if (section.maxCoversPerSlot !== undefined) {
      const ids = tablesIn.get(section.id) ?? new Set<string>();
      const seated = coversInSlot(config, bookings, query.startMin, (b) =>
        (b.tableIds ?? []).some((t) => ids.has(t)),
      );
      if (seated + query.partySize > section.maxCoversPerSlot) continue;
    }
    open.add(section.id);
  }

  // Tables in a section nobody has configured are not thereby unbookable —
  // a venue that describes two of its five sections has not closed the other
  // three.
  for (const table of config.tables) {
    if (!sections.some((s) => s.id === table.section)) open.add(table.section);
  }
  return open;
}

export interface RestaurantQuery {
  date: string;
  startMin: Minutes;
  partySize: number;
  excludeBookingId?: string;
  /**
   * A manager seating past the pacing cap on purpose.
   *
   * Never set from the phone line. Pacing exists so the pass survives eight
   * o'clock, and the caller is the last person who should be able to overrule
   * it — but a manager who can see two tables putting their coats on is making
   * a judgement the software cannot.
   */
  overbook?: boolean;
  /**
   * A person working the book rather than a caller on the line. Opens the
   * tables and sections the venue does not sell online, and ignores the covers
   * held back for walk-ins.
   */
  staffOverride?: boolean;
}

/**
 * Can this exact time be booked? Returns the table assignment or a structured
 * reason. The reason matters: the agent says something different for "we're
 * closed Mondays" than for "8pm is full but 8:45 is open".
 */
export function checkRestaurantSlot(
  location: Location,
  bookings: Booking[],
  query: RestaurantQuery,
): { ok: true; assignment: Assignment } | Unavailable {
  const config = location.restaurant!;
  const { date, startMin, partySize } = query;

  if (location.closures.includes(date)) {
    return { ok: false, reason: "closed", detail: "The venue is closed on that date." };
  }
  if (partySize > config.maxPartySize) {
    return { ok: false, reason: "party_too_large", detail: config.largePartyPolicy };
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
              .map(
                (s) =>
                  `${s.name} until ${Math.floor(s.lastSeating / 60)}:${String(s.lastSeating % 60).padStart(2, "0")}`,
              )
              .join(", ")}.`,
    };
  }

  const turn = turnTimeFor(config, service, partySize);
  const endMin = startMin + turn;
  const dayBookings = activeBookings(bookings, date, query.excludeBookingId);

  const seated = coversInSlot(config, dayBookings, startMin);
  // An overbooking allowance is a manager's, and it is finite: it raises the
  // ceiling, it does not remove it. The walk-in holdback pulls the other way —
  // covers a venue keeps for the door, invisible to the phone.
  const base = service.maxCoversPerSlot ?? config.maxCoversPerSlot;
  const holdback = query.staffOverride ? 0 : (service.walkInHoldback ?? 0);
  const ceiling =
    base - holdback + (query.overbook ? (config.overbookPerSlot ?? 0) : 0);
  if (seated + partySize > ceiling) {
    return {
      ok: false,
      reason: "pacing",
      detail: "That exact time is at capacity for the kitchen.",
    };
  }

  const open = openSections(config, dayBookings, query);
  let free = tablesFreeAt(config, dayBookings, { start: startMin, end: endMin }, date);
  if (open) free = free.filter((t) => open.has(t.section));
  if (!query.staffOverride) free = free.filter((t) => t.online !== false);

  const chosen = chooseTables(config, free, partySize);
  if (!chosen) {
    return { ok: false, reason: "no_table", detail: "No table of that size is free then." };
  }

  return {
    ok: true,
    assignment: {
      tableIds: chosen.ids,
      startMin,
      endMin,
      resetEndMin: endMin + (config.resetMinutes ?? 0),
      section: chosen.section,
      wastedSeats: chosen.waste,
    },
  };
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
      staffOverride: query.staffOverride,
    });
    if (result.ok) {
      slots.push({
        date: query.date,
        startMin,
        endMin: result.assignment.endMin,
        tableIds: result.assignment.tableIds,
        section: result.assignment.section,
      });
      if (slots.length >= limit) break;
    }
  }

  return slots.sort((a, b) => a.startMin - b.startMin);
}

/**
 * Seats in the room, section by section. The honest denominator for "how full
 * are we" — a restaurant is full when the seats are gone, not when the slots
 * are.
 */
export function seatsBySection(config: RestaurantConfig): Map<string, number> {
  const out = new Map<string, number>();
  for (const table of config.tables) {
    out.set(table.section, (out.get(table.section) ?? 0) + table.maxSeats);
  }
  return out;
}
