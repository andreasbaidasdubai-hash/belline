import crypto from "node:crypto";

/**
 * The tokens that tie a request to exactly one video session at one venue.
 *
 * Three doors lead into a session, and each gets its own purpose so a token
 * for one cannot open another:
 *
 *   `llm`     — the provider's model requests. In Tavus's per-session PAL it is
 *               the PAL's `api_key`, so it arrives as the Authorization header.
 *   `webhook` — in the `callback_url` query, because Tavus does not sign its
 *               conversation callbacks (docs/video/tavus-notes.md).
 *   `client`  — handed to the visitor's panel, for ending the session, asking
 *               for a person and reporting timings. It cannot drive the model.
 *
 * The session, the venue and the expiry are all inside the MAC. A token for one
 * venue's session edited to name another venue fails the check before anything
 * is looked up, which is what tenant isolation rests on here.
 */

export type VideoTokenPurpose = "llm" | "webhook" | "client";

export interface VideoTokenClaim {
  purpose: VideoTokenPurpose;
  sessionId: string;
  locationId: string;
  expiresAt: number;
}

const PREFIX = "bvt1";
const SAFE = /^[A-Za-z0-9_-]+$/;

type Env = Record<string, string | undefined>;

/**
 * The key. `VIDEO_LLM_SECRET` in any real deployment — the flag will not turn
 * on without it. Locally, and in the checks, it falls back to the app's own
 * development secret so the mock runs with no setup at all.
 */
export function videoSecret(env: Env = process.env): string {
  const own = (env.VIDEO_LLM_SECRET ?? "").trim();
  if (own) return own;
  if (env.NODE_ENV === "production") {
    throw new Error("VIDEO_LLM_SECRET is not set.");
  }
  return `${env.SESSION_SECRET || "belline-development-only"}:video`;
}

function mac(payload: string, env: Env): string {
  return crypto.createHmac("sha256", videoSecret(env)).update(payload).digest("base64url");
}

export function signVideoToken(
  purpose: VideoTokenPurpose,
  sessionId: string,
  locationId: string,
  ttlSeconds: number,
  env: Env = process.env,
  now = Date.now(),
): string {
  if (!SAFE.test(sessionId) || !SAFE.test(locationId)) {
    throw new Error("Session and venue ids must be URL-safe.");
  }
  const payload = `${PREFIX}.${purpose}.${sessionId}.${locationId}.${now + ttlSeconds * 1000}`;
  return `${payload}.${mac(payload, env)}`;
}

export function verifyVideoToken(
  token: string | null | undefined,
  purpose: VideoTokenPurpose,
  env: Env = process.env,
  now = Date.now(),
): VideoTokenClaim | null {
  if (!token || token.length > 400) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [, kind, sessionId, locationId, expires, given] = parts;
  if (kind !== purpose) return null;
  let expected: string;
  try {
    expected = mac(parts.slice(0, 5).join("."), env);
  } catch {
    return null;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  return { purpose, sessionId, locationId, expiresAt };
}

/**
 * The static `api_key` of a venue's shared PAL: derived, never stored.
 *
 * One per venue and face, so the key a model request arrives with names the
 * venue whose PAL sent it. A session token for venue B arriving through venue
 * A's PAL is refused even though both are validly signed — the key and the
 * token must agree on the venue (engine.ts `authoriseVideoLlm`).
 */
export function venuePalKey(locationId: string, faceId: string, env: Env = process.env): string {
  return `bvk1_${crypto.createHmac("sha256", videoSecret(env)).update(`venue-pal.${locationId}.${faceId}`).digest("base64url")}`;
}

/** Where a shared-PAL deployment puts the token: a line in `conversational_context`. */
export const CONTEXT_TOKEN_LABEL = "belline-session";

/** Find a context token, in system messages only — never in anything the visitor said. */
export function tokenFromSystemMessages(messages: { role?: unknown; content?: unknown }[]): string | null {
  const pattern = new RegExp(`${CONTEXT_TOKEN_LABEL}:\\s*(${PREFIX}\\.llm\\.[A-Za-z0-9_.-]+)`);
  for (const message of messages) {
    if (message.role !== "system") continue;
    const text = contentText(message.content);
    const found = pattern.exec(text);
    if (found) return found[1];
  }
  return null;
}

/** OpenAI message content, which may be a string or an array of parts. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}
