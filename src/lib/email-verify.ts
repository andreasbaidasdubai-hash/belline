import crypto from "node:crypto";
import type { User } from "./types";
import { findUserByEmail, getUser, listBusinesses, saveBusiness, saveUser } from "./store";
import { flag } from "./flags";
import { deliverEmail, type Delivery } from "./mailer";
import { openException } from "./exceptions";
import { appOrigin } from "./origin";
import { checkShape } from "./leads/email";
import { isDisposableEmail } from "./abuse/business-key";
import { DISPOSABLE_MESSAGE, emailAllowed, recordAbuse } from "./abuse/review";

/**
 * Confirming a new owner's email address before Belline spends money on them.
 *
 * A signup is free and takes a minute; reading a website with a model, talking
 * to Belle, the test console, the automatic checks and a Belline number all
 * cost real money. So an account opened by self-serve signup gets a 6-digit
 * code by email, and until it is typed in none of that paid work runs
 * (abuse/gate.ts). Setting up by hand, the rules and the dashboard all work
 * meanwhile.
 *
 * The limits, all stored on the user so a redeploy does not reset them:
 *
 *   a code works for 15 minutes and 5 tries, then a new one is needed
 *   a new code at most once a minute, and 5 an hour
 *   the address can be changed (a typo at signup) 3 times an hour
 *
 * With `email.transactional` off there is no honest way to send a code, the
 * same position password reset is in (auth-reset.ts). The account is not left
 * stuck: an `email_unverified` exception asks the team to confirm the address
 * by hand, and staff mark it confirmed in the sales console. Under stubs the
 * code goes to the outbox beside the data, which is what the e2e reads.
 *
 * Grandfathered: only a user with `emailVerification.required` is ever held
 * back, and only signup sets it. Every account that predates this is treated
 * as confirmed, with no migration to run.
 *
 * No `next/*` imports, so the checks can drive it directly.
 */

export const CODE_MINUTES = 15;
export const CODE_ATTEMPTS = 5;
export const RESEND_GAP_MS = 60_000;
export const SENDS_PER_HOUR = 5;
export const CHANGES_PER_HOUR = 3;
const HOUR_MS = 3_600_000;

export type VerifyMode = "email" | "team";

export function verifyMode(env: Record<string, string | undefined> = process.env): VerifyMode {
  return flag("email.transactional", env) ? "email" : "team";
}

/** Is this person held back from paid work until they confirm their address? */
export function needsEmailVerification(user: Pick<User, "emailVerification" | "emailVerifiedAt"> | null | undefined): boolean {
  return Boolean(user?.emailVerification?.required && !user.emailVerifiedAt);
}

function secret(): string {
  return process.env.SESSION_SECRET || process.env.TWILIO_AUTH_TOKEN || "belline-development-only";
}

function hashCode(userId: string, code: string): string {
  return crypto.createHmac("sha256", secret()).update(`verify:${userId}:${code}`).digest("base64url");
}

/** Six random digits, never all the same one (000000 reads as a placeholder). */
function newCode(): string {
  for (;;) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    if (!/^(\d)\1{5}$/.test(code)) return code;
  }
}

export type SendResult =
  | { ok: true; mode: VerifyMode; delivery: Promise<Delivery | null> }
  | { ok: false; status: number; error: string; retryAfterSeconds?: number };

/**
 * Send a new code, replacing any outstanding one. Refused inside the limits
 * above. In team mode no code is made: the team is asked instead.
 */
export function sendVerificationCode(userId: string, opts: { now?: Date; env?: Record<string, string | undefined>; force?: boolean } = {}): SendResult {
  const now = opts.now ?? new Date();
  const user = getUser(userId);
  if (!user) return { ok: false, status: 404, error: "No such account." };
  if (!needsEmailVerification(user)) return { ok: false, status: 409, error: "Your email address is already confirmed." };
  const v = user.emailVerification!;
  const sends = (v.sends ?? []).filter((t) => now.getTime() - Date.parse(t) < HOUR_MS);
  const last = sends[sends.length - 1];

  if (!opts.force && last && now.getTime() - Date.parse(last) < RESEND_GAP_MS) {
    const wait = Math.ceil((RESEND_GAP_MS - (now.getTime() - Date.parse(last))) / 1000);
    return { ok: false, status: 429, error: `A code was sent a moment ago. You can ask for another in ${wait} seconds.`, retryAfterSeconds: wait };
  }
  if (sends.length >= SENDS_PER_HOUR) {
    const wait = Math.ceil((HOUR_MS - (now.getTime() - Date.parse(sends[0]))) / 1000);
    return {
      ok: false,
      status: 429,
      error: `That is ${SENDS_PER_HOUR} codes in an hour. Check your spam folder, or try again in ${Math.ceil(wait / 60)} minutes.`,
      retryAfterSeconds: wait,
    };
  }

  const mode = verifyMode(opts.env);
  if (mode === "team") {
    saveUser({ ...user, emailVerification: { ...v, codeHash: undefined, expiresAt: undefined, attempts: 0, sends: [...sends, now.toISOString()] } });
    openException(
      {
        tenantId: user.tenantId,
        kind: "email_unverified",
        reason: `${user.name} signed up as ${user.email} while email is switched off, so no confirmation code could be sent.`,
        context: { userId: user.id, email: user.email, name: user.name },
        source: "system",
      },
      now,
    );
    return { ok: true, mode, delivery: Promise.resolve(null) };
  }

  const code = newCode();
  saveUser({
    ...user,
    emailVerification: {
      ...v,
      codeHash: hashCode(user.id, code),
      expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000).toISOString(),
      attempts: 0,
      sends: [...sends, now.toISOString()],
    },
  });
  const link = `${appOrigin()}/verify?code=${code}`;
  const text = [
    `Hello ${user.name},`,
    "",
    `Your Belline confirmation code is ${code}`,
    "",
    `Type it on the page that asked for it, or open ${link} while signed in.`,
    `It works for ${CODE_MINUTES} minutes. If you did not sign up for Belline, ignore this email.`,
  ].join("\n");
  const html = [
    `<p>Hello ${escape(user.name)},</p>`,
    `<p>Your Belline confirmation code is</p>`,
    `<p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p>`,
    `<p>Type it on the page that asked for it, or <a href="${link}">confirm here</a> while signed in.</p>`,
    `<p>It works for ${CODE_MINUTES} minutes. If you did not sign up for Belline, ignore this email.</p>`,
  ].join("");
  const delivery = deliverEmail({ to: user.email, subject: `${code} is your Belline code`, text, html }).catch(() => null);
  return { ok: true, mode, delivery };
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type CheckResult = { ok: true; user: User } | { ok: false; status: number; error: string; field?: "code" };

/** Check a typed code. A wrong one uses a try; the fifth wrong one uses the code up. */
export function checkVerificationCode(userId: string, raw: string, opts: { now?: Date } = {}): CheckResult {
  const now = opts.now ?? new Date();
  const user = getUser(userId);
  if (!user) return { ok: false, status: 404, error: "No such account." };
  if (!needsEmailVerification(user)) return { ok: true, user };
  const v = user.emailVerification!;
  const code = String(raw ?? "").replace(/\D/g, "");
  if (code.length !== 6) return { ok: false, status: 422, field: "code", error: "Enter the 6-digit code from the email." };
  if (!v.codeHash || !v.expiresAt) {
    return { ok: false, status: 409, field: "code", error: "There is no code waiting. Send a new one." };
  }
  if ((v.attempts ?? 0) >= CODE_ATTEMPTS) {
    return { ok: false, status: 429, field: "code", error: "Too many wrong tries for that code. Send a new one." };
  }
  if (Date.parse(v.expiresAt) < now.getTime()) {
    return { ok: false, status: 410, field: "code", error: "That code has expired. Send a new one." };
  }
  const a = Buffer.from(hashCode(user.id, code));
  const b = Buffer.from(v.codeHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const attempts = (v.attempts ?? 0) + 1;
    saveUser({ ...user, emailVerification: { ...v, attempts } });
    const left = CODE_ATTEMPTS - attempts;
    return {
      ok: false,
      status: 422,
      field: "code",
      error: left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code is not right, and it has now been used up. Send a new one.",
    };
  }
  return { ok: true, user: markEmailVerified(user.id, "code", now)! };
}

/** Confirm the address. By "code", "link" (a sign-in or reset email was used) or a staff member's name. */
export function markEmailVerified(userId: string, by: string, now: Date = new Date()): User | null {
  const user = getUser(userId);
  if (!user) return null;
  if (user.emailVerifiedAt) return user;
  const v = user.emailVerification;
  return saveUser({
    ...user,
    emailVerifiedAt: now.toISOString(),
    ...(v ? { emailVerification: { ...v, codeHash: undefined, expiresAt: undefined, attempts: 0, verifiedBy: by } } : {}),
  });
}

export type ChangeResult = SendResult | { ok: false; status: number; error: string; field: "email" };

/**
 * Correct the address before it is confirmed, and send a code to the new one.
 * Only while unconfirmed: a confirmed address is changed from account settings.
 */
export function changeUnverifiedEmail(
  userId: string,
  raw: string,
  opts: { now?: Date; env?: Record<string, string | undefined> } = {},
): ChangeResult {
  const now = opts.now ?? new Date();
  const user = getUser(userId);
  if (!user) return { ok: false, status: 404, error: "No such account." };
  if (!needsEmailVerification(user)) return { ok: false, status: 409, error: "Your email address is already confirmed.", field: "email" };
  const v = user.emailVerification!;
  const changes = (v.changes ?? []).filter((t) => now.getTime() - Date.parse(t) < HOUR_MS);
  if (changes.length >= CHANGES_PER_HOUR) {
    return { ok: false, status: 429, field: "email", error: "The address has been changed a few times already. Try again in an hour." };
  }

  const email = String(raw ?? "").trim().toLowerCase();
  if (email === user.email) return { ok: false, status: 422, field: "email", error: "That is the address the code went to." };
  if (isDisposableEmail(email) && !emailAllowed(email)) {
    recordAbuse({ kind: "disposable_email", email, tenantId: user.tenantId, stage: "change_email" }, now);
    return { ok: false, status: 422, field: "email", error: DISPOSABLE_MESSAGE };
  }
  const shape = checkShape(email);
  if (!shape.valid) return { ok: false, status: 422, field: "email", error: shape.reason ?? "That does not look like an email address." };
  if (findUserByEmail(email)) {
    return { ok: false, status: 409, field: "email", error: "There is already an account with that address. Sign in to it instead." };
  }

  const old = user.email;
  saveUser({ ...user, email, emailVerification: { ...v, changes: [...changes, now.toISOString()], codeHash: undefined, expiresAt: undefined } });
  // The business's contact address followed the owner's at signup; it follows the correction too.
  for (const business of listBusinesses(user.tenantId).filter((b) => b.email === old)) {
    saveBusiness({ ...business, email });
  }
  // A new address is a new inbox: the one-a-minute gap is for the same inbox.
  return sendVerificationCode(user.id, { now, env: opts.env, force: true });
}
