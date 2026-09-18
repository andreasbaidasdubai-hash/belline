import type { Location } from "../../types";
import { partnerMode, type PartnerConnector, type PartnerId, type PartnerVenue } from "./contract";
import { calcomConnector } from "./calcom";
import { freshaConnector } from "./fresha";
import { mindbodyConnector } from "./mindbody";
import { msbookingsConnector } from "./msbookings";
import { opentableConnector } from "./opentable";
import { PARTNERS } from "./registry";
import { sevenroomsConnector } from "./sevenrooms";
import { treatwellConnector } from "./treatwell";
import { zenotiConnector } from "./zenoti";

/**
 * Every partner booking system Belline has an adapter for, connected or not.
 *
 * Some could work with credentials (Zenoti, Mindbody, Microsoft Bookings).
 * Others cannot work at all until somebody signs something (Fresha, Treatwell,
 * OpenTable, SevenRooms), and their adapters say so by refusing rather than by
 * pretending. Which is which is in registry.ts — `facts.api.create` is the
 * question, not the file name — and the website reads it from there.
 */
export const PARTNER_CONNECTORS: Record<PartnerId, PartnerConnector> = {
  fresha: freshaConnector,
  zenoti: zenotiConnector,
  mindbody: mindbodyConnector,
  msbookings: msbookingsConnector,
  calcom: calcomConnector,
  treatwell: treatwellConnector,
  opentable: opentableConnector,
  sevenrooms: sevenroomsConnector,
};

export function partnerConnector(id: PartnerId): PartnerConnector {
  return PARTNER_CONNECTORS[id];
}

/**
 * Is this a partner Belline may tell the public it connects to?
 *
 * Deliberately stricter than the flag. The flag says this deployment has a key
 * and somebody switched it on, which is what the *product* needs to try. The
 * website is a promise to a stranger, and it needs three things at once: an
 * API that can actually take a booking, credentials that are production rather
 * than sandbox, and the flag. A partner in sandbox is a partner we are testing
 * against, and telling a salon owner it is "Available" because a test key is
 * set would be exactly the kind of lie check:honesty exists to prevent.
 *
 * Every partner is false today, and will stay false until a partner agreement
 * exists. See site-integrations.ts, which is the only place this is used.
 */
export function partnerLive(id: string, env: Record<string, string | undefined> = process.env): boolean {
  const facts = PARTNERS[id as PartnerId];
  // A partner with no researched facts is not one this file can vouch for.
  // Calendly is the live example: it is being built on another branch and will
  // bring its own entry here, and until it does the strip falls back to its
  // flag, which is how it behaves today. Nothing else may be added to the
  // website's strip without an entry in registry.ts — check-partners.ts holds
  // that line, so a logo can never appear with no honest answer behind it.
  if (!facts) return true;
  return facts.api.create && partnerMode(facts, env) === "live";
}

/** The partner this venue's bookings go to, where it chose one. */
export function partnerIdOf(location: Pick<Location, "onboarding">): PartnerId | undefined {
  const chosen = location.onboarding?.destination;
  if (chosen?.kind !== "partner") return undefined;
  const id = chosen.partner as PartnerId | undefined;
  return id && id in PARTNERS ? id : undefined;
}

/**
 * Can Belline book into this venue's partner system right now?
 *
 * The same four questions Google and Outlook are asked (destination.ts): the
 * flag is on, credentials exist, the partner has not stopped accepting them,
 * and this particular venue is connected — which for a partner means the
 * salon's own centre id or site id and, in production, the grant its owner
 * issued. Any of them missing and the venue takes requests.
 */
export function partnerUsable(location: PartnerVenue, env: Record<string, string | undefined> = process.env): boolean {
  const id = partnerIdOf(location);
  if (!id) return false;
  return PARTNER_CONNECTORS[id].usable(location, env);
}

export { PARTNERS, PARTNER_IDS, RESTAURANT_MODEL_NOTE, partnerFacts } from "./registry";
export type { PartnerFacts, PartnerId, PartnerMode } from "./contract";
