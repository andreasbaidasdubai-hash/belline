import { NextResponse } from "next/server";
import type { Location } from "../../types";
import { getLocation } from "../../store";
import { seedIfEmpty } from "../../seed";
import { BELLINE_LOCATION_ID } from "../../seed-belline";
import { NO_STORE, sessionForClient } from "../../video/http";
import type { VideoSession } from "../../video/sessions";
import { resolveDemoToken } from "./service";
import type { VideoDemoLink } from "./store";

/**
 * What every public video-demo route checks first.
 *
 * The URL's token must be a live link (signed, unexpired, not revoked — the
 * record is read every time). A session the visitor names must be a session
 * that was started from *this* link: a valid session and client token from
 * another prospect's link is refused exactly as a forged one is, so one link's
 * token can never reach another prospect's conversation or context.
 */

export function bellineVenue(): Location | undefined {
  seedIfEmpty();
  return getLocation(BELLINE_LOCATION_ID);
}

export async function linkFromParams(
  params: Promise<{ token: string }>,
): Promise<{ ok: true; link: VideoDemoLink; token: string; venue: Location } | { ok: false; response: NextResponse }> {
  const { token } = await params;
  const resolved = await resolveDemoToken(token);
  if (!resolved.ok) {
    const status = resolved.reason === "expired" || resolved.reason === "revoked" ? 410 : 404;
    return { ok: false, response: NextResponse.json({ error: resolved.reason }, { status, headers: NO_STORE }) };
  }
  const venue = bellineVenue();
  if (!venue) return { ok: false, response: NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE }) };
  return { ok: true, link: resolved.link, token: resolved.token, venue };
}

export function demoSessionForClient(
  link: VideoDemoLink,
  venue: Location,
  sessionId: unknown,
  clientToken: unknown,
): { ok: true; session: VideoSession } | { ok: false; response: NextResponse } {
  const found = sessionForClient(venue, sessionId, clientToken);
  if (!found.ok) return found;
  if (found.session.demo?.linkId !== link.id) {
    return { ok: false, response: NextResponse.json({ error: "not_authorised" }, { status: 401, headers: NO_STORE }) };
  }
  return found;
}

export { NO_STORE };
