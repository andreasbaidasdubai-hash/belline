import { NextResponse } from "next/server";
import { endVideoSession } from "@/lib/video/sessions";
import { clientEnd, endedPayload, NO_STORE, readBody } from "@/lib/video/http";
import { supportSessionFor } from "@/lib/belle/video";

export const dynamic = "force-dynamic";

/** End an owner's support call from their side. Idempotent, like the widget's. */
const REASONS = new Set(["visitor", "unload", "mic_denied", "error", "switch_chat", "duration", "dropped"]);

export async function POST(req: Request) {
  const body = await readBody(req);
  const found = await supportSessionFor(body?.sessionId, body?.clientToken);
  if (!found.ok) return found.response;
  const asked = typeof body?.reason === "string" && REASONS.has(body.reason) ? body.reason : "visitor";
  const { reason, by } = clientEnd(asked);
  const ended = await endVideoSession(found.session.id, reason, { by });
  return NextResponse.json({ ok: true, ended, ...endedPayload(found.session) }, { headers: NO_STORE });
}
