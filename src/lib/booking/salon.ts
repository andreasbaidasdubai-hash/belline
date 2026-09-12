import type {
  AvailabilityQuery,
  Booking,
  Location,
  Minutes,
  Resource,
  SalonConfig,
  SalonService,
  Slot,
  StaffMember,
  TimeRange,
} from "../types";
import { weekdayOf } from "../time";
import {
  bookingSecondaryBusy,
  bookingStaffBusy,
  durationFor,
  priceFor,
  rangeMinutes,
  resolveServices,
  resourceTypesOf,
  serviceShape,
  shiftRanges,
  type ServiceShape,
} from "./services";

/**
 * Salon / clinic availability.
 *
 * The shape of the problem is different from a restaurant: instead of a table
 * free for a fixed turn, you need the right qualified person free for the
 * parts of the appointment they are actually needed for, plus every piece of
 * shared equipment it uses, plus the cleanup after it — and sometimes a second
 * person who walks in ten minutes from the end.
 *
 * Three things here are what separate this from a calendar with names across
 * the top, and each is worth stating because none is obvious from the code:
 *
 *   1. **Staff time is a set of intervals, not a span.** A colour develops for
 *      forty minutes with nobody standing over it. `services.ts` produces
 *      those intervals; this file does set arithmetic against them. With
 *      `dovetail` on, another client goes in the gap — which is the difference
 *      between a colourist taking three clients in a morning and taking two.
 *   2. **The room is not the person.** Resources are held for the whole block
 *      regardless, because the client is sitting in the chair the entire time.
 *   3. **Who gets the work is a business decision.** Spreading it keeps a
 *      commission team happy; packing it sells more hours. The venue chooses;
 *      `SalonConfig.assignment` is that choice and the default is what this
 *      engine always did.
 */

export interface SalonAssignment {
  staffId: string;
  staffName: string;
  resourceId?: string;
  /** Every resource held. `resourceId` is the first of these, for compatibility. */
  resourceIds: string[];
  secondaryStaffId?: string;
  secondaryStaffName?: string;
  startMin: Minutes;
  /** End of the guest-facing appointment (buffer excluded). */
  endMin: Minutes;
  /** End of the block held in the diary (buffer included). */
  blockEndMin: Minutes;
  serviceIds: string[];
  durationMin: number;
  price: number;
  /** Absolute clock stretches where this person is actually occupied. */
  staffBusy: TimeRange[];
  /** True when a first-visit duration was used rather than the list one. */
  newGuestTiming: boolean;
}

export type SalonUnavailable =
  | { ok: false; reason: "closed"; detail: string }
  | { ok: false; reason: "unknown_service"; detail: string }
  | { ok: false; reason: "not_bookable"; detail: string }
  | { ok: false; reason: "no_staff"; detail: string }
  | { ok: false; reason: "staff_busy"; detail: string }
  | { ok: false; reason: "no_resource"; detail: string }
  | { ok: false; reason: "no_secondary"; detail: string };

export interface SalonQuery {
  date: string;
  startMin: Minutes;
  serviceIds: string[];
  staffId?: string;
  excludeBookingId?: string;
  /** First visit here: switches services to their first-visit duration. */
  newGuest?: boolean;
  /** A person working the diary. Lifts the rules aimed at the agent only. */
  staffOverride?: boolean;
}

// Re-exported because half the product imports them from here, and moving the
// implementation into services.ts should not have been a breaking change.
export { resolveServices };

/**
 * List-price timing for a chain of services.
 *
 * Kept for the read-back helpers, which describe a booking to a guest and have
 * no staff member in hand. Anything deciding whether an appointment *fits*
 * must use `serviceShape`, which knows whose hands it is in.
 */
export function chainDuration(services: SalonService[]): {
  durationMin: number;
  bufferMin: number;
  price: number;
} {
  return {
    durationMin: services.reduce((n, s) => n + s.durationMin, 0),
    // Only the last service's cleanup applies — you reset the station once.
    bufferMin: services.length ? services[services.length - 1].bufferMin : 0,
    price: services.reduce((n, s) => n + s.price, 0),
  };
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

/** Everything taken out of `ranges` by `blocks`, as ranges. */
function subtract(ranges: TimeRange[], blocks: TimeRange[]): TimeRange[] {
  let out = ranges.map((r) => ({ ...r }));
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

/**
 * When this person is actually on the floor.
 *
 * A rota entry for the date beats the weekly pattern outright, including an
 * empty one — "scheduled off" and "we have no pattern for you" are different
 * facts and the second must not silently become the first.
 */
export function staffWorkingRanges(staff: StaffMember, date: string): TimeRange[] {
  const weekday = weekdayOf(date);
  const rota = staff.shifts?.find((s) => s.date === date);
  const base = rota ? rota.ranges : (staff.hours[weekday] ?? []);
  if (base.length === 0) return [];

  const blocks: TimeRange[] = [
    ...(staff.breaks?.[weekday] ?? []),
    ...staff.timeOff.filter((t) => t.date === date),
  ];
  return blocks.length === 0 ? base.map((r) => ({ ...r })) : subtract(base, blocks);
}

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function anyOverlap(a: TimeRange[], b: TimeRange[]): boolean {
  return a.some((x) => b.some((y) => overlaps(x, y)));
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

function resourceFree(
  resource: Resource,
  bookings: Booking[],
  block: TimeRange,
  date: string,
): boolean {
  const down = (resource.outOfService ?? []).filter((o) => o.date === date);
  if (down.some((o) => overlaps(block, o))) return false;

  const held = bookings.filter(
    (b) =>
      (b.resourceIds ?? (b.resourceId ? [b.resourceId] : [])).includes(resource.id) &&
      overlaps(block, { start: b.startMin, end: b.endMin }),
  ).length;
  return held < (resource.capacity ?? 1);
}

/**
 * One free resource of each type the appointment needs.
 *
 * The old engine took the first `resourceType` it found in the chain and
 * checked only that. A treatment needing a room *and* a machine passed the
 * check with the machine already in use, which is the kind of bug that is
 * invisible in a demo and unforgivable on a Tuesday.
 */
function assignResources(
  config: SalonConfig,
  bookings: Booking[],
  types: string[],
  block: TimeRange,
  date: string,
): { ok: true; ids: string[] } | { ok: false; type: string } {
  const ids: string[] = [];
  const taken = new Set<string>();

  for (const type of types) {
    const pool = config.resources.filter((r) => r.type === type && !taken.has(r.id));
    const free = pool.find((r) => resourceFree(r, bookings, block, date));
    if (!free) return { ok: false, type };
    taken.add(free.id);
    ids.push(free.id);
  }
  return { ok: true, ids };
}

// ---------------------------------------------------------------------------
// Who gets the work
// ---------------------------------------------------------------------------

function bookedMinutes(bookings: Booking[], staffId: string): number {
  return bookings
    .filter((b) => b.staffId === staffId)
    .reduce((n, b) => n + (b.endMin - b.startMin), 0);
}

/**
 * How much dead time giving this person this appointment would create.
 *
 * Lower is better. A person with nothing booked that day carries a penalty
 * because opening a fourth diary to take a haircut is exactly what packing is
 * meant to avoid — but a small one, because a team where one person never gets
 * a client is not a team for long.
 */
function gapCost(
  bookings: Booking[],
  staffId: string,
  block: TimeRange,
): number {
  const theirs = bookings
    .filter((b) => b.staffId === staffId)
    .sort((a, b) => a.startMin - b.startMin);
  if (theirs.length === 0) return 240;

  const before = theirs.filter((b) => b.endMin <= block.start).pop();
  const after = theirs.find((b) => b.startMin >= block.end);

  const gapBefore = before ? block.start - before.endMin : Infinity;
  const gapAfter = after ? after.startMin - block.end : Infinity;
  const nearest = Math.min(gapBefore, gapAfter);
  return Number.isFinite(nearest) ? nearest : 180;
}

function orderStaff(
  config: SalonConfig,
  candidates: StaffMember[],
  dayBookings: Booking[],
  block: TimeRange,
): StaffMember[] {
  if (config.assignment === "pack") {
    return candidates
      .slice()
      .sort(
        (a, b) =>
          gapCost(dayBookings, a.id, block) - gapCost(dayBookings, b.id, block) ||
          a.name.localeCompare(b.name),
      );
  }
  // Default: spread the day evenly rather than stacking everything on
  // whoever happens to come first in the list. Measured in minutes sold, not
  // appointments — six blow-dries is not the same day as two balayages.
  return candidates
    .slice()
    .sort(
      (a, b) =>
        bookedMinutes(dayBookings, a.id) - bookedMinutes(dayBookings, b.id) ||
        a.name.localeCompare(b.name),
    );
}

// ---------------------------------------------------------------------------

export function checkSalonSlot(
  location: Location,
  bookings: Booking[],
  query: SalonQuery,
): { ok: true; assignment: SalonAssignment } | SalonUnavailable {
  const config = location.salon!;

  if (location.closures.includes(query.date)) {
    return { ok: false, reason: "closed", detail: "We are closed on that date." };
  }

  const { services, missing } = resolveServices(config, query.serviceIds);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "unknown_service",
      detail: `Not on the service list: ${missing.join(", ")}.`,
    };
  }
  if (services.length === 0) {
    return { ok: false, reason: "unknown_service", detail: "No service was requested." };
  }

  if (!query.staffOverride) {
    const offline = services.find((s) => s.online === false);
    if (offline) {
      return {
        ok: false,
        reason: "not_bookable",
        detail: `${offline.name} has to be arranged with the team rather than booked straight in.`,
      };
    }
    // An add-on on its own is not a visit. Booking one alone produces a
    // fifteen-minute appointment for something that only exists attached to
    // something else, and a guest who turns up for it.
    if (services.length === 1 && services[0].addOnOnly) {
      return {
        ok: false,
        reason: "not_bookable",
        detail: `${services[0].name} is an add-on to another treatment rather than a visit on its own.`,
      };
    }
  }

  const serviceIds = services.map((s) => s.id);
  const dayBookings = bookings.filter(
    (b) =>
      b.date === query.date &&
      b.status === "confirmed" &&
      b.id !== query.excludeBookingId,
  );

  const qualified = config.staff.filter((person) => {
    if (query.staffId && person.id !== query.staffId) return false;
    if (!serviceIds.every((sid) => person.serviceIds.includes(sid))) return false;
    // A role on the service is a harder rule than the qualification list: an
    // aesthetician may be trained on a device a prescription treatment still
    // requires a doctor to sign off.
    if (services.some((s) => s.role && s.role !== person.role)) return false;
    // Somebody only bookable when asked for by name. Invisible to a search
    // that did not name them, available the moment one does.
    if (person.requestOnly && !query.staffId && !query.staffOverride) return false;
    return true;
  });

  if (qualified.length === 0) {
    return {
      ok: false,
      reason: "no_staff",
      detail: query.staffId
        ? "That team member does not offer all of those services."
        : "Nobody on the team offers that combination of services.",
    };
  }

  // Ordering needs a block and the block needs a duration, which depends on
  // who it is — so order against the list-price length and let the per-person
  // timing refine it inside the loop. The difference is minutes; the ordering
  // is a preference, not a constraint.
  const nominal = chainDuration(services);
  const ordered = orderStaff(config, qualified, dayBookings, {
    start: query.startMin,
    end: query.startMin + nominal.durationMin + nominal.bufferMin,
  });

  let sawWorkingStaff = false;
  let blockedResource: string | undefined;
  let missedSecondary = false;

  for (const staff of ordered) {
    const shape = serviceShape(config, serviceIds, { staff, newGuest: query.newGuest });
    const endMin = query.startMin + shape.durationMin;
    const blockEndMin = endMin + shape.bufferMin;
    const block: TimeRange = { start: query.startMin, end: blockEndMin };

    const ranges = staffWorkingRanges(staff, query.date);
    // The guest-facing appointment must sit inside the shift; the cleanup
    // buffer is allowed to run past the end of it.
    if (!ranges.some((r) => query.startMin >= r.start && endMin <= r.end)) continue;
    sawWorkingStaff = true;

    const wanted = shiftRanges(shape.staffBusy, query.startMin);
    const theirs = dayBookings.filter((b) => b.staffId === staff.id);
    // With dovetailing off, a booking owns its whole span and the gap in it is
    // nobody's to use — which is what this engine did before phases existed,
    // and what a salon that has never heard of the idea expects to see.
    const busy = config.dovetail
      ? theirs.flatMap((b) => bookingStaffBusy(config, b))
      : theirs.map((b) => ({ start: b.startMin, end: b.endMin }));
    const asSecond = dayBookings
      .filter((b) => b.secondaryStaffId === staff.id)
      .flatMap((b) => bookingSecondaryBusy(config, b));

    if (anyOverlap(wanted, busy) || anyOverlap(wanted, asSecond)) continue;

    const resources = assignResources(
      config,
      dayBookings,
      shape.resourceTypes,
      block,
      query.date,
    );
    if (!resources.ok) {
      blockedResource = resources.type;
      continue;
    }

    let secondaryStaffId: string | undefined;
    let secondaryStaffName: string | undefined;
    if (shape.secondary.length > 0) {
      const helper = findSecondary(config, dayBookings, shape, query, staff);
      if (!helper) {
        missedSecondary = true;
        continue;
      }
      secondaryStaffId = helper.id;
      secondaryStaffName = helper.name;
    }

    return {
      ok: true,
      assignment: {
        staffId: staff.id,
        staffName: staff.name,
        resourceId: resources.ids[0],
        resourceIds: resources.ids,
        secondaryStaffId,
        secondaryStaffName,
        startMin: query.startMin,
        endMin,
        blockEndMin,
        serviceIds,
        durationMin: shape.durationMin,
        price: shape.price,
        staffBusy: wanted,
        newGuestTiming: shape.newGuestTiming,
      },
    };
  }

  if (blockedResource) {
    return {
      ok: false,
      reason: "no_resource",
      detail: `No ${blockedResource} is free at that time.`,
    };
  }
  if (missedSecondary) {
    return {
      ok: false,
      reason: "no_secondary",
      detail: `Nobody is free to cover the ${services.find((s) => s.secondary)?.secondary?.role ?? "second"} part of that appointment then.`,
    };
  }
  return {
    ok: false,
    reason: sawWorkingStaff ? "staff_busy" : "closed",
    detail: sawWorkingStaff
      ? "Fully booked at that time."
      : "Nobody who offers that is working then.",
  };
}

/**
 * The person who walks in partway through.
 *
 * Scheduled last and least fussily: a hygiene appointment does not need a
 * *particular* dentist, it needs *a* dentist for ten minutes, and the practice
 * would rather the hour was sold than that a preference was honoured. Whoever
 * is free and has the least of their day already committed gets it.
 */
function findSecondary(
  config: SalonConfig,
  dayBookings: Booking[],
  shape: ServiceShape,
  query: SalonQuery,
  primary: StaffMember,
): StaffMember | undefined {
  const windows = shape.secondary.map((s) => ({
    start: query.startMin + s.start,
    end: query.startMin + s.end,
  }));
  const roles = new Set(shape.secondary.map((s) => s.role));

  const candidates = config.staff
    .filter((p) => p.id !== primary.id && p.role && roles.has(p.role))
    .sort((a, b) => bookedMinutes(dayBookings, a.id) - bookedMinutes(dayBookings, b.id));

  return candidates.find((person) => {
    const ranges = staffWorkingRanges(person, query.date);
    if (!windows.every((w) => ranges.some((r) => w.start >= r.start && w.end <= r.end))) {
      return false;
    }
    const busy = dayBookings
      .filter((b) => b.staffId === person.id)
      .flatMap((b) => bookingStaffBusy(config, b));
    const asSecond = dayBookings
      .filter((b) => b.secondaryStaffId === person.id)
      .flatMap((b) => bookingSecondaryBusy(config, b));
    return !anyOverlap(windows, busy) && !anyOverlap(windows, asSecond);
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * The times worth trying.
 *
 * A fixed grid is the obvious answer and it is the reason diaries fragment: a
 * stylist frees up at 11:20, the grid only knows about 11:15 and 11:30, and
 * the twenty minutes either side are sold to nobody. So the moments each
 * person actually becomes free are candidates in their own right, which closes
 * gaps exactly rather than approximately.
 */
function candidateTimes(
  location: Location,
  config: SalonConfig,
  bookings: Booking[],
  query: AvailabilityQuery,
): Minutes[] {
  const weekday = weekdayOf(query.date);
  const openRanges = location.hours[weekday] ?? [];
  const out = new Set<Minutes>();

  for (const range of openRanges) {
    for (let t = range.start; t <= range.end; t += config.slotMinutes) out.add(t);
  }

  for (const booking of bookings) {
    if (booking.date !== query.date || booking.status !== "confirmed") continue;
    for (const busy of bookingStaffBusy(config, booking)) {
      if (openRanges.some((r) => busy.end >= r.start && busy.end <= r.end)) {
        out.add(busy.end);
      }
    }
  }

  const windowMin = query.windowMin ?? 240;
  return [...out].filter(
    (t) =>
      query.preferredMin === undefined || Math.abs(t - query.preferredMin) <= windowMin,
  );
}

export function searchSalon(
  location: Location,
  bookings: Booking[],
  query: AvailabilityQuery,
  limit = 6,
): Slot[] {
  const config = location.salon!;
  const weekday = weekdayOf(query.date);
  if ((location.hours[weekday] ?? []).length === 0) return [];
  if (location.closures.includes(query.date)) return [];

  const candidates = candidateTimes(location, config, bookings, query);
  if (query.preferredMin !== undefined) {
    candidates.sort(
      (a, b) => Math.abs(a - query.preferredMin!) - Math.abs(b - query.preferredMin!) || a - b,
    );
  } else {
    candidates.sort((a, b) => a - b);
  }

  const slots: Slot[] = [];
  const seen = new Set<string>();

  for (const startMin of candidates) {
    const result = checkSalonSlot(location, bookings, {
      date: query.date,
      startMin,
      serviceIds: query.serviceIds ?? [],
      staffId: query.staffId,
      excludeBookingId: query.excludeBookingId,
      newGuest: query.newGuest,
      staffOverride: query.staffOverride,
    });
    if (!result.ok) continue;

    // Two candidate times that resolve to the same minute with the same person
    // are one offer, however they were generated.
    const key = `${startMin}:${result.assignment.staffId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    slots.push({
      date: query.date,
      startMin,
      endMin: result.assignment.endMin,
      staffId: result.assignment.staffId,
      staffName: result.assignment.staffName,
      resourceId: result.assignment.resourceId,
      resourceIds: result.assignment.resourceIds,
      price: result.assignment.price,
    });
    if (slots.length >= limit) break;
  }

  return slots.sort((a, b) => a.startMin - b.startMin);
}

/**
 * What one service costs and how long it takes for a named person.
 *
 * The price list a guest is quoted on the phone, rather than the one on the
 * wall — the two differ the moment a salon prices by stylist level, and
 * quoting the wall price for a senior colourist is an argument at the till.
 */
export function quoteFor(
  config: SalonConfig,
  service: SalonService,
  staffId?: string,
): { durationMin: number; price: number } {
  const staff = staffId ? config.staff.find((s) => s.id === staffId) : undefined;
  return { durationMin: durationFor(service, { staff }), price: priceFor(service, { staff }) };
}

/** Minutes of a person's day already sold. Used by the calendar's utilisation. */
export function soldMinutes(
  config: SalonConfig,
  bookings: Booking[],
  staffId: string,
): number {
  return rangeMinutes(
    bookings
      .filter((b) => b.staffId === staffId && b.status === "confirmed")
      .flatMap((b) => bookingStaffBusy(config, b)),
  );
}

/** Every resource type the venue actually uses, for the calendar's room view. */
export function resourceTypes(config: SalonConfig): string[] {
  const out = new Set<string>();
  for (const resource of config.resources) out.add(resource.type);
  for (const service of config.services) {
    for (const type of resourceTypesOf(service)) out.add(type);
  }
  return [...out];
}
