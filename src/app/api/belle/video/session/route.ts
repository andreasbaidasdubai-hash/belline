import { NextResponse } from "next/server";
import { belleOwner } from "@/lib/belle/server";
import { bellineVenue } from "@/lib/belle/identity";
import { SUPPORT_VIDEO_GREETING, supportVideoBriefing } from "@/lib/belle/support";
import { paidWorkRefusal } from "@/lib/abuse/gate";
import { startVideoSession } from "@/lib/video/sessions";
import { NO_STORE, readBody } from "@/lib/video/http";

export const dynamic = "force-dynamic";

/**
 * Start an owner's video call with Belle from Ask Belle. Called when the owner
 * presses Start on /belle/video — never on load, never when Ask Belle opens.
 *
 * Belline's own venue and video persona, with every check a website video call
 * gets (startVideoSession: the flag, the kill switch, the venue list, the
 * concurrency and the double click), but counted against Belline's support
 * ceiling (VIDEO_SUPPORT_MAX_SESSIONS_PER_DAY), never the website's and never
 * the customer's allowance: the call is on Belline's venue. The account
 * briefing is written here from the signed-in owner's own tenant; nothing in
 * the request adds to it. One session per owner at a time.
 */
export async function POST(req: Request) {
  const body = await readBody(req);
  const gate = await belleOwner(body?.locationId);
  if (!gate.ok) return gate.response;
  const { user, location } = gate;

  // Paid provider time at the owner's request: the same gate as other owner-started paid work.
  const held = paidWorkRefusal(user, location);
  if (held) return NextResponse.json({ error: held.code, message: held.error, fix: held.fix }, { status: held.status, headers: NO_STORE });

  const venue = bellineVenue();
  if (!venue) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const result = await startVideoSession(venue, `owner_${user.id}`, {
    support: {
      userId: user.id,
      tenantId: user.tenantId,
      briefing: supportVideoBriefing(location, user),
      greeting: SUPPORT_VIDEO_GREETING,
    },
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason, retryable: result.retryable, fallback: { chat: true, voice: false } },
      { status: result.status, headers: NO_STORE },
    );
  }
  return NextResponse.json({ ok: true, reused: result.reused, session: result.client }, { headers: NO_STORE });
}
