import { NextResponse } from "next/server";
import { endVideoSession } from "@/lib/video/sessions";
import { clientEnd, endedPayload, NO_STORE, readBody, sessionForClient, venueByEmbedKey } from "@/lib/video/http";

export const dynamic = "force-dynamic";

/**
 * End a video session from the visitor's side: the End button, the panel
 * closing, the page unloading (`navigator.sendBeacon`, which posts text/plain
 * and cannot read the answer). Idempotent — the provider's own shutdown, the
 * timers and this can arrive in any order.
 *
 * The answer says why the call ended, because the browser cannot tell: our
 * ceiling, the provider's, and the room simply vanishing all look the same
 * from there. It carries the turns back too, so "Continue in chat" does not
 * start from nothing.
 */

// `dropped`: the room closed and the visitor did not ask for it. Not the same
// as `visitor`, and the difference is the whole point of this route's answer.
const REASONS = new Set(["visitor", "unload", "mic_denied", "error", "switch_chat", "switch_voice", "duration", "dropped"]);

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const location = venueByEmbedKey(key);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const body = await readBody(req);
  const found = sessionForClient(location, body?.sessionId, body?.clientToken);
  if (!found.ok) return found.response;

  const asked = typeof body?.reason === "string" && REASONS.has(body.reason) ? body.reason : "visitor";
  const { reason, by } = clientEnd(asked);
  const ended = await endVideoSession(found.session.id, reason, { by });
  // Whatever ended it first wins: a provider shutdown already recorded here is
  // what the panel is told about, not the reason the panel guessed.
  return NextResponse.json({ ok: true, ended, ...endedPayload(found.session) }, { headers: NO_STORE });
}
