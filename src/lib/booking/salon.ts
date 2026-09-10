import type {
  AvailabilityQuery,
  Booking,
  Location,
  Minutes,
  SalonConfig,
  SalonService,
  Slot,
  StaffMember,
  TimeRange,
} from "../types";
import { weekdayOf } from "../time";

/**
 * Salon / clinic availability.
 *
 * The shape of the problem is different from a restaurant: instead of a table
 * free for a fixed turn, you need one qualified person free for the exact
 * duration of the requested service chain, plus any shared equipment that
 * chain needs, plus the cleanup buffer after it. Getting the buffer wrong is
 * what causes a stylist's day to slide by twenty minutes before lunch.
 */

export interface SalonAssignment {
  staffId: string;
  staffName: string;
  resourceId?: string;
  startMin: Minutes;
  /** End of the guest-facing appointment (buffer excluded). */
  endMin: Minutes;
  /** End of the block held in the diary (buffer included). */
  blockEndMin: Minutes;
  serviceIds: string[];
  durationMin: number;
  price: number;
}

export type SalonUnavailable =
  | { ok: false; reason: "closed"; detail: string }
  | { ok: false; reason: "unknown_service"; detail: string }
  | { ok: false; reason: "no_staff"; detail: string }
  | { ok: false; reason: "staff_busy"; detail: string }
  | { ok: false; reason: "no_resource"; detail: string };

export function resolveServices(
  config: SalonConfig,
  serviceIds: string[],
): { services: SalonService[]; missing: string[] } {
  const services: SalonService[] = [];
  const missing: string[] = [];
  for (const wanted of serviceIds) {
    const found =
      config.services.find((s) => s.id === wanted) ??
      config.services.find(
        (s) => s.name.toLowerCase() === wanted.toLowerCase().trim(),
      );
    if (found) services.push(found);
    else missing.push(wanted);
  }
  return { services, missing };
}

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

function staffWorkingRanges(staff: StaffMember, date: string): TimeRange[] {
  const weekday = weekdayOf(date);
  const base = staff.hours[weekday] ?? [];
  const off = staff.timeOff.filter((t) => t.date === date);
  if (off.length === 0) return base;

  // Subtract each time-off block from the working ranges.
  let ranges = base.map((r) => ({ ...r }));
  for (const block of off) {
    const next: TimeRange[] = [];
    for (const r of ranges) {
      if (block.end <= r.start || block.start >= r.end) {
        next.push(r);
        continue;
      }
      if (block.start > r.start) next.push({ start: r.start, end: block.start });
      if (block.end < r.end) next.push({ start: block.end, end: r.end });
    }
    ranges = next;
  }
  return ranges;
}

function isFree(
  bookings: Booking[],
  predicate: (b: Booking) => boolean,
  startMin: Minutes,
  endMin: Minutes,
): boolean {
  return !bookings.some(
    (b) => predicate(b) && b.startMin < endMin && startMin < b.endMin,
  );
}

export function checkSalonSlot(
  location: Location,
  bookings: Booking[],
  query: {
    date: string;
    startMin: Minutes;
    serviceIds: string[];
    staffId?: string;
    excludeBookingId?: string;
  },
): { ok: true; assignment: SalonAssignment } | SalonUnavailable {
  const config = location.salon!;

  if (location.closures.includes(query.date)) {
    return { ok: false, reason: "closed", detail: "The salon is closed on that date." };
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

  const { durationMin, bufferMin, price } = chainDuration(services);
  const endMin = query.startMin + durationMin;
  const blockEndMin = endMin + bufferMin;

  const dayBookings = bookings.filter(
    (b) => b.date === query.date && b.status === "confirmed" && b.id !== query.excludeBookingId,
  );

  const serviceIds = services.map((s) => s.id);
  const qualified = config.staff.filter(
    (s) =>
      (!query.staffId || s.id === query.staffId) &&
      serviceIds.every((sid) => s.serviceIds.includes(sid)),
  );

  if (qualified.length === 0) {
    return {
      ok: false,
      reason: "no_staff",
      detail: query.staffId
        ? "That team member does not offer all of those services."
        : "Nobody on the team offers that combination of services.",
    };
  }

  // Prefer the least-loaded qualified stylist so the day spreads evenly
  // instead of stacking everything on whoever appears first in the list.
  const loadOf = (staffId: string) =>
    dayBookings.filter((b) => b.staffId === staffId).length;
  const ordered = qualified.slice().sort((a, b) => loadOf(a.id) - loadOf(b.id));

  let sawWorkingStaff = false;
  for (const staff of ordered) {
    const ranges = staffWorkingRanges(staff, query.date);
    // The guest-facing appointment must sit inside the shift; the cleanup
    // buffer is allowed to run to the end of it.
    const fits = ranges.some(
      (r) => query.startMin >= r.start && endMin <= r.end,
    );
    if (!fits) continue;
    sawWorkingStaff = true;

    if (!isFree(dayBookings, (b) => b.staffId === staff.id, query.startMin, blockEndMin)) {
      continue;
    }

    const neededType = services.find((s) => s.resourceType)?.resourceType;
    let resourceId: string | undefined;
    if (neededType) {
      const pool = config.resources.filter((r) => r.type === neededType);
      const available = pool.find((r) =>
        isFree(dayBookings, (b) => b.resourceId === r.id, query.startMin, blockEndMin),
      );
      if (!available) {
        return {
          ok: false,
          reason: "no_resource",
          detail: `No ${neededType} is free at that time.`,
        };
      }
      resourceId = available.id;
    }

    return {
      ok: true,
      assignment: {
        staffId: staff.id,
        staffName: staff.name,
        resourceId,
        startMin: query.startMin,
        endMin,
        blockEndMin,
        serviceIds,
        durationMin,
        price,
      },
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

export function searchSalon(
  location: Location,
  bookings: Booking[],
  query: AvailabilityQuery,
  limit = 6,
): Slot[] {
  const config = location.salon!;
  const weekday = weekdayOf(query.date);
  const windowMin = query.windowMin ?? 240;
  const openRanges = location.hours[weekday] ?? [];
  if (openRanges.length === 0 || location.closures.includes(query.date)) return [];

  const candidates: Minutes[] = [];
  for (const range of openRanges) {
    for (let t = range.start; t <= range.end; t += config.slotMinutes) {
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
    const result = checkSalonSlot(location, bookings, {
      date: query.date,
      startMin,
      serviceIds: query.serviceIds ?? [],
      staffId: query.staffId,
      excludeBookingId: query.excludeBookingId,
    });
    if (result.ok) {
      slots.push({
        date: query.date,
        startMin,
        endMin: result.assignment.endMin,
        staffId: result.assignment.staffId,
        staffName: result.assignment.staffName,
        resourceId: result.assignment.resourceId,
      });
      if (slots.length >= limit) break;
    }
  }

  return slots.sort((a, b) => a.startMin - b.startMin);
}
