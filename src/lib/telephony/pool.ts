import type { Location, PoolNumber } from "../types";
import { getLocation, listLocations, listPoolRows, mutatePool, upsertLocation } from "../store";
import { flag } from "../flags";
import { openException } from "../exceptions";
import { BELLINE_TENANT_ID } from "../tenancy";
import { freshOnboarding } from "../onboarding/journey";
import { bellineNumberOf } from "./number";

/**
 * Belline numbers, handed out by code.
 *
 * A person buys the numbers — in Twilio, under the UAE bundle, each one with
 * its Voice URL already pointing at /api/twilio/voice — and adds them here.
 * From then on a signup that asks for a number gets one in the same request:
 * the voice webhook routes by the number dialled, so writing it on the venue
 * is all that assigning it takes.
 *
 * With `numbers.pool` off, or no free number left, the owner sees "being
 * prepared" and a `pool_empty` ticket is opened, so a person at Belline
 * assigns one by hand. The owner is never shown a pretend number.
 *
 * Not built yet: reconciling the pool against Twilio's own list, and
 * re-pointing a number's Voice URL from here. Both need live Twilio calls.
 */

/** A released number stays out of the pool this long, so old customers' callers do not reach a new venue. */
export const QUARANTINE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Below this many free numbers, the team is told to buy more. */
export function lowWater(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.NUMBER_POOL_LOW_WATER);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

const digits = (n: string) => n.replace(/\D/g, "");

export type AssignResult =
  | { state: "assigned"; number: string; created: boolean }
  | { state: "preparing"; reason: "flag_off" | "pool_empty"; ticket: string };

/** Numbers somebody else already answers on, whatever the pool says. */
function heldNumbers(except?: string): Set<string> {
  return new Set(
    listLocations({ includeInternal: true, includeArchived: true })
      .filter((l) => l.id !== except && l.phone.trim())
      .map((l) => digits(l.phone)),
  );
}

/** Quarantined numbers whose 30 days are up go back to free. */
function releaseQuarantine(rows: PoolNumber[], now: Date): void {
  for (const row of rows) {
    if (row.status === "quarantine" && row.releasedAt && now.getTime() - Date.parse(row.releasedAt) >= QUARANTINE_DAYS * DAY_MS) {
      row.status = "free";
      delete row.locationId;
      delete row.assignedAt;
      delete row.assignedBy;
    }
  }
}

export function poolSummary(now: Date = new Date()): { free: number; assigned: number; quarantine: number } {
  const rows = listPoolRows();
  const due = (r: PoolNumber) => r.status === "quarantine" && r.releasedAt && now.getTime() - Date.parse(r.releasedAt) >= QUARANTINE_DAYS * DAY_MS;
  return {
    free: rows.filter((r) => r.status === "free" || due(r)).length,
    assigned: rows.filter((r) => r.status === "assigned").length,
    quarantine: rows.filter((r) => r.status === "quarantine" && !due(r)).length,
  };
}

/** Add bought numbers. Duplicates and malformed entries are skipped and reported. */
export function addPoolNumbers(numbers: string[], now: Date = new Date()): { added: string[]; skipped: string[] } {
  const at = now.toISOString();
  return mutatePool((rows) => {
    const added: string[] = [];
    const skipped: string[] = [];
    const known = new Set(rows.map((r) => digits(r.number)));
    for (const raw of numbers) {
      const d = digits(raw);
      if (!raw.trim().startsWith("+") || d.length < 8 || d.length > 15 || known.has(d)) {
        skipped.push(raw);
        continue;
      }
      known.add(d);
      rows.push({ number: `+${d}`, status: "free", addedAt: at });
      added.push(`+${d}`);
    }
    return { added, skipped };
  });
}

function preparing(location: Location, reason: "flag_off" | "pool_empty"): AssignResult {
  // One open row per venue: asking again only counts it.
  const opened = openException({
    tenantId: location.tenantId,
    locationId: location.id,
    kind: "pool_empty",
    reason:
      reason === "flag_off"
        ? "Asked for a Belline number. Numbers are assigned by hand until the pool is switched on."
        : "Asked for a Belline number and the pool had none free. Add numbers to the pool or assign one by hand.",
    context: { reason },
    source: "system",
  });
  return { state: "preparing", reason, ticket: opened.exception.ticket };
}

/**
 * Give a venue its Belline number.
 *
 * Idempotent: a venue with a number gets that number back. The claim reads and
 * writes the pool in one synchronous step (`mutatePool`), so twenty signups at
 * once get twenty different numbers or a "being prepared", never a shared one.
 */
export function assignNumber(location: Location, now: Date = new Date(), env: Record<string, string | undefined> = process.env): AssignResult {
  const current = getLocation(location.id) ?? location;
  // Belline's number, not whatever is in `phone`: the review step saves the
  // business's own line there, and that is not a number calls forward to.
  const existing = bellineNumberOf(current);
  if (existing) return { state: "assigned", number: existing, created: false };
  if (!flag("numbers.pool", env)) return preparing(current, "flag_off");

  const held = heldNumbers(current.id);
  const claimed = mutatePool((rows) => {
    releaseQuarantine(rows, now);
    const row = rows.find((r) => r.status === "free" && !held.has(digits(r.number)));
    if (!row) return null;
    row.status = "assigned";
    row.locationId = current.id;
    row.assignedAt = now.toISOString();
    row.assignedBy = "pool";
    return { number: row.number, left: rows.filter((r) => r.status === "free").length };
  });
  if (!claimed) return preparing(current, "pool_empty");

  const o = current.onboarding ?? freshOnboarding();
  upsertLocation({
    ...current,
    phone: claimed.number,
    onboarding: { ...o, channels: { ...o.channels, phone: { ...o.channels.phone, numberAssignedAt: now.toISOString() } } },
  });

  if (claimed.left < lowWater(env)) {
    openException({
      tenantId: BELLINE_TENANT_ID,
      kind: "vendor_balance_low",
      reason: `The number pool is running low: ${claimed.left} free after the last assignment. Buy more numbers before it is empty.`,
      context: { pool: "numbers", free: claimed.left },
      source: "system",
    });
  }
  return { state: "assigned", number: claimed.number, created: true };
}

/**
 * Record a number a member of staff set by hand. A pool number is marked
 * taken, so code never hands it to anybody else.
 */
export function recordManualAssignment(locationId: string, number: string, by: string, now: Date = new Date()): void {
  const d = digits(number);
  if (!d) return;
  mutatePool((rows) => {
    const row = rows.find((r) => digits(r.number) === d);
    if (row) Object.assign(row, { status: "assigned", locationId, assignedAt: now.toISOString(), assignedBy: by });
  });
}

/** Give a venue's number back. It is quarantined for 30 days before anyone else gets it. */
export function releaseNumber(locationId: string, now: Date = new Date()): string | null {
  return mutatePool((rows) => {
    const row = rows.find((r) => r.status === "assigned" && r.locationId === locationId);
    if (!row) return null;
    row.status = "quarantine";
    row.releasedAt = now.toISOString();
    return row.number;
  });
}

/** `STUB_POOL=+97140000001,+97140000002`, added once at boot under stubs. */
export function seedStubPool(env: Record<string, string | undefined> = process.env): void {
  if (!flag("stubs", env)) return;
  const numbers = (env.STUB_POOL ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  if (numbers.length) addPoolNumbers(numbers);
}
