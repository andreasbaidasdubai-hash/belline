import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  Booking,
  Business,
  Call,
  Location,
  Session,
  Tenant,
  User,
  WaitlistEntry,
} from "./types";
import type { Lead } from "./leads";

/**
 * File-backed store.
 *
 * Deliberately boring: one JSON file per collection, held in memory, written
 * atomically (temp file + rename) on mutation. That is enough for a single
 * node running one venue group, it needs no native modules on Windows, and
 * every call site goes through the narrow interface at the bottom of this
 * file — so swapping in Postgres later is one file's work, not a refactor.
 */

/**
 * Where the book lives. Override with DATA_DIR in a container and point it at
 * a mounted volume — a container's own filesystem is wiped on every deploy,
 * and losing the book on a redeploy is not a survivable failure for a venue.
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

interface Db {
  tenants: Tenant[];
  businesses: Business[];
  locations: Location[];
  bookings: Booking[];
  waitlist: WaitlistEntry[];
  calls: Call[];
  users: User[];
  sessions: Session[];
  leads: Lead[];
}

const EMPTY: Db = {
  tenants: [],
  businesses: [],
  locations: [],
  bookings: [],
  waitlist: [],
  calls: [],
  users: [],
  sessions: [],
  leads: [],
};

// Next's dev server re-evaluates modules on edit; the custom server holds the
// voice sessions in the same process. A global pin keeps one instance of the
// cache across both so a booking made on a call is visible to the dashboard.
const globalRef = globalThis as unknown as {
  __bellineDb?: Db;
  __bellineStamps?: Record<string, number>;
  __bellineCheckedAt?: number;
};

/**
 * How often to ask the filesystem whether another process has changed
 * anything. Checking on every read costs five `stat` calls, which is nothing
 * on its own but measurable inside an availability search that reads the book
 * repeatedly while a caller waits. A quarter of a second is imperceptible to
 * someone running a CLI command and free on the hot path.
 */
const RELOAD_CHECK_MS = 250;

function fileStamp(key: keyof Db): number {
  try {
    return fs.statSync(path.join(DATA_DIR, `${key}.json`)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Never assume the companion globals exist. A dev-server hot reload can
 * re-evaluate this module while `globalThis` still holds a cache written by
 * the previous evaluation, which leaves the two out of step — and reading
 * through a bare `!` there crashes every page at once.
 */
function stamps(): Record<string, number> {
  globalRef.__bellineStamps ??= {};
  return globalRef.__bellineStamps;
}

function readCollection(db: Db, key: keyof Db): void {
  try {
    db[key] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${key}.json`), "utf8"));
  } catch {
    db[key] = [] as never;
  }
  stamps()[key] = fileStamp(key);
}

function load(): Db {
  if (globalRef.__bellineDb) {
    // Re-read anything another process has changed since we last looked.
    // Without this the CLI and the server disagree: `npm run user -- reset`
    // writes the file, the long-running server keeps serving the old copy,
    // and the password appears not to have changed.
    const now = Date.now();
    if (now - (globalRef.__bellineCheckedAt ?? 0) >= RELOAD_CHECK_MS) {
      globalRef.__bellineCheckedAt = now;
      const db = globalRef.__bellineDb;
      for (const key of Object.keys(EMPTY) as (keyof Db)[]) {
        if (fileStamp(key) !== stamps()[key]) {
          readCollection(db, key);
        }
      }
    }
    return globalRef.__bellineDb;
  }

  const db: Db = { ...EMPTY };
  globalRef.__bellineStamps = {};
  globalRef.__bellineCheckedAt = Date.now();
  for (const key of Object.keys(EMPTY) as (keyof Db)[]) {
    readCollection(db, key);
  }
  globalRef.__bellineDb = db;
  return db;
}

/**
 * Write a collection.
 *
 * Temp file plus rename, so a crash mid-write cannot leave a half-written
 * book on disk. The retry is not paranoia: this tree sits inside OneDrive,
 * and a sync agent holding the target file for a few milliseconds makes
 * `rename` fail with EPERM on Windows. Without the retry that surfaces as a
 * booking silently lost during a call, which is the worst possible failure
 * for this product.
 */
function persist(key: keyof Db): void {
  const db = load();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${key}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const json = JSON.stringify(db[key], null, 2);

  fs.writeFileSync(tmp, json, "utf8");

  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      // Record our own write so the reload check above does not immediately
      // re-read a file we just wrote.
      stamps()[key] = fileStamp(key);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= 4) {
        // Last resort: overwrite in place. Loses atomicity, keeps the data.
        try {
          fs.writeFileSync(file, json, "utf8");
          fs.rmSync(tmp, { force: true });
          stamps()[key] = fileStamp(key);
          return;
        } catch {
          fs.rmSync(tmp, { force: true });
          throw err;
        }
      }
      // Busy-wait briefly — this runs on the request path, and the lock
      // clears in single-digit milliseconds.
      const until = Date.now() + 15 * (attempt + 1);
      while (Date.now() < until) {
        // spin
      }
    }
  }
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Booking reference a person can read back over the phone. Excludes the
 * characters that get misheard (0/O, 1/I, S/5) — a caller repeating "B0X1"
 * to a hostess is a support ticket waiting to happen.
 */
export function bookingRef(): string {
  const alphabet = "ACDEFGHJKMNPQRTUVWXY2346789";
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

// --- tenants and businesses -------------------------------------------------

export function listTenants(): Tenant[] {
  return load().tenants;
}

export function getTenant(tenantId: string): Tenant | undefined {
  return load().tenants.find((t) => t.id === tenantId);
}

export function saveTenant(tenant: Tenant): Tenant {
  const db = load();
  const i = db.tenants.findIndex((t) => t.id === tenant.id);
  if (i >= 0) db.tenants[i] = tenant;
  else db.tenants.push(tenant);
  persist("tenants");
  return tenant;
}

/**
 * The businesses in one tenant.
 *
 * The tenant id is the first argument and there is no overload without it.
 * Every accessor below that can cross a tenant boundary is shaped the same
 * way, so the mistake this guards against — a query written next year that
 * forgets — is a type error rather than a data leak.
 */
export function listBusinesses(tenantId: string): Business[] {
  return load().businesses.filter((b) => b.tenantId === tenantId);
}

export function getBusiness(tenantId: string, businessId: string): Business | undefined {
  return load().businesses.find((b) => b.id === businessId && b.tenantId === tenantId);
}

export function saveBusiness(business: Business): Business {
  const db = load();
  const i = db.businesses.findIndex((b) => b.id === business.id);
  if (i >= 0) db.businesses[i] = business;
  else db.businesses.push(business);
  persist("businesses");
  return business;
}

/** The venues of one tenant. Internal venues are excluded as everywhere else. */
export function listLocationsFor(
  tenantId: string,
  opts?: { includeInternal?: boolean },
): Location[] {
  return listLocations(opts).filter((l) => l.tenantId === tenantId);
}

/**
 * A venue, but only if it belongs to the tenant asking.
 *
 * `getLocation` by bare id still exists because the voice stream resolves a
 * venue from a signed token that names one, and the token is the entitlement.
 * Anything reached from a *session* should come through here instead.
 */
export function getLocationFor(tenantId: string, locationId: string): Location | undefined {
  const location = getLocation(locationId);
  return location && location.tenantId === tenantId ? location : undefined;
}

// --- locations -------------------------------------------------------------

/**
 * The venues a customer has.
 *
 * Belline's own venue — the demo-call diary behind the bell on the website —
 * is excluded unless asked for. It runs on the same engine as everybody
 * else's, which is the point of it, but it is not a venue anyone signed up
 * for and it has no business appearing in a switcher, a call list or a set of
 * bookings. Pass `includeInternal` where you genuinely mean all of them:
 * seeding, and the call page itself.
 */
export function listLocations(opts?: { includeInternal?: boolean }): Location[] {
  const all = load().locations;
  return opts?.includeInternal ? all : all.filter((l) => !l.internal);
}

/** By id, internal or not — a caller naming a venue has already chosen it. */
export function getLocation(locationId: string): Location | undefined {
  return load().locations.find((l) => l.id === locationId);
}

export function upsertLocation(location: Location): Location {
  const db = load();
  const idx = db.locations.findIndex((l) => l.id === location.id);
  if (idx === -1) db.locations.push(location);
  else db.locations[idx] = location;
  persist("locations");
  return location;
}

// --- bookings --------------------------------------------------------------

export function listBookings(filter?: {
  locationId?: string;
  date?: string;
  status?: Booking["status"];
}): Booking[] {
  let out = load().bookings;
  if (filter?.locationId) out = out.filter((b) => b.locationId === filter.locationId);
  if (filter?.date) out = out.filter((b) => b.date === filter.date);
  if (filter?.status) out = out.filter((b) => b.status === filter.status);
  return out;
}

export function getBooking(bookingId: string): Booking | undefined {
  return load().bookings.find((b) => b.id === bookingId);
}

export function findBookingByRef(locationId: string, ref: string): Booking | undefined {
  const wanted = ref.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return load().bookings.find(
    (b) => b.locationId === locationId && b.ref === wanted,
  );
}

export function findBookingsByPhone(locationId: string, phone: string): Booking[] {
  const digits = phone.replace(/\D/g, "").slice(-9);
  if (digits.length < 6) return [];
  return load().bookings.filter(
    (b) =>
      b.locationId === locationId &&
      b.status === "confirmed" &&
      b.guestPhone.replace(/\D/g, "").endsWith(digits),
  );
}

export function saveBooking(booking: Booking): Booking {
  const db = load();
  const idx = db.bookings.findIndex((b) => b.id === booking.id);
  if (idx === -1) db.bookings.push(booking);
  else db.bookings[idx] = booking;
  persist("bookings");
  return booking;
}

// --- waitlist ---------------------------------------------------------------

export function listWaitlist(filter?: {
  locationId?: string;
  date?: string;
  status?: WaitlistEntry["status"];
}): WaitlistEntry[] {
  return load()
    .waitlist.filter((w) => {
      if (filter?.locationId && w.locationId !== filter.locationId) return false;
      if (filter?.date && w.date !== filter.date) return false;
      if (filter?.status && w.status !== filter.status) return false;
      return true;
    })
    // Oldest first: whoever asked first gets the table.
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getWaitlistEntry(id: string): WaitlistEntry | undefined {
  return load().waitlist.find((w) => w.id === id);
}

export function saveWaitlistEntry(entry: WaitlistEntry): WaitlistEntry {
  const db = load();
  const idx = db.waitlist.findIndex((w) => w.id === entry.id);
  if (idx === -1) db.waitlist.push(entry);
  else db.waitlist[idx] = entry;
  persist("waitlist");
  return entry;
}

// --- calls -----------------------------------------------------------------

export function listCalls(locationId?: string): Call[] {
  const out = load().calls;
  return (locationId ? out.filter((c) => c.locationId === locationId) : out)
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function getCall(callId: string): Call | undefined {
  return load().calls.find((c) => c.id === callId);
}

export function saveCall(call: Call): Call {
  const db = load();
  const idx = db.calls.findIndex((c) => c.id === call.id);
  if (idx === -1) db.calls.unshift(call);
  else db.calls[idx] = call;
  persist("calls");
  return call;
}

// --- leads -----------------------------------------------------------------

/** Newest first: a sales list is worked from the top. */
export function listLeads(): Lead[] {
  return load().leads;
}

export function getLead(leadId: string): Lead | undefined {
  return load().leads.find((l) => l.id === leadId);
}

export function saveLead(lead: Lead): Lead {
  const db = load();
  const idx = db.leads.findIndex((l) => l.id === lead.id);
  if (idx === -1) db.leads.unshift(lead);
  else db.leads[idx] = lead;
  persist("leads");
  return lead;
}

// --- users and sessions ----------------------------------------------------

export function listUsers(): User[] {
  return load().users;
}

export function getUser(userId: string): User | undefined {
  return load().users.find((u) => u.id === userId);
}

export function findUserByEmail(email: string): User | undefined {
  const wanted = email.trim().toLowerCase();
  return load().users.find((u) => u.email.toLowerCase() === wanted);
}

export function saveUser(user: User): User {
  const db = load();
  const idx = db.users.findIndex((u) => u.id === user.id);
  if (idx === -1) db.users.push(user);
  else db.users[idx] = user;
  persist("users");
  return user;
}

export function deleteUser(userId: string): void {
  const db = load();
  db.users = db.users.filter((u) => u.id !== userId);
  db.sessions = db.sessions.filter((s) => s.userId !== userId);
  persist("users");
  persist("sessions");
}

export function getSession(sessionId: string): Session | undefined {
  return load().sessions.find((s) => s.id === sessionId);
}

export function saveSession(session: Session): Session {
  const db = load();
  const idx = db.sessions.findIndex((s) => s.id === session.id);
  if (idx === -1) db.sessions.push(session);
  else db.sessions[idx] = session;
  persist("sessions");
  return session;
}

/** Drop one session, or every session belonging to a user. */
export function deleteSessions(where: { sessionId?: string; userId?: string }): void {
  const db = load();
  const before = db.sessions.length;
  db.sessions = db.sessions.filter(
    (s) =>
      !(
        (where.sessionId && s.id === where.sessionId) ||
        (where.userId && s.userId === where.userId)
      ),
  );
  if (db.sessions.length !== before) persist("sessions");
}

/** Housekeeping: expired sessions are dead weight and a small liability. */
export function pruneSessions(): number {
  const db = load();
  const now = new Date().toISOString();
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.expiresAt > now);
  if (db.sessions.length !== before) {
    persist("sessions");
    return before - db.sessions.length;
  }
  return 0;
}

/** True when the store has never been seeded. */
export function isEmpty(): boolean {
  return load().locations.length === 0;
}

/** True before anyone has created an account — triggers first-run setup. */
export function hasNoUsers(): boolean {
  return load().users.length === 0;
}

export function replaceAll(db: Partial<Db>): void {
  const current = load();
  for (const key of Object.keys(db) as (keyof Db)[]) {
    current[key] = db[key] as never;
    persist(key);
  }
}
