import { NextResponse } from "next/server";
import { endVideoSession } from "@/lib/video/sessions";
import { readBody } from "@/lib/video/http";
import { demoSessionForClient, linkFromParams, NO_STORE } from "@/lib/sales/video-demo/http";

export const dynamic = "force-dynamic";

/** End a demo call from the visitor's side. Idempotent, like the widget's. */
const REASONS = new Set(["visitor", "unload", "mic_denied", "error", "switch_chat", "duration"]);

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const found = await linkFromParams(ctx.params);
  if (!found.ok) return found.response;
  const body = await readBody(req);
  const session = demoSessionForClient(found.link, found.venue, body?.sessionId, body?.clientToken);
  if (!session.ok) return session.response;
  const reason = typeof body?.reason === "string" && REASONS.has(body.reason) ? body.reason : "visitor";
  const ended = await endVideoSession(session.session.id, `client_${reason}`, { by: reason === "unload" ? "unload" : "visitor" });
  return NextResponse.json({ ok: true, ended }, { headers: NO_STORE });
}
