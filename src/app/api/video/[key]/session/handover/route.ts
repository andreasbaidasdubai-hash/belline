import { NextResponse } from "next/server";
import { requestVideoHandover } from "@/lib/video/sessions";
import { NO_STORE, readBody, sessionForClient, venueByEmbedKey } from "@/lib/video/http";

export const dynamic = "force-dynamic";

/**
 * "Talk to a person", pressed during a video call.
 *
 * Flags the call for the team the way the receptionist's own handover does,
 * and hands the panel the sentence to say on the visitor's behalf, so the face
 * asks for their name and number with `take_message` — the existing workflow,
 * not a second one. Nobody can be put through from a website.
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const location = venueByEmbedKey(key);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const body = await readBody(req);
  const found = sessionForClient(location, body?.sessionId, body?.clientToken);
  if (!found.ok) return found.response;

  if (!requestVideoHandover(found.session)) {
    return NextResponse.json({ error: "ended" }, { status: 409, headers: NO_STORE });
  }
  return NextResponse.json(
    { ok: true, say: "I'd like to talk to a person, please. Can someone from the team get back to me?" },
    { headers: NO_STORE },
  );
}
