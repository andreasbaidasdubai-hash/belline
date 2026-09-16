import type { Location, User, Vertical, WeeklyHours } from "./types";
import { tradeFromParam, verticalForTrade } from "./signup-rules";
import {
  getLocation,
  listBookings,
  listCalls,
  listLocationsFor,
  listUsersFor,
  removeLocation,
  saveUser,
  upsertLocation,
} from "./store";
import { canManageUsers } from "./auth";
import { ensureBaseline } from "./brain";
import { normalisePhone } from "./leads";
import { blankVenue } from "./onboarding";

/**
 * Adding, changing, archiving and deleting a business's locations.
 *
 * A second branch used to be impossible to add, and a closed one impossible to
 * remove, which is the kind of gap that makes software feel like a pilot.
 * Four rules keep this safe:
 *
 *   Only an owner adds, archives or deletes. A manager may edit the basics of
 *   the venues they can see; floor staff change none of it.
 *
 *   Archive is the normal way out. An archived venue keeps every booking,
 *   call and version, disappears from every list, switcher and call route,
 *   and can be restored. Delete is only for a venue with no history at all —
 *   a mistake made five minutes ago — and only once it is archived.
 *
 *   A business always keeps one active location. Archiving the last one would
 *   leave an account nobody can use.
 *
 *   The kind of business never changes after creation. A restaurant's tables
 *   and a clinic's diary are different engines; switching one into the other
 *   would silently discard its configuration.
 */

export const COMMON_TIMEZONES = [
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Qatar",
  "Asia/Bahrain",
  "Asia/Kuwait",
  "Asia/Muscat",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Zurich",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Toronto",
  "America/New_York",
];

export interface LocationInput {
  name?: unknown;
  /** What the owner picked from the checkout's list (signup-rules.ts `TRADES`). */
  trade?: unknown;
  vertical?: unknown;
  timezone?: unknown;
  address?: unknown;
  phone?: unknown;
  currency?: unknown;
  hours?: unknown;
  closures?: unknown;
}

export type LocationResult =
  | { ok: true; location: Location }
  | { ok: false; field?: string; error: string };

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cleanHours(raw: unknown): WeeklyHours | null {
  if (!raw || typeof raw !== "object") return null;
  const out: WeeklyHours = {};
  for (let day = 0; day <= 6; day++) {
    const ranges = (raw as Record<string, unknown>)[day];
    if (ranges === undefined) {
      out[day] = [];
      continue;
    }
    if (!Array.isArray(ranges) || ranges.length > 4) return null;
    const clean = ranges.map((r) => ({ start: Math.round(Number(r?.start)), end: Math.round(Number(r?.end)) }));
    for (const r of clean) {
      if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end > 1440 || r.end <= r.start) return null;
    }
    clean.sort((a, b) => a.start - b.start);
    for (let i = 1; i < clean.length; i++) if (clean[i].start < clean[i - 1].end) return null;
    out[day] = clean;
  }
  return out;
}

function cleanClosures(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const dates = raw.map((d) => String(d));
  if (dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`)))) return null;
  return [...new Set(dates)].sort();
}

/** Validate and apply the basics to a venue. Pure: nothing is saved. */
function applyBasics(location: Location, input: LocationInput): LocationResult {
  const next: Location = { ...location };

  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (name.length < 2 || name.length > 120) return { ok: false, field: "name", error: "Give the location a name." };
    next.name = name;
  }
  if (input.timezone !== undefined) {
    const tz = String(input.timezone).trim();
    if (!validTimezone(tz)) return { ok: false, field: "timezone", error: "That is not a timezone we recognise." };
    next.timezone = tz;
  }
  if (input.address !== undefined) next.address = String(input.address).trim().slice(0, 240);
  if (input.phone !== undefined) {
    const raw = String(input.phone).trim();
    if (raw) {
      const { phone, valid } = normalisePhone(raw);
      if (!valid) return { ok: false, field: "phone", error: "That does not look like a phone number. Include the country code." };
      next.phone = phone;
    } else {
      next.phone = "";
    }
  }
  if (input.currency !== undefined) {
    const currency = String(input.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, field: "currency", error: "Use a three-letter currency code, like AED." };
    next.currency = currency;
  }
  if (input.hours !== undefined) {
    const hours = cleanHours(input.hours);
    if (!hours) return { ok: false, field: "hours", error: "Check the opening hours — a closing time is before an opening time, or two overlap." };
    next.hours = hours;
  }
  if (input.closures !== undefined) {
    const closures = cleanClosures(input.closures);
    if (!closures) return { ok: false, field: "closures", error: "A closure date is not a real date." };
    next.closures = closures;
  }
  return { ok: true, location: next };
}

/** Bookings, upcoming bookings and calls — what archiving keeps and deleting would lose. */
export function locationUsage(location: Location, today = new Date().toISOString().slice(0, 10)) {
  const bookings = listBookings({ locationId: location.id });
  return {
    bookings: bookings.length,
    upcoming: bookings.filter((b) => b.status === "confirmed" && b.date >= today).length,
    calls: listCalls(location.id).length,
  };
}

function ownVenue(location: Location | undefined, user: User): location is Location {
  return Boolean(location && location.tenantId === user.tenantId && !location.internal && !location.prospect && !location.demo?.enabled);
}

export function createLocation(user: User, input: LocationInput): LocationResult {
  if (!canManageUsers(user)) return { ok: false, error: "Only the owner can add a location." };
  // The dashboard's list sends `trade`, which is worked back to an engine.
  // An explicit `vertical` still has to be one the engine actually has, so a
  // trade key can never arrive dressed as one.
  const tradeKey = tradeFromParam(input.trade);
  const vertical =
    input.vertical === undefined && input.trade !== undefined
      ? verticalForTrade(input.trade)
      : (String(input.vertical ?? "") as Vertical);
  if (!["salon", "clinic", "restaurant"].includes(vertical)) {
    return { ok: false, field: "vertical", error: "Choose what kind of business this location is." };
  }
  const siblings = listLocationsFor(user.tenantId, { includeArchived: true });
  const businessId = siblings[0]?.businessId ?? `biz_${user.tenantId}`;
  const timezone = String(input.timezone ?? "").trim() || siblings[0]?.timezone || "Asia/Dubai";
  // Checked before the venue is built: its trial dates are worked out in this
  // timezone, and an invalid one would throw rather than be refused.
  if (!validTimezone(timezone)) return { ok: false, field: "timezone", error: "That is not a timezone we recognise." };

  const base = blankVenue(
    { businessName: String(input.name ?? "").trim() || "New location", email: user.email, password: "", vertical, trade: tradeKey, timezone },
    user.tenantId,
    businessId,
  );
  const applied = applyBasics(base, { currency: siblings[0]?.currency, ...input, vertical: undefined });
  if (!applied.ok) return applied;

  const location = upsertLocation(applied.location);
  ensureBaseline(location);

  // Anyone limited to a list of venues who created this one can see it.
  if (user.locationIds.length > 0) saveUser({ ...user, locationIds: [...user.locationIds, location.id] });
  return { ok: true, location };
}

export function updateLocationBasics(user: User, locationId: string, input: LocationInput): LocationResult {
  const location = getLocation(locationId);
  if (!ownVenue(location, user)) return { ok: false, error: "Not your location." };
  if (user.role === "staff") return { ok: false, error: "Ask a manager to change this location." };
  if (input.vertical !== undefined && input.vertical !== location.vertical) {
    return { ok: false, field: "vertical", error: "The kind of business cannot change. Add a new location instead." };
  }
  const applied = applyBasics(location, input);
  if (!applied.ok) return applied;
  return { ok: true, location: upsertLocation(applied.location) };
}

export function archiveLocation(user: User, locationId: string): LocationResult {
  if (!canManageUsers(user)) return { ok: false, error: "Only the owner can archive a location." };
  const location = getLocation(locationId);
  if (!ownVenue(location, user)) return { ok: false, error: "Not your location." };
  if (location.archivedAt) return { ok: true, location };
  const active = listLocationsFor(user.tenantId).filter((l) => l.id !== location.id);
  if (active.length === 0) return { ok: false, error: "This is your only active location. Add another before archiving it." };
  return { ok: true, location: upsertLocation({ ...location, archivedAt: new Date().toISOString() }) };
}

export function restoreLocation(user: User, locationId: string): LocationResult {
  if (!canManageUsers(user)) return { ok: false, error: "Only the owner can restore a location." };
  const location = getLocation(locationId);
  if (!ownVenue(location, user)) return { ok: false, error: "Not your location." };
  const { archivedAt: _gone, ...restored } = location;
  return { ok: true, location: upsertLocation(restored as Location) };
}

export function deleteLocation(user: User, locationId: string, confirmName: string): { ok: true } | { ok: false; error: string } {
  if (!canManageUsers(user)) return { ok: false, error: "Only the owner can delete a location." };
  const location = getLocation(locationId);
  if (!ownVenue(location, user)) return { ok: false, error: "Not your location." };
  if (!location.archivedAt) return { ok: false, error: "Archive the location first." };
  const usage = locationUsage(location);
  if (usage.bookings > 0 || usage.calls > 0) {
    return { ok: false, error: `This location has ${usage.bookings} bookings and ${usage.calls} calls. It stays archived so that history is kept.` };
  }
  if (confirmName.trim() !== location.name) return { ok: false, error: "Type the location's name exactly to delete it." };

  removeLocation(location.id);
  for (const person of listUsersFor(user.tenantId)) {
    if (person.locationIds.includes(location.id)) {
      saveUser({ ...person, locationIds: person.locationIds.filter((id) => id !== location.id) });
    }
  }
  return { ok: true };
}
