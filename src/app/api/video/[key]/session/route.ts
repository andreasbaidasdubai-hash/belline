import { NextResponse } from "next/server";
import { verifyVisitorToken } from "@/lib/auth";
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

  const result = await startVideoSession(location, claim.visitorId, { preview: !isActivated(location) });
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
