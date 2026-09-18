import { NextResponse } from "next/server";
import { verifyVisitorToken } from "@/lib/auth";
import { readBody } from "@/lib/video/http";
import { linkFromParams, NO_STORE } from "@/lib/sales/video-demo/http";
import { demoChatTurn } from "@/lib/sales/video-demo/chat";
import { reserveChat } from "@/lib/sales/video-demo/service";

export const dynamic = "force-dynamic";

/**
 * "Prefer to type? Chat with Belle" — the same sales Belle and the same
 * server-side prospect briefing as the video call, over text. Scoped to this
 * link: the visitor's signed identity, the link's chats a day and the messages
 * in a chat bound it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const found = await linkFromParams(ctx.params);
  if (!found.ok) return found.response;
  const { link, venue } = found;

  // Room for the turns of a video call this chat is carrying on from, beside
  // the message itself. Still small, and still read before anything is trusted.
  const body = await readBody(req, 16_000);
  const claim = verifyVisitorToken(typeof body?.token === "string" ? body.token : undefined);
  if (!claim || claim.locationId !== venue.id) {
    return NextResponse.json({ error: "expired" }, { status: 401, headers: NO_STORE });
  }
  const chatId = typeof body?.chatId === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(body.chatId) ? body.chatId : "";
  if (!chatId) return NextResponse.json({ error: "bad_chat" }, { status: 400, headers: NO_STORE });

  const turn = await demoChatTurn({
    link,
    venue,
    visitorId: claim.visitorId,
    chatId,
    text: typeof body?.text === "string" ? body.text : "",
    // The video call this chat is carrying on from, handed back to the page by
    // the end route. Only read when the chat is being created.
    priorTurns: Array.isArray(body?.priorTurns)
      ? (body.priorTurns as unknown[])
          .filter((t): t is { role: string; text: string } => Boolean(t) && typeof (t as { text?: unknown }).text === "string")
          .map((t) => ({ role: t.role === "caller" ? ("caller" as const) : ("agent" as const), text: String(t.text) }))
      : undefined,
    reserve: () => reserveChat(link.id),
  });
  if (!turn.ok) return NextResponse.json({ error: turn.error }, { status: turn.status, headers: NO_STORE });
  return NextResponse.json(turn, { headers: NO_STORE });
}
