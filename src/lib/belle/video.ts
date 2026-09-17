import { NextResponse } from "next/server";
import type { VideoSession } from "../video/sessions";
import { NO_STORE, sessionForClient } from "../video/http";
import { currentUser } from "../auth-server";
import { bellineVenue } from "./identity";

/**
 * An owner's own support call, for the end, event and mock routes: the
 * session's client token must match, the session must be a support call, and
 * it must be the signed-in owner's. Another owner's session id is a 404.
 */
export async function supportSessionFor(
  sessionId: unknown,
  clientToken: unknown,
): Promise<{ ok: true; session: VideoSession } | { ok: false; response: NextResponse }> {
  const user = await currentUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "not_authorised" }, { status: 401, headers: NO_STORE }) };
  const venue = bellineVenue();
  if (!venue) return { ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE }) };
  const found = sessionForClient(venue, sessionId, clientToken);
  if (!found.ok) return found;
  if (found.session.support?.userId !== user.id) {
    return { ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE }) };
  }
  return found;
}
