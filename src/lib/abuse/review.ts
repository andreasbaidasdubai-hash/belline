import type { AbuseRecord, Location, Tenant } from "../types";
import { getBusiness, getLocation, getTenant, id, listAbuseRows, listLocations, listTenants, saveAbuseRow, saveTenant } from "../store";
import { flag } from "../flags";
import { keysOf, type BusinessKeys } from "./business-key";

/**
 * Stopping one business from farming free trials, and the staff review of it.
 *
 * Four cheap signals, each recorded for a person to look at rather than
 * trusted blindly:
 *
 *   one trial per business  a website domain, business phone or card that
 *                           another account's trial or paid plan already has
 *   throwaway email         a mailbox made to be discarded (business-key.ts)
 *   per network, per device new trials started from one IP address or one
 *                           browser in the last 30 days
 *   many signups, one IP    more than one in a day: flagged, not refused
 *
 * Who is screened: only accounts opened by self-serve signup since this
 * shipped, which carry `tenant.signup`. Every account that predates it —
 * production's test venues and fixtures included — is never refused, and is
 * still matched against as the account that already exists.
 *
 * Staff decide in the sales console (Abuse review): allow (the override: the
 * account, address or network is let through from then on), note, or suspend
 * the trial.
 */

export const TRIAL_LIMITS = {
  /** New trials from one IP address in `windowDays`. */
  perIp: 3,
  /** New trials from one browser (the device cookie) in `windowDays`. */
  perDevice: 2,
  windowDays: 30,
  /** More signups than this from one IP in a day are flagged for review. */
  flagIpPerDay: 1,
} as const;

export const DEVICE_COOKIE = "belline_device";

/** What the owner is told when their business already has an account. */
export const DUPLICATE_MESSAGE =
  "This business already has a Belline account — sign in or contact us. A business gets one free trial.";
export const DUPLICATE_PAGE = "/account-exists";

export const DISPOSABLE_MESSAGE =
  "That looks like a temporary email address. Use a work or personal address you'll keep, so you can get back into your account.";

export const LIMIT_MESSAGE =
  "Several free trials have already been started from here recently. If you run more than one business, contact us and we'll set the others up for you.";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

type NewRecord = Omit<AbuseRecord, "id" | "at" | "count" | "lastAt" | "status" | "notes">;

/** The same thing, still open: same kind, and the same account, address, network or device. */
function sameSubject(a: Pick<AbuseRecord, "kind" | "tenantId" | "email" | "ip" | "device" | "match">, b: NewRecord): boolean {
  if (a.kind !== b.kind) return false;
  switch (b.kind) {
    case "duplicate_business":
      return a.tenantId === b.tenantId && a.match?.tenantId === b.match?.tenantId;
    case "disposable_email":
      return a.email === b.email;
    case "ip_limit":
    case "many_signups_ip":
      return a.ip === b.ip;
    case "device_limit":
      return a.device === b.device;
  }
}

/** Record something for review. Raised again while undecided, it is counted on the open row. */
export function recordAbuse(input: NewRecord, now: Date = new Date()): AbuseRecord {
  const at = now.toISOString();
  const open = listAbuseRows().find((r) => r.status === "open" && sameSubject(r, input));
  if (open) return saveAbuseRow({ ...open, ...input, count: open.count + 1, lastAt: at });
  return saveAbuseRow({ id: id("abu"), at, lastAt: at, count: 1, status: "open", notes: [], ...input });
}

export function listAbuse(filter: { status?: AbuseRecord["status"] | "all" } = {}): AbuseRecord[] {
  const status = filter.status ?? "open";
  return listAbuseRows()
    .filter((r) => status === "all" || r.status === status)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Has staff allowed this address, network or device? */
function allowed(kind: AbuseRecord["kind"], match: (r: AbuseRecord) => boolean): boolean {
  return listAbuseRows().some((r) => r.kind === kind && r.status === "allowed" && match(r));
}

export function emailAllowed(email: string): boolean {
  const e = email.trim().toLowerCase();
  return allowed("disposable_email", (r) => r.email === e);
}

// ---------------------------------------------------------------------------
// Who is screened
// ---------------------------------------------------------------------------

/** Opened by self-serve signup since screening shipped, and not allowed by staff. */
export function screened(tenant: Tenant | undefined): boolean {
  return Boolean(tenant?.signup && !tenant.abuse?.allowedAt);
}

export function trialSuspended(tenantId: string): boolean {
  return Boolean(getTenant(tenantId)?.abuse?.trialSuspendedAt);
}

/** Loopback is exempt only in a stubbed local run, where every browser is this machine. */
function localRun(ip: string | undefined): boolean {
  return flag("stubs") && (!ip || ip === "unknown" || ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1");
}

// ---------------------------------------------------------------------------
// At signup
// ---------------------------------------------------------------------------

export type SignupScreen = { ok: true } | { ok: false; kind: "ip_limit" | "device_limit"; error: string };

const DAY_MS = 86_400_000;

/**
 * May another trial start from this network and browser? Counted from the
 * accounts themselves (`tenant.signup`), so a redeploy does not reset it.
 * Refusals and bursts are recorded.
 */
export function screenSignup(input: { ip?: string; device?: string; email: string }, now: Date = new Date()): SignupScreen {
  const since = now.getTime() - TRIAL_LIMITS.windowDays * DAY_MS;
  const recent = listTenants().filter((t) => t.signup && Date.parse(t.signup.at) >= since);
  const ip = input.ip && input.ip !== "unknown" ? input.ip : undefined;

  if (ip && !localRun(ip)) {
    const fromIp = recent.filter((t) => t.signup!.ip === ip);
    if (fromIp.length >= TRIAL_LIMITS.perIp && !allowed("ip_limit", (r) => r.ip === ip)) {
      recordAbuse({ kind: "ip_limit", ip, device: input.device, email: input.email, stage: "signup" }, now);
      return { ok: false, kind: "ip_limit", error: LIMIT_MESSAGE };
    }
    const today = fromIp.filter((t) => Date.parse(t.signup!.at) >= now.getTime() - DAY_MS);
    if (today.length >= TRIAL_LIMITS.flagIpPerDay) {
      recordAbuse({ kind: "many_signups_ip", ip, email: input.email, stage: "signup" }, now);
    }
  }
  if (input.device && !localRun(ip)) {
    const fromDevice = recent.filter((t) => t.signup!.device === input.device);
    if (fromDevice.length >= TRIAL_LIMITS.perDevice && !allowed("device_limit", (r) => r.device === input.device)) {
      recordAbuse({ kind: "device_limit", ip, device: input.device, email: input.email, stage: "signup" }, now);
      return { ok: false, kind: "device_limit", error: LIMIT_MESSAGE };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// One trial per business
// ---------------------------------------------------------------------------

export interface DuplicateMatch {
  by: "domain" | "phone" | "card";
  value: string;
  location: Location;
}

/** Venues that count as a business having had Belline: a trial or a plan, not ours, not a demo. */
function accountsToMatch(exceptTenant: string): Location[] {
  return listLocations({ includeArchived: true }).filter((l) => {
    if (l.tenantId === exceptTenant || !l.subscription) return false;
    if (l.internal || l.demo?.enabled || l.prospect) return false;
    return !getTenant(l.tenantId)?.internal;
  });
}

function keysFor(location: Location, extra?: { website?: string; phone?: string }): BusinessKeys {
  return keysOf(location, getBusiness(location.tenantId, location.businessId), extra);
}

/** Another account's trial or plan with the same domain, phone or card. Null when none. */
export function findDuplicate(location: Location, extra: { website?: string; phone?: string } = {}): DuplicateMatch | null {
  const mine = keysFor(location, extra);
  if (!mine.domains.length && !mine.phones.length && !mine.cards.length) return null;
  for (const other of accountsToMatch(location.tenantId)) {
    const theirs = keysFor(other);
    const card = mine.cards.find((c) => theirs.cards.includes(c));
    if (card) return { by: "card", value: card, location: other };
    const domain = mine.domains.find((d) => theirs.domains.includes(d));
    if (domain) return { by: "domain", value: domain, location: other };
    const phone = mine.phones.find((p) => theirs.phones.includes(p));
    if (phone) return { by: "phone", value: phone, location: other };
  }
  return null;
}

export interface AbuseRefusal {
  status: number;
  error: string;
  fix: string;
  code: "duplicate_business" | "trial_suspended" | "email_unverified";
}

/**
 * Refuse a second free trial for a business that already has an account.
 *
 * Only for a screened account (above) still on its trial: a business that has
 * chosen a plan is paying, and one staff allowed is allowed. The match is
 * recorded for review every time it refuses.
 */
export function screenTrial(location: Location, stage: string, extra: { website?: string; phone?: string } = {}, now: Date = new Date()): AbuseRefusal | null {
  const tenant = getTenant(location.tenantId);
  if (!screened(tenant)) return null;
  if (location.subscription && location.subscription.status !== "trialing") return null;
  const match = findDuplicate(location, extra);
  if (!match) return null;
  recordAbuse(
    {
      kind: "duplicate_business",
      tenantId: location.tenantId,
      locationId: location.id,
      email: tenant?.signup?.email,
      stage,
      match: { by: match.by, value: match.value, tenantId: match.location.tenantId, locationId: match.location.id, name: match.location.name },
    },
    now,
  );
  return { status: 409, error: DUPLICATE_MESSAGE, fix: DUPLICATE_PAGE, code: "duplicate_business" };
}

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------

export type StaffAction = "allow" | "note" | "suspend" | "unsuspend";

export function decide(
  recordId: string,
  action: StaffAction,
  by: string,
  note = "",
  now: Date = new Date(),
): { ok: true; record: AbuseRecord } | { ok: false; status: number; error: string } {
  const row = listAbuseRows().find((r) => r.id === recordId);
  if (!row) return { ok: false, status: 404, error: "No such record." };
  const at = now.toISOString();
  const text = note.trim().slice(0, 1000);
  const notes = text ? [...row.notes, { at, by, text }] : row.notes;

  if (action === "note") {
    if (!text) return { ok: false, status: 422, error: "Write the note first." };
    return { ok: true, record: saveAbuseRow({ ...row, notes, status: row.status === "open" ? "noted" : row.status, decidedBy: by, decidedAt: at }) };
  }

  const tenant = row.tenantId ? getTenant(row.tenantId) : undefined;
  if (action === "allow") {
    if (tenant) {
      saveTenant({ ...tenant, abuse: { ...tenant.abuse, allowedAt: at, allowedBy: by, trialSuspendedAt: undefined, trialSuspendedBy: undefined } });
    }
    return { ok: true, record: saveAbuseRow({ ...row, notes, status: "allowed", decidedBy: by, decidedAt: at }) };
  }

  if (!tenant) return { ok: false, status: 422, error: "This record has no account to suspend." };
  if (action === "suspend") {
    saveTenant({ ...tenant, abuse: { ...tenant.abuse, trialSuspendedAt: at, trialSuspendedBy: by } });
    return { ok: true, record: saveAbuseRow({ ...row, notes, status: "suspended", decidedBy: by, decidedAt: at }) };
  }
  saveTenant({ ...tenant, abuse: { ...tenant.abuse, trialSuspendedAt: undefined, trialSuspendedBy: undefined } });
  return { ok: true, record: saveAbuseRow({ ...row, notes, status: "noted", decidedBy: by, decidedAt: at }) };
}

/** A venue's own name, for the review list. */
export function venueName(locationId: string | undefined): string | undefined {
  return locationId ? getLocation(locationId)?.name : undefined;
}
