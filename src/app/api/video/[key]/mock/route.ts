import { NextResponse } from "next/server";
import { handleChatCompletions } from "@/lib/video/engine";
import { endVideoSession } from "@/lib/video/sessions";
import { NO_STORE, readBody, sessionForClient, venueByEmbedKey } from "@/lib/video/http";

export const dynamic = "force-dynamic";

/**
 * The mock provider's ears and mouth, for local runs only.
 *
 * With no face to talk to, the mock panel types. This route plays Tavus's part:
 * it builds the request Tavus would send to the model route — the session's
 * own token as the credential, the conversation as OpenAI messages — and pipes
 * the streamed answer back. So a booking request or a lead taken in mock mode
 * has gone through exactly the route, the token check, the guards and the
 * tools a live call does.
 *
 * Only for a session the mock created. The mock itself refuses to exist in
 * production or next to a real database (lib/video/mock.ts).
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const location = venueByEmbedKey(key);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const body = await readBody(req);
  const found = sessionForClient(location, body?.sessionId, body?.clientToken);
  if (!found.ok) return found.response;
  const { session } = found;
  if (session.provider !== "mock") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  // The one thing a browser cannot otherwise make happen: the provider ending
  // our call. It is what a Tavus account tier does, and without a way to stage
  // it there is no way to see the panel a visitor actually met. Mock only, and
  // the mock refuses to exist in production or beside a real database.
  if (typeof body?.shutdown === "string") {
    const ended = await endVideoSession(session.id, body.shutdown.slice(0, 120), { by: "provider" });
    return NextResponse.json({ ok: true, ended }, { headers: NO_STORE });
  }

  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 1000) : "";
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400, headers: NO_STORE });

  // Handed straight to the handler, never fetched: the URL is only a label.
  const tavusLike = new Request("http://mock.invalid/api/video/llm/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${session.llmToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "belline-receptionist",
      stream: true,
      messages: [
        // What a per-session PAL's context holds: names, and no token — the
        // credential above is the token.
        { role: "system", content: `You are ${location.agent.displayName}, the AI concierge for ${location.name}.` },
        { role: "assistant", content: session.greeting },
        { role: "user", content: text },
      ],
    }),
    signal: req.signal,
  });
  return handleChatCompletions(tavusLike);
}
