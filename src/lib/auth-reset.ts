import { RESET_LINK_MINUTES, signResetToken } from "./auth";
import { findUserByEmail } from "./store";
import { flag } from "./flags";
import { deliverEmail, type Delivery } from "./mailer";
import { openException } from "./exceptions";
import { appOrigin } from "./origin";

/**
 * Forgot password, without a person and without a shell.
 *
 * With `email.transactional` on, the owner gets a single-use link that works
 * for 30 minutes (auth.ts). With it off there is no honest way to prove who
 * somebody is from a web form, so the request becomes an `account_recovery`
 * exception: the team writes to the address on the account and checks it is
 * them. Either way the response is the same for a known and an unknown
 * address, and takes the same time, so the form cannot be used to find out
 * who has an account.
 *
 * No `next/*` imports, so the checks can drive it directly.
 */

export type ResetMode = "email" | "team";

export function resetMode(env: Record<string, string | undefined> = process.env): ResetMode {
  return flag("email.transactional", env) ? "email" : "team";
}

/** What the form says afterwards. Depends only on the mode, never on the address. */
export function resetRequestedMessage(mode: ResetMode): string {
  return mode === "email"
    ? `If that address has a Belline account, a link to set a new password is on its way. It works once, for ${RESET_LINK_MINUTES} minutes.`
    : "If that address has a Belline account, the Belline team will write to it to check it is you, then help you back in.";
}

export interface ForgotLimits {
  perEmail: number;
  perPeer: number;
  windowMs: number;
}

export const FORGOT_LIMITS: ForgotLimits = { perEmail: 3, perPeer: 20, windowMs: 60 * 60 * 1000 };

/** In memory, per process, like the signup limiter. Counts every request, known address or not. */
export function createForgotLimiter(opts: ForgotLimits = FORGOT_LIMITS) {
  const hits = new Map<string, number[]>();
  const count = (key: string, now: number) => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [k, times] of hits) if (!times.some((t) => now - t < opts.windowMs)) hits.delete(k);
    }
    return recent.length;
  };
  return {
    /** Records the request and says whether it may go ahead. */
    allow(email: string, peer: string, now = Date.now()): boolean {
      const byEmail = count(`email:${email}`, now);
      const byPeer = count(`peer:${peer}`, now);
      return byEmail <= opts.perEmail && byPeer <= opts.perPeer;
    },
  };
}

const limiter = createForgotLimiter();

export type ResetOutcome = "sent" | "team" | "unknown" | "limited";

export interface ResetRequest {
  /** For tests and logs only. Never put in a response. */
  outcome: ResetOutcome;
  /** The email being written, when there is one. Never throws. */
  work: Promise<Delivery | null>;
}

export function requestPasswordReset(input: {
  email: string;
  peer: string;
  now?: number;
  limiter?: ReturnType<typeof createForgotLimiter>;
  env?: Record<string, string | undefined>;
}): ResetRequest {
  const email = input.email.trim().toLowerCase();
  const now = input.now ?? Date.now();
  if (!(input.limiter ?? limiter).allow(email, input.peer, now)) return { outcome: "limited", work: Promise.resolve(null) };

  const user = findUserByEmail(email);
  if (!user || user.disabled) return { outcome: "unknown", work: Promise.resolve(null) };

  if (resetMode(input.env) === "team") {
    openException({
      tenantId: user.tenantId,
      kind: "account_recovery",
      reason: "Cannot sign in and asked to reset the password while email is switched off.",
      context: { userId: user.id, email: user.email, name: user.name },
      source: "owner",
    });
    return { outcome: "team", work: Promise.resolve(null) };
  }

  const token = signResetToken(user, now);
  const link = `${appOrigin()}/login/reset?t=${encodeURIComponent(token)}`;
  const text = [
    `Hello ${user.name},`,
    "",
    "Somebody asked to reset the password for your Belline account. If it was you, set a new one here:",
    link,
    "",
    `The link works once, for ${RESET_LINK_MINUTES} minutes. Setting a new password signs you out everywhere else.`,
    "If it was not you, ignore this email; your password stays as it is.",
  ].join("\n");
  const html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .split("\n")
    .map((line) => (line === link ? `<a href="${link}">Set a new password</a>` : line))
    .join("<br>");
  const work = deliverEmail({ to: user.email, subject: "Reset your Belline password", text, html }).catch(() => null);
  return { outcome: "sent", work };
}

/** The shortest time the forgot route takes, so a known address is not faster or slower to answer. */
export const FORGOT_RESPONSE_MS = 400;

export async function padTo(started: number, ms = FORGOT_RESPONSE_MS): Promise<void> {
  const wait = started + ms - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
