import { NextResponse } from "next/server";
import { handleChatCompletions } from "@/lib/video/engine";
import { endVideoSession } from "@/lib/video/sessions";
import { readBody } from "@/lib/video/http";
import { demoSessionForClient, linkFromParams, NO_STORE } from "@/lib/sales/video-demo/http";

export const dynamic = "force-dynamic";

/**
 * The mock provider's ears and mouth on a demo page, for local runs only —
 * the widget's mock route, for a session started from this link.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const found = await linkFromParams(ctx.params);
  if (!found.ok) return found.response;
  const body = await readBody(req);
  const match = demoSessionForClient(found.link, found.venue, body?.sessionId, body?.clientToken);
  if (!match.ok) return match.response;
  const { session } = match;
  if (session.provider !== "mock") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  // The provider ending our call, as the widget's mock route can stage it: the
  // one thing a browser cannot make happen, and the thing that was happening.
  if (typeof body?.shutdown === "string") {
    const ended = await endVideoSession(session.id, body.shutdown.slice(0, 120), { by: "provider" });
    return NextResponse.json({ ok: true, ended }, { headers: NO_STORE });
  }

  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 1000) : "";
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400, headers: NO_STORE });

  const tavusLike = new Request("http://mock.invalid/api/video/llm/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${session.llmToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "belline-receptionist",
      stream: true,
      messages: [
        { role: "system", content: `You are ${found.venue.agent.displayName}, the AI concierge for ${found.venue.name}.` },
        { role: "assistant", content: session.greeting },
        { role: "user", content: text },
      ],
    }),
    signal: req.signal,
  });
  return handleChatCompletions(tavusLike);
}
