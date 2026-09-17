import type { Location, User, Vertical, WeeklyHours } from "./types";
import { tradeFromParam, verticalForTrade } from "./signup-rules";
import {
  getLocation,
  getTenant,
  listBookings,
  listCalls,
  listLocationsFor,
  listUsersFor,
  removeLocation,
  saveUser,
  upsertLocation,
} from "./store";
import { canManageUsers } from "./auth";
import { userCanSeeLocation } from "./tenancy";
import { ensureBaseline } from "./brain";
import { requireE164 } from "./phone";
import { blankVenue } from "./onboarding";
import { canChoosePlan } from "./billing/entitlement";
import { TRIAL } from "./billing/plans";
import { releaseNumber } from "./telephony/pool";

/**
 * Adding, changing, archiving and deleting a business's locations.
 *
 * A second branch used to be impossible to add, and a closed one impossible to
 * remove, which is the kind of gap that makes software feel like a pilot.
 * These rules keep this safe:
 *
 *   Only an owner adds, archives or deletes. A manager may edit the basics of
 *   the venues they can see; floor staff change none of it.
 *
 *   A free trial covers one location. Each location has its own plan
 *   (billing/plans.ts `VOLUME`, and every plan's "One location"), and each new
 *   one starts its own trial — so an account with no paid plan anywhere could
 *   otherwise open trial after trial by adding branches. Once one location
 *   pays, more can be added. See `addAllowance`.
 *
 *   Archive is the normal way out, and "Delete" on a venue with history means
 *   archive. An archived venue keeps every booking, call and version,
 *   disappears from every list and switcher, stops answering on every channel
 *   (`serviceState` refuses it with `archived`; the dialled-number, embed-key
 *   and chat-link lookups all go through `listLocations`, which leaves it out),
 *   and can be restored. It keeps its Belline number while archived, so a
 *   restore answers on the same line; nobody else can be given it meanwhile.
 *
 *   Delete for good is only for a venue with no history at all — a mistake
 *   made five minutes ago. The row is removed and its pool number goes into
 *   quarantine (telephony/pool.ts), so an old caller never reaches a new venue.
 *   A soft delete would leave nothing to delete for good; erasing a venue with
 *   bookings and calls would erase its customers' records, so that is refused.
 *
 *   A business always keeps one active location. Archiving or deleting the
 *   last one would leave an account nobody can use.
 *
 *   A location carrying a paid plan is neither archived nor deleted. Stripe
 *   would go on charging for a venue that no longer answers; the plan is
 *   cancelled in Billing first, and runs to the end of its period.
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
  // With its country code, always (lib/phone.ts): a number that is new or
  // changed must arrive as E.164. One sent back exactly as stored is kept, so a
  // venue saved before this rule can still change its hours. `phone` here is
  // the business's own number; the Belline number is only ever set by the pool
  // or by staff, never from this form.
  if (input.phone !== undefined && String(input.phone).trim() !== location.businessPhone.trim()) {
    const raw = String(input.phone).trim();
    if (raw) {
      const strict = requireE164(raw);
      if (!strict.ok) return { ok: false, field: "phone", error: strict.reason };
      next.businessPhone = strict.e164;
    } else {
      next.businessPhone = "";
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

/** A customer's own venues that are not archived — the ones that answer. */
function activeVenues(tenantId: string): Location[] {
  return listLocationsFor(tenantId).filter((l) => !l.prospect && !l.demo?.enabled);
}

/**
 * Is somebody paying for this location right now?
 *
 * An `active` subscription, or a Stripe subscription that has not been
 * cancelled (a webhook can land after the id is stored). A trial is not paid —
 * nothing is charged — and a cancelled plan charges nothing more, so neither
 * stops a venue being archived.
 */
export function carriesPaidPlan(location: Location): boolean {
  const sub = location.subscription;
  if (!sub) return false;
  if (sub.status === "active") return true;
  return Boolean(location.stripe?.subscriptionId && sub.status !== "cancelled");
}

export type AddAllowance = { allowed: true; sentence: string } | { allowed: false; reason: string; choosePlan: boolean };

/**
 * May this person add another location? Checked by `createLocation` and shown
 * by the Locations page, so the button is only offered when it would work.
 */
export function addAllowance(user: User): AddAllowance {
  if (!canManageUsers(user)) return { allowed: false, reason: "Only the owner can add a location.", choosePlan: false };
  const sentence = `Each new location starts its own ${TRIAL.days}-day trial, then needs its own plan.`;
  // Belline's own tenants are not billed; venues from before billing had no
  // subscription at all and are treated as they always were.
  if (getTenant(user.tenantId)?.internal) return { allowed: true, sentence };
  const active = activeVenues(user.tenantId);
  if (active.length === 0 || active.some((l) => !l.subscription || carriesPaidPlan(l))) return { allowed: true, sentence };

  // The checkout subscribes the account's first venue (api/checkout), so that
  // is the one named.
  const choosePlan = canChoosePlan();
  return {
    allowed: false,
    choosePlan,
    reason: choosePlan
      ? `Your free trial covers one location. Choose a plan for ${active[0].name} and you can add more — each location has its own plan.`
      : `Your free trial covers one location. Card payments are not open yet, so there is no plan to choose; you can add another location once ${active[0].name} is on a plan.`,
  };
}

/**
 * What the owner may do to take a location away, and why not. `null` means
 * allowed. The same checks run in `archiveLocation` and `deleteLocation`; this
 * is so the page can explain them before anybody presses anything.
 */
export interface RemovalBlock {
  /** Which rule, so the page can offer the way out: Billing, Team, or archiving instead. */
  code: "owner" | "last" | "paid" | "history" | "stranded";
  reason: string;
}

export interface Removal {
  archive: RemovalBlock | null;
  delete: RemovalBlock | null;
  usage: ReturnType<typeof locationUsage>;
}

export function removalOf(user: User, location: Location): Removal {
  const usage = locationUsage(location);
  if (!canManageUsers(user)) {
    const no: RemovalBlock = { code: "owner", reason: "Only the owner can archive or delete a location." };
    return { archive: no, delete: no, usage };
  }
  const block = (code: RemovalBlock["code"], reason: string): RemovalBlock => ({ code, reason });
  const others = activeVenues(user.tenantId).filter((l) => l.id !== location.id);
  const last = !location.archivedAt && others.length === 0
    ? block("last", "This is your only active location, so it cannot be archived or deleted. Add another location first.")
    : null;
  const paid = carriesPaidPlan(location)
    ? block("paid", "This location carries your paid plan. Cancel the plan in Billing first — it keeps answering to the end of the paid period — then archive or delete it.")
    : null;
  const history = usage.bookings > 0 || usage.calls > 0
    ? block(
        "history",
        `This location has ${usage.bookings} booking${usage.bookings === 1 ? "" : "s"} and ${usage.calls} call${usage.calls === 1 ? "" : "s"}, ` +
          "so it cannot be deleted for good — that would erase your customers' records. Archive it instead: it stops answering and leaves every list, and the history is kept.",
      )
    : null;
  // A team member who can see only this venue: removing it would empty their
  // list, and an empty list means *every* location (tenancy.ts).
  const onlyHere = listUsersFor(user.tenantId).find((p) => p.locationIds.length === 1 && p.locationIds[0] === location.id);
  const stranded = onlyHere
    ? block("stranded", `${onlyHere.name} can only see this location. Give them another location in Team, or remove them, before deleting it.`)
    : null;
  return {
    archive: location.archivedAt ? null : (last ?? paid),
    delete: last ?? paid ?? history ?? stranded,
    usage,
  };
}

export function createLocation(user: User, input: LocationInput): LocationResult {
  const allowance = addAllowance(user);
  if (!allowance.allowed) return { ok: false, error: allowance.reason };
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
  // Inside the tenant, too: a manager limited to one branch edits that branch.
  if (!ownVenue(location, user) || !userCanSeeLocation(user, location)) return { ok: false, error: "Not your location." };
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
  const refused = removalOf(user, location).archive;
  if (refused) return { ok: false, error: refused.reason };
  return { ok: true, location: upsertLocation({ ...location, archivedAt: new Date().toISOString() }) };
}

export function restoreLocation(user: User, locationId: string): LocationResult {
  if (!canManageUsers(user)) return { ok: false, error: "Only the owner can restore a location." };
  const location = getLocation(locationId);
  if (!ownVenue(location, user)) return { ok: false, error: "Not your location." };
  if (!location.archivedAt) return { ok: true, location };
  // A restore adds an answering location, so it follows the same limit as
  // adding one: otherwise archive-and-restore is a way round the trial rule.
  const allowance = addAllowance(user);
  if (!allowance.allowed) return { ok: false, error: allowance.reason };
  const { archivedAt: _gone, ...restored } = location;
  return { ok: true, location: upsertLocation(restored as Location) };
}

export function deleteLocation(user: User, locationId: string, confirmName: string): { ok: true } | { ok: false; error: string } {
  if (!canManageUsers(user)) return { ok: false, error: "Only the owner can delete a location." };
  const location = getLocation(locationId);
  if (!ownVenue(location, user)) return { ok: false, error: "Not your location." };
  // Active or archived: an empty venue made by mistake need not be archived
  // first. Every rule — last location, paid plan, history, a team member who
  // would be left seeing everything — is in `removalOf`.
  const refused = removalOf(user, location).delete;
  if (refused) return { ok: false, error: refused.reason };
  if (confirmName.trim() !== location.name) return { ok: false, error: "Type the location's name exactly to delete it." };

  // Its Belline number goes into quarantine rather than straight back to the
  // pool, so somebody who still has it saved never reaches a new venue.
  releaseNumber(location.id);
  removeLocation(location.id);
  for (const person of listUsersFor(user.tenantId)) {
    if (person.locationIds.includes(location.id)) {
      saveUser({ ...person, locationIds: person.locationIds.filter((id) => id !== location.id) });
    }
  }
  return { ok: true };
}
