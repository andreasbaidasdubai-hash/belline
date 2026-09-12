import type {
  Booking,
  Minutes,
  SalonConfig,
  SalonService,
  ServicePhase,
  StaffMember,
  TimeRange,
} from "../types";

/**
 * What a service actually costs the diary.
 *
 * Everything else in the salon/clinic engine used to ask a service two
 * questions — how long, how much — and both had exactly one answer. Neither is
 * true of a real price list:
 *
 *   - A senior colourist does in 45 minutes what a junior takes an hour over,
 *     and charges more for it. Level-based pricing is not an edge case; it is
 *     how the entire trade sells.
 *   - A new patient exam is longer than a returning one, always.
 *   - A service is not a solid block of one person's attention. Colour
 *     develops, anaesthetic takes, a mask sits. During those stretches the
 *     chair is occupied and the stylist is free, and the whole of a salon's
 *     capacity lives in that distinction.
 *
 * So this module answers those questions *for a given person and a given
 * guest*, and returns the shape of the appointment rather than its length.
 * `salon.ts` then does interval arithmetic against that shape instead of
 * against a single span, which is what makes dovetailing and a dentist's
 * ten-minute exam inside a hygienist's hour expressible at all.
 */

export interface ServiceShape {
  services: SalonService[];
  /** Guest-facing length, start to finish, buffer excluded. */
  durationMin: number;
  /** Cleanup held after, not shown to the guest. */
  bufferMin: number;
  price: number;
  /**
   * Stretches, measured from minute zero of the appointment, where the person
   * doing the work is occupied. Merged, sorted, and always non-empty.
   *
   * For an ordinary service this is one interval covering everything including
   * the cleanup buffer — exactly what the engine assumed before phases
   * existed, which is why adding them changed no existing behaviour.
   */
  staffBusy: TimeRange[];
  /** Resource types held for the whole block; the guest is sitting in it throughout. */
  resourceTypes: string[];
  /** Second-person needs, as offsets from minute zero. */
  secondary: { role: string; start: Minutes; end: Minutes }[];
  /** Services named in the request that are not on the price list. */
  missing: string[];
  /** True when at least one service asked for a longer first-visit duration. */
  newGuestTiming: boolean;
}

export interface ShapeOptions {
  /** Whose timing and prices to use. Absent uses the list price and list duration. */
  staff?: StaffMember;
  /** First visit here. Switches services to their `newGuestDurationMin`. */
  newGuest?: boolean;
}

/**
 * Look services up by id, then by name.
 *
 * Name matching exists because the agent sometimes passes what the caller
 * said. Kept here rather than in the caller so a misheard service comes back
 * as a named miss rather than a silently shorter appointment.
 */
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

/** How long this service takes this person, for this guest. */
export function durationFor(
  service: SalonService,
  opts: ShapeOptions = {},
): number {
  const override = opts.staff?.durationOverrides?.[service.id];
  if (override !== undefined) return override;
  if (opts.newGuest && service.newGuestDurationMin !== undefined) {
    return service.newGuestDurationMin;
  }
  return service.durationMin;
}

/** What this person charges for it. */
export function priceFor(service: SalonService, opts: ShapeOptions = {}): number {
  return opts.staff?.priceOverrides?.[service.id] ?? service.price;
}

/**
 * The phases of one service, stretched or squeezed to the duration actually
 * being used.
 *
 * A stylist who is quicker is quicker at the parts they do; the colour still
 * takes the time the colour takes. Scaling every phase proportionally is
 * therefore not quite right — but the alternative is asking every venue to
 * re-state each phase per stylist, which nobody will do, and proportional is
 * right to within a few minutes on the shapes that occur in practice. The
 * honest fix, if a venue ever complains, is a per-phase override; the shape
 * here is ready for one.
 */
function phasesFor(service: SalonService, durationMin: number): ServicePhase[] {
  const declared = service.phases;
  if (!declared || declared.length === 0) {
    return [{ name: service.name, durationMin }];
  }
  const total = declared.reduce((n, p) => n + p.durationMin, 0);
  if (total <= 0) return [{ name: service.name, durationMin }];
  if (total === durationMin) return declared;

  const scale = durationMin / total;
  const out: ServicePhase[] = [];
  let used = 0;
  declared.forEach((phase, i) => {
    // The last phase absorbs the rounding, so the phases always add back up to
    // the duration the rest of the engine is working with.
    const length =
      i === declared.length - 1
        ? durationMin - used
        : Math.round(phase.durationMin * scale);
    used += length;
    out.push({ ...phase, durationMin: length });
  });
  return out;
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

/**
 * The whole appointment: several services back to back, with their phases,
 * their resources, and whoever else has to walk in partway through.
 */
export function serviceShape(
  config: SalonConfig,
  serviceIds: string[],
  opts: ShapeOptions = {},
): ServiceShape {
  const { services, missing } = resolveServices(config, serviceIds);

  let cursor = 0;
  let price = 0;
  const busy: TimeRange[] = [];
  const resourceTypes = new Set<string>();
  const secondary: ServiceShape["secondary"] = [];
  let newGuestTiming = false;

  for (const service of services) {
    const duration = durationFor(service, opts);
    if (
      opts.newGuest &&
      service.newGuestDurationMin !== undefined &&
      opts.staff?.durationOverrides?.[service.id] === undefined
    ) {
      newGuestTiming = true;
    }
    price += priceFor(service, opts);

    let at = cursor;
    for (const phase of phasesFor(service, duration)) {
      if (!phase.staffFree) busy.push({ start: at, end: at + phase.durationMin });
      at += phase.durationMin;
    }

    if (service.secondary) {
      secondary.push({
        role: service.secondary.role,
        start: cursor + service.secondary.atMin,
        end: cursor + service.secondary.atMin + service.secondary.durationMin,
      });
    }

    for (const type of resourceTypesOf(service)) resourceTypes.add(type);
    cursor += duration;
  }

  // Only the last service's cleanup applies — you reset the station once —
  // and cleanup is work, so it holds the person as well as the room.
  const bufferMin = services.length ? services[services.length - 1].bufferMin : 0;
  if (bufferMin > 0) busy.push({ start: cursor, end: cursor + bufferMin });

  return {
    services,
    durationMin: cursor,
    bufferMin,
    price,
    staffBusy: busy.length ? mergeRanges(busy) : [{ start: 0, end: cursor + bufferMin }],
    resourceTypes: [...resourceTypes],
    secondary,
    missing,
    newGuestTiming,
  };
}

/** Everything one service ties up, old single field and new list together. */
export function resourceTypesOf(service: SalonService): string[] {
  const out = new Set<string>();
  if (service.resourceType) out.add(service.resourceType);
  for (const type of service.resourceTypes ?? []) out.add(type);
  return [...out];
}

/** Absolute clock ranges, for a shape starting at `startMin`. */
export function shiftRanges(ranges: TimeRange[], startMin: Minutes): TimeRange[] {
  return ranges.map((r) => ({ start: startMin + r.start, end: startMin + r.end }));
}

/**
 * When an existing booking actually holds its practitioner.
 *
 * Re-derived from the services rather than stored, so there is no second copy
 * of the truth to drift — but re-derivation reads today's price list, and a
 * venue that has since shortened a service would have this disagree with what
 * the diary shows. So the derived shape is only trusted when it still fits
 * inside the span the booking was written with; otherwise the whole span is
 * treated as busy, which is the safe direction to be wrong in.
 */
export function bookingStaffBusy(config: SalonConfig, booking: Booking): TimeRange[] {
  const whole: TimeRange[] = [{ start: booking.startMin, end: booking.endMin }];
  const ids = booking.serviceIds ?? [];
  if (ids.length === 0) return whole;

  const staff = config.staff.find((s) => s.id === booking.staffId);
  const shape = serviceShape(config, ids, { staff });
  if (shape.missing.length > 0) return whole;
  if (shape.durationMin + shape.bufferMin !== booking.endMin - booking.startMin) {
    return whole;
  }
  return shiftRanges(shape.staffBusy, booking.startMin);
}

/**
 * When an existing booking holds its *second* person — the dentist who steps
 * into a hygiene appointment, not the hygienist running it.
 */
export function bookingSecondaryBusy(
  config: SalonConfig,
  booking: Booking,
): TimeRange[] {
  const ids = booking.serviceIds ?? [];
  if (ids.length === 0 || !booking.secondaryStaffId) return [];
  const staff = config.staff.find((s) => s.id === booking.staffId);
  const shape = serviceShape(config, ids, { staff });
  if (shape.missing.length > 0 || shape.secondary.length === 0) {
    return [{ start: booking.startMin, end: booking.endMin }];
  }
  return shape.secondary.map((s) => ({
    start: booking.startMin + s.start,
    end: booking.startMin + s.end,
  }));
}

/** Total length of a set of ranges. Used to measure how much of a day is sold. */
export function rangeMinutes(ranges: TimeRange[]): number {
  return ranges.reduce((n, r) => n + Math.max(0, r.end - r.start), 0);
}
