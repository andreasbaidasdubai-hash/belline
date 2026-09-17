import type { Location, Session, User } from "../types";
import { getLocation } from "../store";
import { seedIfEmpty } from "../seed";
import { BELLINE_LOCATION_ID } from "../seed-belline";
import { chatAllowed } from "../embed";
import { videoAvailability, videoBubbleConfig, videoOffered } from "../video/availability";
import { canEditAgent } from "../auth";

/**
 * Who Belle is, and where she may appear.
 *
 * One name, one face and one disclosure everywhere ("Belle, Belline's AI
 * assistant"): the face is the preview Belline's own venue shows in its video
 * bubble, and the bell when it has none.
 */

export function bellineVenue(): Location | undefined {
  seedIfEmpty();
  return getLocation(BELLINE_LOCATION_ID);
}

/** Belle's face preview, or undefined for the bell. Never throws: a missing face hides a picture, not Belle. */
export function belleFaceUrl(): string | undefined {
  try {
    const venue = bellineVenue();
    if (!venue) return undefined;
    const poster = videoBubbleConfig(venue).posterUrl;
    return poster || undefined;
  } catch {
    return undefined;
  }
}

/** What the public launcher needs, or null where Belle's chat cannot open (the Belline widget is off). */
export function publicBelle(): { video: boolean; faceUrl?: string } | null {
  const venue = bellineVenue();
  if (!venue?.embed || !venue.embed.enabled || !chatAllowed(venue.embed)) return null;
  return { video: videoOffered(venue), faceUrl: belleFaceUrl() };
}

/**
 * Is this session Belline staff viewing a customer's dashboard as the
 * customer (read-only)? The grant is the staff console's own `Session.viewAs`
 * (lib/staff/view-as.ts) — one definition of a view, not a guess at one.
 */
export function isViewAs(session: Session | undefined | null): boolean {
  return Boolean(session?.viewAs);
}

/**
 * May this person see Ask Belle in the dashboard, and on which venue?
 *
 * Only their own account's venue that they may change (Belle saves what she
 * is told), and never on a read-only view-as session: Belle changes things,
 * opens tickets and starts video, and a view can do none of them.
 */
export function dashboardBelleVenue(user: User, venues: Location[], session: Session | undefined | null): Location | undefined {
  if (isViewAs(session)) return undefined;
  return venues.find((l) => l.tenantId === user.tenantId && canEditAgent(user, l.id));
}

/** May an owner talk to Belle on video about their account right now? Belline's support budget, not theirs. */
export function supportVideoOn(): boolean {
  try {
    const venue = bellineVenue();
    return Boolean(venue && videoAvailability(venue, { kind: "support" }).on);
  } catch {
    return false;
  }
}
