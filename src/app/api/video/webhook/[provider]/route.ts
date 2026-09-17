import { NextResponse } from "next/server";
import { videoProvider } from "@/lib/video/provider";
import { applyVideoEvent, getVideoSession } from "@/lib/video/sessions";
import { verifyVideoToken } from "@/lib/video/tokens";
import { NO_STORE } from "@/lib/video/http";

export const dynamic = "force-dynamic";

/**
 * The video provider's lifecycle callbacks: joined, shut down, transcript.
 *
 * Tavus does not sign conversation callbacks (docs/video/tavus-notes.md), so
 * each session's `callback_url` carries its own token, and the event must be
 * about the conversation that token was issued for. A callback for a session
 * this process no longer remembers is acknowledged and ignored, so the
 * provider has nothing to retry.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: name } = await ctx.params;
  const url = new URL(req.url);
  const claim = verifyVideoToken(url.searchParams.get("t"), "webhook");
  if (!claim) return NextResponse.json({ error: "not_authorised" }, { status: 401, headers: NO_STORE });

  const provider = videoProvider();
  if (!provider || provider.name !== name) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  const raw = await req.text().catch(() => "");
  if (raw.length > 512_000) return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });

  const session = getVideoSession(claim.sessionId);
  if (!session || session.locationId !== claim.locationId) {
    return NextResponse.json({ ok: true, ignored: true }, { headers: NO_STORE });
  }

  const verdict = provider.verifyWebhook(raw, { conversationId: session.conversationId });
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: verdict.status, headers: NO_STORE });

  const event = provider.mapEvent(verdict.payload);
  await applyVideoEvent(session, event);
  return NextResponse.json({ ok: true, event: event.kind }, { headers: NO_STORE });
}
