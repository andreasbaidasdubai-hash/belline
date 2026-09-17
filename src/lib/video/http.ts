import { NextResponse } from "next/server";
import type { Location } from "../types";
import { listLocations } from "../store";
import { seedIfEmpty } from "../seed";
import { getVideoSession, type VideoSession } from "./sessions";
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
