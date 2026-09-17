import crypto from "node:crypto";
import { videoSecret } from "../../video/tokens";

/**
 * The token in a personalised video-demo link: `/demo/v/<token>`.
 *
 * `<linkId>.<expiry>.<mac>`. The link id is 18 random bytes, so the URL cannot
 * be guessed or walked; the expiry and the id are both inside the MAC, so a
 * token edited to live longer, or to name another prospect's link, fails
 * before anything is looked up. Revocation is not in the token (a token cannot
 * un-sign itself): every use also reads the link record, and a revoked or
 * expired record refuses whatever the token says.
 *
 * The key is `VIDEO_DEMO_SECRET`, else derived from the video key, so a demo
 * token can never be replayed as a video session token or the reverse.
 */

type Env = Record<string, string | undefined>;

export const DEMO_LINK_DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 90;
const ID = /^[A-Za-z0-9_-]{24}$/;

function secret(env: Env): string {
  const own = (env.VIDEO_DEMO_SECRET ?? "").trim();
  return own || `${videoSecret(env)}:video-demo-link`;
}

function mac(payload: string, env: Env): string {
  return crypto.createHmac("sha256", secret(env)).update(`bvd1.${payload}`).digest("base64url").slice(0, 32);
}

export function newDemoLinkId(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/** Days a new link lives: `VIDEO_DEMO_TTL_DAYS`, else 30; never more than 90. */
export function demoLinkTtlDays(env: Env = process.env, asked?: number): number {
  const fromEnv = Number(env.VIDEO_DEMO_TTL_DAYS);
  const base = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEMO_LINK_DEFAULT_TTL_DAYS;
  const days = asked && Number.isFinite(asked) && asked > 0 ? asked : base;
  return Math.min(MAX_TTL_DAYS, Math.max(1, Math.round(days)));
}

export function signDemoLinkToken(linkId: string, expiresAtMs: number, env: Env = process.env): string {
  if (!ID.test(linkId)) throw new Error("A demo link id is 24 URL-safe characters.");
  const payload = `${linkId}.${Math.floor(expiresAtMs).toString(36)}`;
  return `${payload}.${mac(payload, env)}`;
}

export interface DemoLinkClaim {
  linkId: string;
  expiresAt: number;
}

export function verifyDemoLinkToken(token: unknown, env: Env = process.env, now = Date.now()): DemoLinkClaim | null {
  if (typeof token !== "string" || token.length > 80) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [linkId, exp, given] = parts;
  if (!ID.test(linkId) || !/^[0-9a-z]{1,12}$/.test(exp)) return null;
  let expected: string;
  try {
    expected = mac(`${linkId}.${exp}`, env);
  } catch {
    return null;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const expiresAt = parseInt(exp, 36);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  return { linkId, expiresAt };
}

/** The public page for a link. */
export function demoLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/demo/v/${token}`;
}
