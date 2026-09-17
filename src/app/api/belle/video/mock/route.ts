import { NextResponse } from "next/server";
import { handleChatCompletions } from "@/lib/video/engine";
import { NO_STORE, readBody } from "@/lib/video/http";
import { supportSessionFor } from "@/lib/belle/video";

export const dynamic = "force-dynamic";

/**
 * The mock provider's ears and mouth for an owner's support call, for local
 * runs only — the widget's mock route, for the owner's own session.
 */
export async function POST(req: Request) {
  const body = await readBody(req);
  const found = await supportSessionFor(body?.sessionId, body?.clientToken);
  if (!found.ok) return found.response;
  const { session } = found;
  if (session.provider !== "mock") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 1000) : "";
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400, headers: NO_STORE });

  const tavusLike = new Request("http://mock.invalid/api/video/llm/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${session.llmToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "belline-receptionist",
      stream: true,
      messages: [
        { role: "system", content: "You are Belle, Belline's AI assistant." },
        { role: "assistant", content: session.greeting },
        { role: "user", content: text },
      ],
    }),
    signal: req.signal,
  });
  return handleChatCompletions(tavusLike);
}
