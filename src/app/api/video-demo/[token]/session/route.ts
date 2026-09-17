import { NextResponse } from "next/server";
import { verifyVisitorToken } from "@/lib/auth";
import { isActivated } from "@/lib/onboarding/journey";
import { startVideoSession } from "@/lib/video/sessions";
import { readBody } from "@/lib/video/http";
import { linkFromParams, NO_STORE } from "@/lib/sales/video-demo/http";
import {
  recordDemoEvent,
  releaseVideoSession,
  reserveVideoSession,
  sessionContextFor,
} from "@/lib/sales/video-demo/service";

export const dynamic = "force-dynamic";

/**
 * Start the video call on a personalised demo page. Called when the visitor
 * presses "Start your demo" — never on page load.
 *
 * Belline's own sales Belle on Belline's own venue, with every check a video
 * call on belline.ai gets (startVideoSession: the flag, the kill switch, the
 * venue list, the ceilings, the double click), plus the link's own: it must be
 * live, and it may start only so many sessions a day. The prospect context is
 * taken from the link's stored snapshot here, on the server, and bound to the
 * session; nothing in the request can add to it or change whose it is.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const found = await linkFromParams(ctx.params);
  if (!found.ok) return found.response;
  const { link, venue } = found;

  const body = await readBody(req);
  const claim = verifyVisitorToken(typeof body?.token === "string" ? body.token : undefined);
  if (!claim || claim.locationId !== venue.id) {
    return NextResponse.json({ error: "expired" }, { status: 401, headers: NO_STORE });
  }

  if (!(await reserveVideoSession(link.id))) {
    return NextResponse.json(
      { error: "daily_limit", retryable: false, fallback: { chat: true, voice: false } },
      { status: 429, headers: NO_STORE },
    );
  }

  const context = sessionContextFor(link);
  const result = await startVideoSession(venue, claim.visitorId, {
    preview: !isActivated(venue),
    demo: {
      linkId: link.id,
      briefing: context.briefing,
      greeting: context.greeting,
      onEnded: async ({ session, call, seconds }) => {
        await recordDemoEvent(link.id, "video_ended", {
          seconds,
          provider: session.provider,
          callerLines: (call?.transcript ?? []).filter((t) => t.role === "caller").map((t) => t.text),
          toolCalls: (call?.toolCalls ?? []).map((t) => ({ name: t.name, ok: t.ok, input: t.input as Record<string, unknown> })),
        });
      },
    },
  });

  if (!result.ok) {
    await releaseVideoSession(link.id);
    return NextResponse.json(
      { error: result.reason, retryable: result.retryable, fallback: { chat: true, voice: false } },
      { status: result.status, headers: NO_STORE },
    );
  }
  if (result.reused) await releaseVideoSession(link.id);
  else await recordDemoEvent(link.id, "video_started", { provider: result.session.provider });
  return NextResponse.json({ ok: true, reused: result.reused, session: result.client }, { headers: NO_STORE });
}
