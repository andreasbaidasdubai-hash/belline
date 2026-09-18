import { NextResponse } from "next/server";
import { isClientMetric, recordVideoMetric } from "@/lib/video/metrics";
import { markVideoAlive, markVideoJoined } from "@/lib/video/sessions";
import { NO_STORE, readBody } from "@/lib/video/http";
import { currentUser } from "@/lib/auth-server";
import { bellineVenue } from "@/lib/belle/identity";
import { supportSessionFor } from "@/lib/belle/video";

export const dynamic = "force-dynamic";

/**
 * The support call panel's timings: the widget's closed list of names,
 * recorded against Belline's own venue. Before a session exists the owner's
 * sign-in authorises it; after, the session's own token as well.
 */
export async function POST(req: Request) {
  const body = await readBody(req, 2_000);
  if (!body || !isClientMetric(body.name)) {
    return NextResponse.json({ error: "bad_event" }, { status: 400, headers: NO_STORE });
  }
  const venue = bellineVenue();
  if (!venue) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  let sessionId: string | undefined;
  if (body.sessionId) {
    const found = await supportSessionFor(body.sessionId, body.clientToken);
    if (!found.ok) return found.response;
    sessionId = found.session.id;
    // The page is still open: never swept for silence (sessions.ts).
    markVideoAlive(found.session);
    if (body.name === "ready" || body.name === "first_frame") markVideoJoined(found.session);
  } else if (!(await currentUser())) {
    return NextResponse.json({ error: "not_authorised" }, { status: 401, headers: NO_STORE });
  }
  const ms = typeof body.ms === "number" && body.ms >= 0 && body.ms < 3_600_000 ? body.ms : undefined;
  const detail = typeof body.detail === "string" ? body.detail.replace(/[^a-z0-9_:-]/gi, "").slice(0, 40) : undefined;
  recordVideoMetric(venue, { name: body.name, sessionId, ms, detail });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
