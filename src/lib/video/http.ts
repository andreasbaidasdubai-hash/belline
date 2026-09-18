import { NextResponse } from "next/server";
import type { Location } from "../types";
import { getCall, listLocations } from "../store";
import { seedIfEmpty } from "../seed";
import { getVideoSession, videoEndCause, type EndedBy, type VideoSession } from "./sessions";
import type { VideoEndCause } from "./end-reason";
import { verifyVideoToken } from "./tokens";

/**
 * The small pieces every video route shares.
 *
 * Responses here are built from whitelisted fields and carry `no-store`: a
 * meeting token in a shared cache would be somebody else's room.
 */

export const NO_STORE = { "cache-control": "no-store" } as const;

export function venueByEmbedKey(key: string): Location | undefined {
  seedIfEmpty();
  return listLocations({ includeInternal: true }).find((l) => l.embed?.enabled && l.embed.key === key);
}

/**
 * A JSON body, however it was sent. `navigator.sendBeacon` posts text/plain,
 * and the end-of-session beacon on unload is exactly the request that must
 * not be lost to a content-type check.
 */
export async function readBody(req: Request, maxBytes = 8_000): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (!text || text.length > maxBytes) return null;
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The session a visitor's panel is holding, checked against its token and the venue in the URL. */
export function sessionForClient(
  location: Location,
  sessionId: unknown,
  clientToken: unknown,
): { ok: true; session: VideoSession } | { ok: false; response: NextResponse } {
  const claim = verifyVideoToken(typeof clientToken === "string" ? clientToken : "", "client");
  if (!claim || claim.sessionId !== sessionId || claim.locationId !== location.id) {
    return { ok: false, response: NextResponse.json({ error: "not_authorised" }, { status: 401, headers: NO_STORE }) };
  }
  const session = getVideoSession(claim.sessionId);
  if (!session || session.locationId !== location.id) {
    return { ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE }) };
  }
  return { ok: true, session };
}

/**
 * A reason from the panel, as the session log should record it.
 *
 * `dropped` is the one that matters: the room went away and the visitor never
 * asked it to. Recording that as the visitor's own doing is what made an
 * account-tier cutoff look, in every record we had, like people hanging up.
 */
export function clientEnd(reason: string): { reason: string; by: EndedBy } {
  if (reason === "unload") return { reason: "client_unload", by: "unload" };
  if (reason === "dropped") return { reason: "client_dropped", by: "provider" };
  // The panel's own clock reaching the limit we told the visitor about. Ours,
  // and announced — not the visitor deciding, and not anybody cutting it.
  if (reason === "duration") return { reason: "client_duration", by: "timer" };
  return { reason: `client_${reason}`, by: "visitor" };
}

/** How much of the call is handed back for the chat to carry on from. */
const RECAP_TURNS = 20;
const RECAP_CHARS = 600;

export interface EndedPayload {
  /** What the visitor is told happened. One of a closed list; never a raw reason. */
  cause: VideoEndCause;
  /** How long the call ran, so the panel can say it without guessing. */
  seconds: number;
  /**
   * The call so far, so "Continue in chat" does not make the visitor say it
   * all again. Their own words back to them, over their own session's token.
   */
  recap: { role: "agent" | "caller"; text: string }[];
}

/**
 * What an ended session tells its own panel.
 *
 * Deliberately narrow: a cause from the closed list, a number, and the turns
 * the visitor was part of. The provider's name and its reason string stay on
 * this side — the panel has no use for them and a visitor must never read one.
 */
export function endedPayload(session: VideoSession): EndedPayload {
  const call = getCall(session.callId);
  const seconds = call?.video?.seconds ?? Math.max(0, Math.round(((session.endedAt ?? Date.now()) - session.createdAt) / 1000));
  return {
    cause: videoEndCause(session),
    seconds,
    // `system` turns are the engine talking to itself, not the conversation.
    recap: (call?.transcript ?? [])
      .filter((t) => t.role === "caller" || t.role === "agent")
      .slice(-RECAP_TURNS)
      .map((t) => ({ role: t.role as "agent" | "caller", text: t.text.slice(0, RECAP_CHARS) })),
  };
}
