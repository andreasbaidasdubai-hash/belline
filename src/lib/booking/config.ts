import type {
  BookingPolicy,
  Location,
  RestaurantConfig,
  SalonConfig,
  SalonService,
  StaffMember,
} from "../types";
import { resourceTypesOf } from "./services";

/**
 * Checking a venue's own configuration before it is allowed to save it.
 *
 * This exists because the engine is now configurable, and a configurable
 * engine has a new failure mode the seeded one never had: a venue can describe
 * a diary that cannot work. Phases that do not add up to the service length. A
 * stylist qualified for a service that was deleted this morning. A treatment
 * that needs a room type nobody owns. A hygiene appointment wanting a dentist
 * at a practice with no dentists.
 *
 * None of those throw. They produce an engine that quietly refuses every
 * booking, or worse, one that accepts bookings it cannot honour — and the
 * venue discovers it at eight o'clock on a Friday, blames the agent, and
 * leaves. So the save path is a gate, not a passthrough.
 *
 * Two kinds of finding, and the difference matters:
 *
 *   - An **error** is a configuration the engine cannot work with. Refused.
 *   - A **warning** is a configuration that works and is probably a mistake —
 *     a service nobody is qualified to do, a room nothing uses. Saved, and
 *     said out loud, because a venue mid-setup has half of these on purpose
 *     and being blocked by them is how a setup page gets abandoned.
 */

export interface Finding {
  level: "error" | "warning";
  /** Where in the form it belongs, so the UI can put it next to the field. */
  where: string;
  message: string;
}

export function isBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.level === "error");
}

// ---------------------------------------------------------------------------

const MAX_SERVICE_MINUTES = 8 * 60;
const MAX_NOTICE_DAYS = 90;

export function validatePolicy(policy: BookingPolicy | undefined): Finding[] {
  if (!policy) return [];
  const out: Finding[] = [];
  const at = (field: string) => `policy.${field}`;

  const positive = (value: number | undefined, field: string, label: string) => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value < 0) {
      out.push({ level: "error", where: at(field), message: `${label} cannot be negative.` });
    }
  };

  positive(policy.minNoticeMin, "minNoticeMin", "Notice");
  positive(policy.maxHorizonDays, "maxHorizonDays", "The booking window");
  positive(policy.cancellationWindowHours, "cancellationWindowHours", "The cancellation window");
  positive(policy.lateCancelFee, "lateCancelFee", "The late cancellation charge");
  positive(policy.noShowFee, "noShowFee", "The no-show charge");

  if (policy.minNoticeMin !== undefined && policy.minNoticeMin > MAX_NOTICE_DAYS * 24 * 60) {
    out.push({
      level: "error",
      where: at("minNoticeMin"),
      message: "That much notice would refuse every booking anyone could make.",
    });
  }

  if (policy.sameDayCutoffMin !== undefined) {
    if (policy.sameDayCutoffMin < 0 || policy.sameDayCutoffMin >= 24 * 60) {
      out.push({
        level: "error",
        where: at("sameDayCutoffMin"),
        message: "The same-day cutoff must be a time of day.",
      });
    }
  }

  // A horizon inside the notice period is a venue that will never take a
  // booking at all, and the arithmetic that produces it is easy to do by
  // accident — two fields, two different units.
  if (
    policy.maxHorizonDays !== undefined &&
    policy.minNoticeMin !== undefined &&
    policy.minNoticeMin > policy.maxHorizonDays * 24 * 60
  ) {
    out.push({
      level: "error",
      where: at("minNoticeMin"),
      message: `You need ${Math.round(policy.minNoticeMin / 60)} hours' notice but only book ${policy.maxHorizonDays} days ahead — nothing would ever be bookable.`,
    });
  }

  const deposit = policy.deposit;
  if (deposit) {
    if (!Number.isFinite(deposit.amount) || deposit.amount <= 0) {
      out.push({
        level: "error",
        where: at("deposit.amount"),
        message: "A deposit has to be an amount above zero. Remove it instead of setting it to nothing.",
      });
    }
    if (deposit.per !== "booking" && deposit.per !== "person") {
      out.push({ level: "error", where: at("deposit.per"), message: "A deposit is per booking or per person." });
    }
    if (deposit.weekdays?.some((d) => d < 0 || d > 6)) {
      out.push({ level: "error", where: at("deposit.weekdays"), message: "Weekdays run 0 (Sunday) to 6." });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------

export function validateSalon(config: SalonConfig): Finding[] {
  const out: Finding[] = [];
  const ids = new Set<string>();

  const ownedTypes = new Set(config.resources.map((r) => r.type));

  for (const service of config.services) {
    const at = `service.${service.id}`;
    if (!service.id.trim() || !service.name.trim()) {
      out.push({ level: "error", where: at, message: "Every service needs a name." });
    }
    if (ids.has(service.id)) {
      out.push({ level: "error", where: at, message: `Two services share the id "${service.id}".` });
    }
    ids.add(service.id);

    if (!Number.isFinite(service.durationMin) || service.durationMin <= 0) {
      out.push({ level: "error", where: `${at}.durationMin`, message: `${service.name} needs a length.` });
    } else if (service.durationMin > MAX_SERVICE_MINUTES) {
      out.push({
        level: "warning",
        where: `${at}.durationMin`,
        message: `${service.name} is over eight hours. Is that right?`,
      });
    }
    if (service.bufferMin < 0) {
      out.push({ level: "error", where: `${at}.bufferMin`, message: "Turnaround cannot be negative." });
    }
    if (service.price < 0) {
      out.push({ level: "error", where: `${at}.price`, message: "A price cannot be negative." });
    }

    out.push(...validatePhases(service, at));

    // A service whose second person cannot exist is one that will refuse every
    // booking, and the message it refuses with names a role nobody holds —
    // which is unreadable to whoever is on the phone at the time.
    if (service.secondary) {
      const { role, atMin, durationMin } = service.secondary;
      if (!role.trim()) {
        out.push({ level: "error", where: `${at}.secondary`, message: "The second person needs a role." });
      } else if (!config.staff.some((s) => s.role === role)) {
        out.push({
          level: "error",
          where: `${at}.secondary`,
          message: `${service.name} needs a "${role}" partway through and nobody on the team has that role.`,
        });
      }
      if (atMin < 0 || durationMin <= 0 || atMin + durationMin > service.durationMin) {
        out.push({
          level: "error",
          where: `${at}.secondary`,
          message: `The second person's ${durationMin} minutes have to fall inside ${service.name}.`,
        });
      }
    }

    for (const type of resourceTypesOf(service)) {
      if (!ownedTypes.has(type)) {
        out.push({
          level: "error",
          where: `${at}.resources`,
          message: `${service.name} needs a "${type}" and there are none.`,
        });
      }
    }

    if (service.role && !config.staff.some((s) => s.role === service.role)) {
      out.push({
        level: "error",
        where: `${at}.role`,
        message: `Only a "${service.role}" may do ${service.name}, and nobody on the team is one.`,
      });
    }

    if (service.newGuestDurationMin !== undefined && service.newGuestDurationMin <= 0) {
      out.push({
        level: "error",
        where: `${at}.newGuestDurationMin`,
        message: "A first-visit length has to be above zero. Leave it blank for no difference.",
      });
    }

    if (service.recallDays !== undefined && service.recallDays < 0) {
      out.push({ level: "error", where: `${at}.recallDays`, message: "A recall interval cannot be negative." });
    }

    const qualified = config.staff.filter((s) => s.serviceIds.includes(service.id));
    if (qualified.length === 0) {
      out.push({
        level: "warning",
        where: `${at}.staff`,
        message: `Nobody is down as able to do ${service.name}, so it can never be booked.`,
      });
    } else if (qualified.every((s) => s.requestOnly)) {
      out.push({
        level: "warning",
        where: `${at}.staff`,
        message: `${service.name} is only offered by people who have to be asked for by name.`,
      });
    }
  }

  out.push(...validateStaff(config, ids));

  for (const resource of config.resources) {
    if (!resource.name.trim() || !resource.type.trim()) {
      out.push({ level: "error", where: `resource.${resource.id}`, message: "A room needs a name and a type." });
    }
    if (resource.capacity !== undefined && resource.capacity < 1) {
      out.push({
        level: "error",
        where: `resource.${resource.id}.capacity`,
        message: "A room holds at least one at a time.",
      });
    }
    if (!config.services.some((s) => resourceTypesOf(s).includes(resource.type))) {
      out.push({
        level: "warning",
        where: `resource.${resource.id}`,
        message: `Nothing on the price list uses a "${resource.type}".`,
      });
    }
  }

  if (!Number.isFinite(config.slotMinutes) || config.slotMinutes <= 0) {
    out.push({ level: "error", where: "slotMinutes", message: "The booking grid needs a step above zero." });
  }

  if (config.dovetail && !config.services.some((s) => (s.phases ?? []).some((p) => p.staffFree))) {
    out.push({
      level: "warning",
      where: "dovetail",
      message:
        "Dovetailing is on, but nothing on the price list has a stretch where the room is busy and the person is free — so it will never do anything.",
    });
  }

  return out;
}

function validatePhases(service: SalonService, at: string): Finding[] {
  const phases = service.phases;
  if (!phases || phases.length === 0) return [];

  const out: Finding[] = [];
  const total = phases.reduce((n, p) => n + p.durationMin, 0);

  if (phases.some((p) => p.durationMin <= 0)) {
    out.push({ level: "error", where: `${at}.phases`, message: "Every stage needs a length above zero." });
  }
  if (total !== service.durationMin) {
    out.push({
      level: "error",
      where: `${at}.phases`,
      // Said as the arithmetic rather than as a rule, because the fix is
      // obvious once the two numbers are side by side.
      message: `The stages of ${service.name} come to ${total} minutes and the service is ${service.durationMin}.`,
    });
  }
  if (phases.every((p) => p.staffFree)) {
    out.push({
      level: "error",
      where: `${at}.phases`,
      message: `Somebody has to do ${service.name} — at least one stage needs them present.`,
    });
  }
  if (phases.length > 1 && !phases.some((p) => p.staffFree)) {
    out.push({
      level: "warning",
      where: `${at}.phases`,
      message: `${service.name} is split into stages but none of them frees anyone up, so it behaves as one block.`,
    });
  }
  return out;
}

function validateStaff(config: SalonConfig, serviceIds: Set<string>): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();

  for (const person of config.staff) {
    const at = `staff.${person.id}`;
    if (!person.name.trim()) {
      out.push({ level: "error", where: at, message: "Everyone needs a name." });
    }
    if (seen.has(person.id)) {
      out.push({ level: "error", where: at, message: `Two people share the id "${person.id}".` });
    }
    seen.add(person.id);

    // A qualification pointing at a service that has been deleted is the
    // commonest way this config rots: the price list is edited, the team is
    // not, and the stale id silently qualifies nobody for anything.
    for (const id of person.serviceIds) {
      if (!serviceIds.has(id)) {
        out.push({
          level: "error",
          where: `${at}.serviceIds`,
          message: `${person.name} is down for "${id}", which is not on the price list any more.`,
        });
      }
    }

    for (const key of Object.keys(person.durationOverrides ?? {})) {
      if (!serviceIds.has(key)) {
        out.push({
          level: "warning",
          where: `${at}.durationOverrides`,
          message: `${person.name} has their own timing for "${key}", which no longer exists.`,
        });
      }
    }
    for (const key of Object.keys(person.priceOverrides ?? {})) {
      if (!serviceIds.has(key)) {
        out.push({
          level: "warning",
          where: `${at}.priceOverrides`,
          message: `${person.name} has their own price for "${key}", which no longer exists.`,
        });
      }
    }

    out.push(...validateHours(person, at));

    if (person.serviceIds.length === 0) {
      out.push({
        level: "warning",
        where: `${at}.serviceIds`,
        message: `${person.name} is not down for anything, so they will never be booked.`,
      });
    }
  }

  return out;
}

function validateHours(person: StaffMember, at: string): Finding[] {
  const out: Finding[] = [];

  const check = (ranges: { start: number; end: number }[], label: string, where: string) => {
    for (const range of ranges) {
      if (range.end <= range.start) {
        out.push({
          level: "error",
          where,
          message: `${person.name}'s ${label} ends before it starts.`,
        });
      }
      if (range.start < 0 || range.end > 24 * 60) {
        out.push({ level: "error", where, message: `${person.name}'s ${label} is outside the day.` });
      }
    }
  };

  for (const [day, ranges] of Object.entries(person.hours)) {
    check(ranges, "shift", `${at}.hours.${day}`);
  }
  for (const [day, ranges] of Object.entries(person.breaks ?? {})) {
    check(ranges, "break", `${at}.breaks.${day}`);
    // A break outside the shift is not an error — it is simply subtracted from
    // nothing — but it is always a mistake, and an invisible one.
    const shift = person.hours[Number(day)] ?? [];
    for (const brk of ranges) {
      if (shift.length > 0 && !shift.some((s) => brk.start < s.end && s.start < brk.end)) {
        out.push({
          level: "warning",
          where: `${at}.breaks.${day}`,
          message: `${person.name}'s break that day falls outside their shift, so it does nothing.`,
        });
      }
    }
  }
  for (const shift of person.shifts ?? []) {
    check(shift.ranges, `rota for ${shift.date}`, `${at}.shifts`);
  }

  return out;
}

// ---------------------------------------------------------------------------

export function validateRestaurant(config: RestaurantConfig): Finding[] {
  const out: Finding[] = [];
  const ids = new Set<string>();
  const tableIds = new Set(config.tables.map((t) => t.id));

  for (const table of config.tables) {
    const at = `table.${table.id}`;
    if (!table.name.trim()) out.push({ level: "error", where: at, message: "Every table needs a name." });
    if (ids.has(table.id)) {
      out.push({ level: "error", where: at, message: `Two tables share the id "${table.id}".` });
    }
    ids.add(table.id);

    if (table.minSeats < 1 || table.maxSeats < table.minSeats) {
      out.push({
        level: "error",
        where: `${at}.seats`,
        message: `Table ${table.name} seats ${table.minSeats} to ${table.maxSeats}, which is not a range.`,
      });
    }
    if (!table.section.trim()) {
      out.push({ level: "error", where: `${at}.section`, message: `Table ${table.name} is in no section.` });
    }
    for (const other of table.combinesWith ?? []) {
      if (!tableIds.has(other)) {
        out.push({
          level: "error",
          where: `${at}.combinesWith`,
          message: `Table ${table.name} is set to join "${other}", which does not exist.`,
        });
      } else if (
        config.tables.find((t) => t.id === other)?.section !== table.section
      ) {
        out.push({
          level: "warning",
          where: `${at}.combinesWith`,
          message: `Table ${table.name} is set to join a table in another section, which the engine will never do.`,
        });
      }
    }
  }

  const sections = new Set(config.tables.map((t) => t.section));
  for (const section of config.sections ?? []) {
    if (!sections.has(section.id)) {
      out.push({
        level: "warning",
        where: `section.${section.id}`,
        message: `The "${section.id}" section has no tables in it.`,
      });
    }
    if (section.maxCoversPerSlot !== undefined && section.maxCoversPerSlot < 0) {
      out.push({
        level: "error",
        where: `section.${section.id}.pacing`,
        message: "A section's pacing cannot be negative.",
      });
    }
  }

  if (config.maxPartySize < 1) {
    out.push({ level: "error", where: "maxPartySize", message: "The largest party has to be at least one." });
  }
  const biggest = Math.max(0, ...config.tables.map((t) => t.maxSeats));
  const combine = Math.max(2, Math.min(config.maxCombine ?? 2, 3));
  if (config.maxPartySize > biggest * combine) {
    out.push({
      level: "warning",
      where: "maxPartySize",
      message: `You take parties of ${config.maxPartySize} but the room cannot seat one — the largest table is ${biggest} and you push at most ${combine} together.`,
    });
  }
  if (config.maxCoversPerSlot < 1) {
    out.push({ level: "error", where: "maxCoversPerSlot", message: "Pacing has to allow at least one cover." });
  }
  if ((config.resetMinutes ?? 0) < 0) {
    out.push({ level: "error", where: "resetMinutes", message: "Turnaround cannot be negative." });
  }
  if (!Number.isFinite(config.slotMinutes) || config.slotMinutes <= 0) {
    out.push({ level: "error", where: "slotMinutes", message: "The booking grid needs a step above zero." });
  }

  for (const service of config.services) {
    const at = `sitting.${service.id}`;
    if (!service.name.trim()) out.push({ level: "error", where: at, message: "Every sitting needs a name." });
    if (service.days.length === 0) {
      out.push({ level: "warning", where: `${at}.days`, message: `${service.name} runs on no days.` });
    }
    if (service.end <= service.start) {
      out.push({ level: "error", where: `${at}.hours`, message: `${service.name} ends before it starts.` });
    }
    if (service.lastSeating < service.start || service.lastSeating > service.end) {
      out.push({
        level: "error",
        where: `${at}.lastSeating`,
        message: `The last seating for ${service.name} is outside the sitting itself.`,
      });
    }
    if (service.turnTimes.length === 0) {
      out.push({ level: "error", where: `${at}.turnTimes`, message: `${service.name} has no turn times.` });
    }
    if (service.turnTimes.some((t) => t.minutes <= 0 || t.upTo < 1)) {
      out.push({ level: "error", where: `${at}.turnTimes`, message: "A turn time has to be above zero." });
    }
    // Read first-match-wins, so an out-of-order list silently gives large
    // parties a small party's turn.
    for (let i = 1; i < service.turnTimes.length; i++) {
      if (service.turnTimes[i].upTo <= service.turnTimes[i - 1].upTo) {
        out.push({
          level: "error",
          where: `${at}.turnTimes`,
          message: `Turn times for ${service.name} have to go up by party size.`,
        });
        break;
      }
    }
    if ((service.walkInHoldback ?? 0) >= (service.maxCoversPerSlot ?? config.maxCoversPerSlot)) {
      out.push({
        level: "error",
        where: `${at}.walkInHoldback`,
        message: `Holding back ${service.walkInHoldback} covers leaves nothing for the phone during ${service.name}.`,
      });
    }
  }

  const weekdaysCovered = new Set(config.services.flatMap((s) => s.days));
  if (weekdaysCovered.size === 0) {
    out.push({ level: "error", where: "sittings", message: "There are no sittings, so nothing can be booked." });
  }

  return out;
}

// ---------------------------------------------------------------------------

/** Everything wrong with a venue's configuration, in one pass. */
export function validateVenue(location: Location): Finding[] {
  const out = validatePolicy(location.policy);
  if (location.restaurant) out.push(...validateRestaurant(location.restaurant));
  if (location.salon) out.push(...validateSalon(location.salon));
  return out;
}

// ---------------------------------------------------------------------------
// Coercion
//
// The validators above answer "does this configuration make sense". They
// assume the shapes are the shapes. Nothing arriving over HTTP has earned that
// assumption: a blank number field arrives as "" or NaN, a checkbox as a
// string, and a client that is simply out of date sends a field that no longer
// exists. So everything is rebuilt field by field before it is checked, and a
// value that cannot be read is dropped rather than stored.
//
// Verbose on purpose. This is the boundary between the venue's own diary and
// whatever a browser sent, and the terse version of it is the one that writes
// `durationMin: "60"` into the book and turns an hour into six thousand.
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A number, or undefined where the field was left blank. Never NaN. */
function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** A number that must be present; falls back rather than poisoning the book. */
function numOr(value: unknown, fallback: number): number {
  return num(value) ?? fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** Only where a value was actually sent — so absent stays absent. */
function flag(raw: Raw, key: string): boolean | undefined {
  return key in raw ? bool(raw[key]) : undefined;
}

function ranges(value: unknown): { start: number; end: number }[] {
  return asArray(value)
    .map((r) => asRaw(r))
    .filter((r): r is Raw => Boolean(r))
    .map((r) => ({ start: numOr(r.start, 0), end: numOr(r.end, 0) }))
    .filter((r) => r.end > r.start);
}

function weekly(value: unknown): Record<number, { start: number; end: number }[]> {
  const raw = asRaw(value);
  if (!raw) return {};
  const out: Record<number, { start: number; end: number }[]> = {};
  for (let day = 0; day < 7; day++) {
    out[day] = ranges(raw[String(day)]);
  }
  return out;
}

function ids(value: unknown): string[] {
  return asArray(value).map(str).filter(Boolean);
}

/** `{ [serviceId]: number }`, dropping anything unreadable. */
function overrides(value: unknown): Record<string, number> | undefined {
  const raw = asRaw(value);
  if (!raw) return undefined;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(raw)) {
    const n = num(v);
    if (key.trim() && n !== undefined) out[key.trim()] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Drop the keys whose value came back undefined, so absent means absent.
 *
 * It matters that the key goes rather than holding `undefined`: these objects
 * are JSON-stringified into the store and hashed into the brain's version
 * digest, and `{a: undefined}` and `{}` serialise the same but compare
 * differently everywhere in between.
 */
function tidy<T extends object>(value: T): T {
  const out = value as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return value;
}

export function coercePolicy(input: unknown): BookingPolicy | undefined {
  const raw = asRaw(input);
  if (!raw) return undefined;

  const depositRaw = asRaw(raw.deposit);
  // An empty weekday list means "every day", which is what absent already
  // means — kept as absent so the two cannot drift apart in the rule that
  // reads it.
  const weekdays = asArray(depositRaw?.weekdays)
    .map(num)
    .filter((d): d is number => d !== undefined);
  const deposit = depositRaw
    ? tidy({
        amount: numOr(depositRaw.amount, 0),
        per: depositRaw.per === "person" ? ("person" as const) : ("booking" as const),
        minPartySize: num(depositRaw.minPartySize),
        minValue: num(depositRaw.minValue),
        newGuestsOnly: flag(depositRaw, "newGuestsOnly"),
        weekdays: weekdays.length > 0 ? weekdays : undefined,
        wording: str(depositRaw.wording) || undefined,
      })
    : undefined;

  const policy = tidy<BookingPolicy>({
    minNoticeMin: num(raw.minNoticeMin),
    maxHorizonDays: num(raw.maxHorizonDays),
    sameDayCutoffMin: num(raw.sameDayCutoffMin),
    cancellationWindowHours: num(raw.cancellationWindowHours),
    lateCancelFee: num(raw.lateCancelFee),
    noShowFee: num(raw.noShowFee),
    noShowsBeforeReview: num(raw.noShowsBeforeReview),
    maxOpenPerGuest: num(raw.maxOpenPerGuest),
    deposit,
  });

  // A venue that has cleared every field has no house rules, and storing an
  // empty object instead of nothing would make the history show a change
  // every time somebody opened the page.
  return Object.keys(policy).length > 0 ? policy : undefined;
}

export function coerceRestaurant(input: unknown, current: RestaurantConfig): RestaurantConfig {
  const raw = asRaw(input);
  if (!raw) return current;

  return tidy<RestaurantConfig>({
    slotMinutes: numOr(raw.slotMinutes, current.slotMinutes),
    maxCoversPerSlot: numOr(raw.maxCoversPerSlot, current.maxCoversPerSlot),
    maxPartySize: numOr(raw.maxPartySize, current.maxPartySize),
    largePartyPolicy: str(raw.largePartyPolicy) || current.largePartyPolicy,
    overbookPerSlot: num(raw.overbookPerSlot),
    resetMinutes: num(raw.resetMinutes),
    maxCombine: num(raw.maxCombine),
    tables: asArray(raw.tables)
      .map((t) => asRaw(t))
      .filter((t): t is Raw => Boolean(t))
      .map((t) =>
        tidy({
          id: str(t.id),
          name: str(t.name),
          minSeats: numOr(t.minSeats, 1),
          maxSeats: numOr(t.maxSeats, 2),
          section: str(t.section),
          combinesWith: "combinesWith" in t ? ids(t.combinesWith) : undefined,
          online: flag(t, "online"),
          priority: num(t.priority),
        }),
      )
      .filter((t) => t.id && t.name),
    sections: "sections" in raw
      ? asArray(raw.sections)
          .map((s) => asRaw(s))
          .filter((s): s is Raw => Boolean(s))
          .map((s) =>
            tidy({
              id: str(s.id),
              name: str(s.name) || undefined,
              maxCoversPerSlot: num(s.maxCoversPerSlot),
              combinable: flag(s, "combinable"),
              online: flag(s, "online"),
              priority: num(s.priority),
              closedOn: "closedOn" in s ? ids(s.closedOn) : undefined,
            }),
          )
          .filter((s) => s.id)
      : current.sections,
    blocks: "blocks" in raw
      ? asArray(raw.blocks)
          .map((b) => asRaw(b))
          .filter((b): b is Raw => Boolean(b))
          .map((b) => ({
            id: str(b.id) || `blk_${Math.random().toString(16).slice(2, 10)}`,
            date: str(b.date),
            tableIds: ids(b.tableIds),
            startMin: numOr(b.startMin, 0),
            endMin: numOr(b.endMin, 0),
            reason: str(b.reason),
          }))
          .filter((b) => b.date && b.tableIds.length > 0 && b.endMin > b.startMin)
      : current.blocks,
    services: asArray(raw.services)
      .map((s) => asRaw(s))
      .filter((s): s is Raw => Boolean(s))
      .map((s) =>
        tidy({
          id: str(s.id),
          name: str(s.name),
          days: asArray(s.days)
            .map(num)
            .filter((d): d is number => d !== undefined && d >= 0 && d <= 6),
          start: numOr(s.start, 0),
          end: numOr(s.end, 0),
          lastSeating: numOr(s.lastSeating, 0),
          turnTimes: asArray(s.turnTimes)
            .map((t) => asRaw(t))
            .filter((t): t is Raw => Boolean(t))
            .map((t) => ({ upTo: numOr(t.upTo, 0), minutes: numOr(t.minutes, 0) }))
            .filter((t) => t.upTo > 0 && t.minutes > 0)
            // Read first-match-wins, so the order is load-bearing rather than
            // cosmetic. Sorting here means a venue cannot break it by dragging.
            .sort((a, b) => a.upTo - b.upTo),
          maxCoversPerSlot: num(s.maxCoversPerSlot),
          minNoticeMin: num(s.minNoticeMin),
          walkInHoldback: num(s.walkInHoldback),
        }),
      )
      .filter((s) => s.id && s.name),
  });
}

export function coerceSalon(input: unknown, current: SalonConfig): SalonConfig {
  const raw = asRaw(input);
  if (!raw) return current;

  return tidy<SalonConfig>({
    slotMinutes: numOr(raw.slotMinutes, current.slotMinutes),
    assignment: raw.assignment === "pack" ? "pack" : raw.assignment === "spread" ? "spread" : undefined,
    dovetail: flag(raw, "dovetail"),
    services: asArray(raw.services)
      .map((s) => asRaw(s))
      .filter((s): s is Raw => Boolean(s))
      .map((s) => coerceService(s))
      .filter((s) => s.id && s.name),
    staff: asArray(raw.staff)
      .map((p) => asRaw(p))
      .filter((p): p is Raw => Boolean(p))
      .map((p) => coerceStaff(p))
      .filter((p) => p.id && p.name),
    resources: asArray(raw.resources)
      .map((r) => asRaw(r))
      .filter((r): r is Raw => Boolean(r))
      .map((r) =>
        tidy({
          id: str(r.id),
          name: str(r.name),
          type: str(r.type),
          capacity: num(r.capacity),
          outOfService: "outOfService" in r
            ? asArray(r.outOfService)
                .map((o) => asRaw(o))
                .filter((o): o is Raw => Boolean(o))
                .map((o) => ({
                  date: str(o.date),
                  start: numOr(o.start, 0),
                  end: numOr(o.end, 0),
                }))
                .filter((o) => o.date && o.end > o.start)
            : undefined,
        }),
      )
      .filter((r) => r.id && r.name && r.type),
  });
}

function coerceService(s: Raw): SalonService {
  const secondaryRaw = asRaw(s.secondary);
  const phases = "phases" in s
    ? asArray(s.phases)
        .map((p) => asRaw(p))
        .filter((p): p is Raw => Boolean(p))
        .map((p) =>
          tidy({
            name: str(p.name) || "Stage",
            durationMin: numOr(p.durationMin, 0),
            staffFree: flag(p, "staffFree"),
          }),
        )
        .filter((p) => p.durationMin > 0)
    : undefined;

  return tidy<SalonService>({
    id: str(s.id),
    name: str(s.name),
    durationMin: numOr(s.durationMin, 0),
    bufferMin: numOr(s.bufferMin, 0),
    price: numOr(s.price, 0),
    resourceType: str(s.resourceType) || undefined,
    resourceTypes: "resourceTypes" in s ? ids(s.resourceTypes) : undefined,
    // One stage is not phases — it is the ordinary case wearing a costume, and
    // storing it makes every read do arithmetic it does not need to do.
    phases: phases && phases.length > 1 ? phases : undefined,
    secondary: secondaryRaw
      ? {
          role: str(secondaryRaw.role),
          atMin: numOr(secondaryRaw.atMin, 0),
          durationMin: numOr(secondaryRaw.durationMin, 0),
        }
      : undefined,
    newGuestDurationMin: num(s.newGuestDurationMin),
    addOnOnly: flag(s, "addOnOnly"),
    role: str(s.role) || undefined,
    online: flag(s, "online"),
    recallDays: num(s.recallDays),
  });
}

function coerceStaff(p: Raw): StaffMember {
  return tidy<StaffMember>({
    id: str(p.id),
    name: str(p.name),
    serviceIds: ids(p.serviceIds),
    hours: weekly(p.hours),
    timeOff: asArray(p.timeOff)
      .map((t) => asRaw(t))
      .filter((t): t is Raw => Boolean(t))
      .map((t) => ({ date: str(t.date), start: numOr(t.start, 0), end: numOr(t.end, 0) }))
      .filter((t) => t.date && t.end > t.start),
    role: str(p.role) || undefined,
    breaks: "breaks" in p ? weekly(p.breaks) : undefined,
    shifts: "shifts" in p
      ? asArray(p.shifts)
          .map((sh) => asRaw(sh))
          .filter((sh): sh is Raw => Boolean(sh))
          // An empty `ranges` is a day off and has to survive the filter —
          // "rostered off" and "no pattern" are different facts, and this is
          // the only place the first one can be said.
          .map((sh) => ({ date: str(sh.date), ranges: ranges(sh.ranges) }))
          .filter((sh) => sh.date)
      : undefined,
    durationOverrides: overrides(p.durationOverrides),
    priceOverrides: overrides(p.priceOverrides),
    requestOnly: flag(p, "requestOnly"),
  });
}
