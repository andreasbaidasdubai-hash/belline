import { NextResponse } from "next/server";
import { verifyVisitorToken } from "@/lib/auth";
import { currentUser } from "@/lib/auth-server";
import { paidWorkRefusal } from "@/lib/abuse/gate";
import { widgetOpenFor } from "@/lib/embed-preview";
import { isActivated } from "@/lib/onboarding/journey";
import { chatAllowed, voiceAllowed } from "@/lib/embed";
import { startVideoSession } from "@/lib/video/sessions";
import { NO_STORE, readBody, venueByEmbedKey } from "@/lib/video/http";

export const dynamic = "force-dynamic";

/**
 * Start a video session. Called by the panel when the visitor presses Start —
 * never on page load and never when the launcher opens, because a room costs
 * money from the moment it exists.
 *
 * The security model is the web chat's: the signed visitor token only exists
 * because `/embed/<key>/video` rendered for an origin the venue named, so this
 * route does not re-check the origin. It checks the token's venue against the
 * key's, and everything else — the flag, the kill switch, the list, the plan,
 * the ceilings, the double click — is `startVideoSession`'s.
 *
 * What comes back is the room, a short-lived meeting token and the limits.
 * Never the provider's key, and never the token that drives the model.
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const body = await readBody(req);
  const claim = verifyVisitorToken(typeof body?.token === "string" ? body.token : undefined);
  if (!claim) return NextResponse.json({ error: "expired" }, { status: 401, headers: NO_STORE });

  const location = venueByEmbedKey(key);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (claim.locationId !== location.id) {
    return NextResponse.json({ error: "wrong_venue" }, { status: 403, headers: NO_STORE });
  }
  if (!(await widgetOpenFor(location))) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  // Before Go live only a signed-in owner can get this far (widgetOpenFor), so
  // a session then is the owner's own preview: paid provider time spent at
  // their request, held to the same gate as the test console and the other
  // owner-started paid work (lib/abuse/gate.ts) — confirmed email, trial not
  // paused. A visitor on a live venue's website is not the owner, has no
  // account to verify, and is bounded by the plan, the per-business caps and
  // video's own ceilings in startVideoSession instead.
  const preview = !isActivated(location);
  if (preview) {
    const held = paidWorkRefusal(await currentUser().catch(() => null), location);
    if (held) {
      return NextResponse.json({ error: held.code, message: held.error, fix: held.fix }, { status: held.status, headers: NO_STORE });
    }
  }

  const result = await startVideoSession(location, claim.visitorId, { preview });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.reason,
        retryable: result.retryable,
        // What the panel may offer instead. Booleans only.
        fallback: { chat: chatAllowed(location.embed), voice: voiceAllowed(location.embed) },
      },
      { status: result.status, headers: NO_STORE },
    );
  }
  return NextResponse.json({ ok: true, reused: result.reused, session: result.client }, { headers: NO_STORE });
}
