import crypto from "node:crypto";
import type { Location, Role, Session, User } from "./types";
import {
  deleteSessions,
  findUserByEmail,
  getSession,
  getUser,
  id,
  listLocations,
  pruneSessions,
  saveSession,
  saveUser,
} from "./store";

/**
 * Authentication.
 *
 * No dependency, no external identity provider: scrypt for passwords and
 * server-side sessions in the same store as everything else. Two reasons that
 * is the right call here rather than laziness — a venue's staff list is
 * three people and changes twice a year, and sessions held server-side can be
 * revoked the hour someone leaves, which a stateless token cannot.
 *
 * This file must stay free of `next/*` imports: the websocket bridge in
 * server.ts authenticates callers with it too, outside any request context.
 */

export const SESSION_COOKIE = "belline_session";
const SESSION_DAYS = 14;

// --- passwords -------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    // Constant-time: a length check first, because timingSafeEqual throws on
    // a mismatch and the throw itself would leak the length.
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Rejects the passwords that make a breach inevitable, and nothing more. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (/^\d+$/.test(password)) return "Digits alone are too easy to guess.";
  const common = ["password", "12345678", "qwerty", "belline", "letmein"];
  if (common.some((c) => password.toLowerCase().includes(c))) {
    return "That contains a very common word. Pick something else.";
  }
  return null;
}

// --- login throttling ------------------------------------------------------

/**
 * In-memory, per-email attempt counter. Deliberately not persisted: a restart
 * clearing it is fine, and it keeps a failed-login storm off the disk. On more
 * than one server this becomes per-server, which is a reason to move it to the
 * database at the same time as everything else.
 */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 10 * 60 * 1000;

export function loginLockedFor(email: string): number {
  const entry = attempts.get(email.toLowerCase());
  if (!entry || entry.count < MAX_ATTEMPTS) return 0;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    attempts.delete(email.toLowerCase());
    return 0;
  }
  return Math.ceil(remaining / 1000);
}

function recordFailure(email: string): void {
  const key = email.toLowerCase();
  const entry = attempts.get(key) ?? { count: 0, until: 0 };
  entry.count++;
  entry.until = Date.now() + LOCKOUT_MS;
  attempts.set(key, entry);
}

function clearFailures(email: string): void {
  attempts.delete(email.toLowerCase());
}

// --- users -----------------------------------------------------------------

export function createUser(input: {
  email: string;
  name: string;
  password: string;
  role: Role;
  locationIds?: string[];
}): { ok: true; user: User } | { ok: false; error: string } {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "That does not look like an email address." };
  }
  if (findUserByEmail(email)) {
    return { ok: false, error: "Someone already uses that email address." };
  }
  const problem = passwordProblem(input.password);
  if (problem) return { ok: false, error: problem };

  const user: User = {
    id: id("usr"),
    email,
    name: input.name.trim() || email,
    role: input.role,
    locationIds: input.role === "owner" ? [] : (input.locationIds ?? []),
    passwordHash: hashPassword(input.password),
    createdAt: new Date().toISOString(),
  };
  return { ok: true, user: saveUser(user) };
}

export function setPassword(user: User, password: string): { ok: boolean; error?: string } {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  saveUser({ ...user, passwordHash: hashPassword(password) });
  // Changing a password signs out every other device, which is the entire
  // point of changing it after a laptop goes missing.
  deleteSessions({ userId: user.id });
  return { ok: true };
}

// --- sessions --------------------------------------------------------------

export function login(
  email: string,
  password: string,
  userAgent?: string,
): { ok: true; session: Session; user: User } | { ok: false; error: string } {
  const locked = loginLockedFor(email);
  if (locked > 0) {
    return {
      ok: false,
      error: `Too many attempts. Try again in ${Math.ceil(locked / 60)} minutes.`,
    };
  }

  const user = findUserByEmail(email);
  // Hash regardless of whether the user exists, so the response time does not
  // reveal which email addresses are registered.
  const hash = user?.passwordHash ?? hashPassword("placeholder-for-timing");
  const passwordOk = verifyPassword(password, hash);

  if (!user || !passwordOk || user.disabled) {
    recordFailure(email);
    return { ok: false, error: "Wrong email or password." };
  }

  clearFailures(email);
  pruneSessions();

  const now = new Date();
  const session: Session = {
    id: crypto.randomBytes(32).toString("base64url"),
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
    userAgent: userAgent?.slice(0, 200),
  };
  saveSession(session);
  saveUser({ ...user, lastSeenAt: now.toISOString() });
  return { ok: true, session, user };
}

/** Resolve a cookie value to a live user, or null. */
export function userForSession(sessionId: string | undefined): User | null {
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session) return null;
  if (session.expiresAt <= new Date().toISOString()) {
    deleteSessions({ sessionId });
    return null;
  }
  const user = getUser(session.userId);
  if (!user || user.disabled) return null;
  return user;
}

export function logout(sessionId: string | undefined): void {
  if (sessionId) deleteSessions({ sessionId });
}

/** Pull the session cookie out of a raw `Cookie:` header, for the WS bridge. */
export function sessionIdFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

// --- authorisation ---------------------------------------------------------

export function canSeeLocation(user: User, locationId: string): boolean {
  if (user.role === "owner" || user.locationIds.length === 0) return true;
  return user.locationIds.includes(locationId);
}

/** Venues this user is allowed to open. */
export function visibleLocations(user: User): Location[] {
  return listLocations().filter((l) => canSeeLocation(user, l.id));
}

/** Only owners and managers change how the agent behaves. */
export function canEditAgent(user: User, locationId: string): boolean {
  return user.role !== "staff" && canSeeLocation(user, locationId);
}

export function canManageUsers(user: User): boolean {
  return user.role === "owner";
}

// ---------------------------------------------------------------------------

/**
 * Token handed to Twilio in the TwiML and checked when the media stream
 * connects back. Without it, `/ws/twilio` is an open socket that anyone can
 * open a metered call on — the webhook signature protects the webhook, not
 * the stream endpoint it points at.
 */
function streamSecret(): string {
  return (
    process.env.SESSION_SECRET ||
    process.env.TWILIO_AUTH_TOKEN ||
    "belline-development-only"
  );
}

export function signStreamToken(locationId: string, ttlSeconds = 300): string {
  const expires = Date.now() + ttlSeconds * 1000;
  const payload = `${locationId}.${expires}`;
  const mac = crypto
    .createHmac("sha256", streamSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyStreamToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [locationId, expires, mac] = parts;
  const expected = crypto
    .createHmac("sha256", streamSecret())
    .update(`${locationId}.${expires}`)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;
  return locationId;
}
