import type { DestinationKind, Location } from "../types";

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

/**
 * Does this venue take requests rather than confirmed bookings?
 *
 * Google, Outlook and partner systems count as requests until their adapters
 * exist. An owner who chose one is not told it works; the agent takes the
 * details and the team confirms, which is what happens today.
 */
export function takesRequestsOnly(location: Pick<Location, "onboarding">): boolean {
  return destinationOf(location) !== "belline";
}

/** The owner's own booking link, when they gave one. */
export function bookingLinkOf(location: Pick<Location, "onboarding">): string | undefined {
  return takesRequestsOnly(location) ? location.onboarding?.destination?.bookingLink : undefined;
}
