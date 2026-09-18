import { NextResponse } from "next/server";
import { verifyVisitorToken } from "@/lib/auth";
import { isClientMetric, recordVideoMetric } from "@/lib/video/metrics";
import { markVideoAlive, markVideoJoined } from "@/lib/video/sessions";
import { NO_STORE, readBody, sessionForClient, venueByEmbedKey } from "@/lib/video/http";

export const dynamic = "force-dynamic";

/**
 * Timings from the visitor's panel: chosen, microphone asked or refused, room
 * ready, first frame of the face, first words, fallbacks taken.
 *
 * A closed list of names, a number and a short code — never free text, never
 * anything the visitor said. Before a session exists (choosing video, a refused
 * microphone) the visitor token authorises it; after, the session's own token.
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const location = venueByEmbedKey(key);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const body = await readBody(req, 2_000);
  if (!body || !isClientMetric(body.name)) {
    return NextResponse.json({ error: "bad_event" }, { status: 400, headers: NO_STORE });
  }

  let sessionId: string | undefined;
  if (body.sessionId) {
    const found = sessionForClient(location, body.sessionId, body.clientToken);
    if (!found.ok) return found.response;
    sessionId = found.session.id;
    // Any event from the panel proves the page is still open, so none of them
    // can be swept for silence. The heartbeat ("alive") is the one that arrives
    // when nothing else is happening.
    markVideoAlive(found.session);
    if (body.name === "ready" || body.name === "first_frame") markVideoJoined(found.session);
  } else {
    const claim = verifyVisitorToken(typeof body.token === "string" ? body.token : undefined);
    if (!claim || claim.locationId !== location.id) {
      return NextResponse.json({ error: "not_authorised" }, { status: 401, headers: NO_STORE });
    }
  }

  const ms = typeof body.ms === "number" && body.ms >= 0 && body.ms < 3_600_000 ? body.ms : undefined;
  const detail = typeof body.detail === "string" ? body.detail.replace(/[^a-z0-9_:-]/gi, "").slice(0, 40) : undefined;
  recordVideoMetric(location, { name: body.name, sessionId, ms, detail });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
