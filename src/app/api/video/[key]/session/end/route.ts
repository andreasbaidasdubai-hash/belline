import { NextResponse } from "next/server";
import { endVideoSession } from "@/lib/video/sessions";
import { NO_STORE, readBody, sessionForClient, venueByEmbedKey } from "@/lib/video/http";

export const dynamic = "force-dynamic";

/**
 * End a video session from the visitor's side: the End button, the panel
 * closing, the page unloading (`navigator.sendBeacon`, which posts text/plain
 * and cannot read the answer). Idempotent — the provider's own shutdown, the
 * timers and this can arrive in any order.
 */

const REASONS = new Set(["visitor", "unload", "mic_denied", "error", "switch_chat", "switch_voice", "duration"]);

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const location = venueByEmbedKey(key);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const body = await readBody(req);
  const found = sessionForClient(location, body?.sessionId, body?.clientToken);
  if (!found.ok) return found.response;

  const reason = typeof body?.reason === "string" && REASONS.has(body.reason) ? body.reason : "visitor";
  const ended = await endVideoSession(found.session.id, `client_${reason}`, { by: reason === "unload" ? "unload" : "visitor" });
  return NextResponse.json({ ok: true, ended }, { headers: NO_STORE });
}
