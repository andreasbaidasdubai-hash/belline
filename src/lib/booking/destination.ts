import type { DestinationKind, Location } from "../types";
import { flag } from "../flags";

/**
 * Where this venue's bookings go, without loading the booking engine.
 *
 * Kept apart from provider.ts so the prompt and the setup pages can ask the
 * question without importing the diary, the store and the holds.
 *
 * No destination recorded means Belline's own diary: every venue that predates
 * the journey runs on it, and the backfill says so explicitly.
 */
export function destinationOf(location: Pick<Location, "onboarding">): DestinationKind {
  return location.onboarding?.destination?.kind ?? "belline";
}

type Venue = Pick<Location, "onboarding"> & { google?: Location["google"] };

/**
 * Can Belline book into this venue's Google Calendar right now?
 *
 * The flag is on, a sealed token is stored, and Google has not stopped
 * accepting it. Any of the three missing and the venue takes requests.
 */
export function googleUsable(location: Venue, env: Record<string, string | undefined> = process.env): boolean {
  const link = location.google;
  return Boolean(link?.sealedToken && !link.expiredAt && flag("booking.google", env));
}

/**
 * Does this venue take requests rather than confirmed bookings?
 *
 * Outlook and partner systems count as requests until their adapters exist.
 * Google counts as requests whenever its connection is not usable — flag off,
 * never connected, or the token expired — so a calendar Belline cannot see is
 * never booked into. An owner who chose one is not told it works; the agent
 * takes the details and the team confirms.
 */
export function takesRequestsOnly(location: Venue): boolean {
  const kind = destinationOf(location);
  if (kind === "belline") return false;
  if (kind === "google") return !googleUsable(location);
  return true;
}

/** The owner's own booking link, when they gave one. */
export function bookingLinkOf(location: Pick<Location, "onboarding">): string | undefined {
  return takesRequestsOnly(location) ? location.onboarding?.destination?.bookingLink : undefined;
}
