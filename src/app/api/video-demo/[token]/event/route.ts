import { NextResponse } from "next/server";
import { verifyVisitorToken } from "@/lib/auth";
import { isClientMetric, recordVideoMetric } from "@/lib/video/metrics";
import { markVideoAlive, markVideoJoined } from "@/lib/video/sessions";
import { readBody } from "@/lib/video/http";
import { demoSessionForClient, linkFromParams, NO_STORE } from "@/lib/sales/video-demo/http";

export const dynamic = "force-dynamic";

/**
 * The call panel's timings on a demo page: the same closed list of names as
 * the widget's, recorded against Belline's own venue. Never free text.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const found = await linkFromParams(ctx.params);
  if (!found.ok) return found.response;
  const { link, venue } = found;

  const body = await readBody(req, 2_000);
  if (!body || !isClientMetric(body.name)) {
    return NextResponse.json({ error: "bad_event" }, { status: 400, headers: NO_STORE });
  }
  let sessionId: string | undefined;
  if (body.sessionId) {
    const session = demoSessionForClient(link, venue, body.sessionId, body.clientToken);
    if (!session.ok) return session.response;
    sessionId = session.session.id;
    // The page is still open: never swept for silence (sessions.ts).
    markVideoAlive(session.session);
    if (body.name === "ready" || body.name === "first_frame") markVideoJoined(session.session);
  } else {
    const claim = verifyVisitorToken(typeof body.token === "string" ? body.token : undefined);
    if (!claim || claim.locationId !== venue.id) {
      return NextResponse.json({ error: "not_authorised" }, { status: 401, headers: NO_STORE });
    }
  }
  const ms = typeof body.ms === "number" && body.ms >= 0 && body.ms < 3_600_000 ? body.ms : undefined;
  const detail = typeof body.detail === "string" ? body.detail.replace(/[^a-z0-9_:-]/gi, "").slice(0, 40) : undefined;
  recordVideoMetric(venue, { name: body.name, sessionId, ms, detail });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
