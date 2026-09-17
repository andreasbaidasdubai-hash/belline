import { NextResponse } from "next/server";
import { endVideoSession } from "@/lib/video/sessions";
import { NO_STORE, readBody } from "@/lib/video/http";
import { supportSessionFor } from "@/lib/belle/video";

export const dynamic = "force-dynamic";

/** End an owner's support call from their side. Idempotent, like the widget's. */
const REASONS = new Set(["visitor", "unload", "mic_denied", "error", "switch_chat", "duration"]);

export async function POST(req: Request) {
  const body = await readBody(req);
  const found = await supportSessionFor(body?.sessionId, body?.clientToken);
  if (!found.ok) return found.response;
  const reason = typeof body?.reason === "string" && REASONS.has(body.reason) ? body.reason : "visitor";
  const ended = await endVideoSession(found.session.id, `client_${reason}`, { by: reason === "unload" ? "unload" : "visitor" });
  return NextResponse.json({ ok: true, ended }, { headers: NO_STORE });
}
