import crypto from "node:crypto";
import { mutateOAuthStates, type OAuthStateRow } from "../store";

/**
 * The OAuth `state` for every calendar connection: signed, expiring, bound to
 * the user who started it, and carrying a nonce that is also a cookie and can
 * be used once.
 *
 * Written for Google first (integrations/google.ts explains why the bare
 * venue id it replaced was dangerous) and shared with Outlook. Each provider
 * signs with its own derived key, so a state issued for one can never be
 * replayed at the other's callback, and each sweep only ever sees its own
 * pending rows.
 *
 * The pending nonce is kept in the store, not in memory, so a deploy or a
 * restart between "Connect" and the provider's answer does not send the owner
 * back to the start. Only its hash is written: the nonce itself lives in the
 * owner's cookie, and a copy of the data cannot finish anybody's connection.
 */

export type OAuthProvider = "google" | "outlook";
/**
 * Where the owner goes back to: the setup step they started from, or the
 * Calendars page. Calendars used to live on /integrations, whose token was
 * "integrations"; a state signed before the move still verifies and lands on
 * Calendars, because anything that is not "setup" does.
 */
export type ReturnTo = "setup" | "calendars";

export const STATE_TTL_MS = 10 * 60_000;

interface StatePayload {
  l: string;
  u: string;
  r: ReturnTo;
  n: string;
  e: number;
}

/** Google's label is the one it has always used: states issued before this refactor still verify. */
const KEY_LABEL: Record<OAuthProvider, string> = {
  google: "belline google oauth state v1",
  outlook: "belline outlook oauth state v1",
};

function stateKey(provider: OAuthProvider): Buffer {
  // Derived, so the sealing key itself is never used as an HMAC key directly.
  return crypto.createHmac("sha256", process.env.CREDENTIALS_KEY ?? "").update(KEY_LABEL[provider]).digest();
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const nonceHash = (nonce: string) => crypto.createHash("sha256").update(nonce).digest("hex");
/** Rows written before rows named their provider are Google's. */
const providerOf = (row: OAuthStateRow): OAuthProvider => row.provider ?? "google";

export function signOAuthState(
  provider: OAuthProvider,
  input: { locationId: string; userId: string; returnTo: ReturnTo },
  now = Date.now(),
): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(18).toString("base64url");
  const payload: StatePayload = { l: input.locationId, u: input.userId, r: input.returnTo, n: nonce, e: now + STATE_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", stateKey(provider)).update(body).digest());
  mutateOAuthStates((rows) => ({
    rows: [
      // Long gone: a day past its expiry, whatever the sweep made of it.
      ...rows.filter((r) => Date.parse(r.expiresAt) > now - 24 * 60 * 60_000),
      {
        id: nonceHash(nonce),
        ...(provider === "google" ? {} : { provider }),
        locationId: input.locationId,
        userId: input.userId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(payload.e).toISOString(),
      },
    ],
    out: undefined,
  }));
  return { state: `${body}.${sig}`, nonce };
}

/** Consume a pending nonce of this provider. True when it was there to consume. */
function consumeNonce(provider: OAuthProvider, nonce: string): boolean {
  const id = nonceHash(nonce);
  return mutateOAuthStates((rows) => {
    const known = rows.some((r) => r.id === id && providerOf(r) === provider);
    return { rows: known ? rows.filter((r) => r.id !== id) : rows, out: known };
  });
}

export type StateCheck =
  | { ok: true; locationId: string; returnTo: ReturnTo }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "used" | "user" | "cookie"; returnTo?: ReturnTo };

export function verifyOAuthState(
  provider: OAuthProvider,
  state: string,
  opts: { userId: string; cookieNonce?: string; now?: number },
): StateCheck {
  const now = opts.now ?? Date.now();
  const [body, sig] = state.split(".");
  if (!body || !sig) return { ok: false, reason: "malformed" };
  const expected = crypto.createHmac("sha256", stateKey(provider)).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const returnTo: ReturnTo = payload.r === "setup" ? "setup" : "calendars";
  // Consumed on first sight, whatever happens next: a state is never good twice.
  // Unknown — used already, or its record lost with the data — is refused the
  // same way, and the route sends the owner back to connect again.
  let known = false;
  try {
    known = typeof payload.n === "string" && consumeNonce(provider, payload.n);
  } catch (err) {
    console.error(`[${provider}] could not read pending connections: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (payload.e < now) return { ok: false, reason: "expired", returnTo };
  if (!known) return { ok: false, reason: "used", returnTo };
  if (payload.u !== opts.userId) return { ok: false, reason: "user", returnTo };
  if (!opts.cookieNonce || opts.cookieNonce !== payload.n) return { ok: false, reason: "cookie", returnTo };
  return { ok: true, locationId: payload.l, returnTo };
}

/** Take this provider's pending connections whose ten minutes are up out of the store, and return them. */
export function takeExpiredStates(provider: OAuthProvider, now = new Date()): OAuthStateRow[] {
  return mutateOAuthStates((rows) => {
    const expired = rows.filter((r) => providerOf(r) === provider && Date.parse(r.expiresAt) <= now.getTime());
    return { rows: rows.filter((r) => !expired.includes(r)), out: expired };
  });
}
