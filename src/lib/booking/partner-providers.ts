import type { PartnerId } from "../integrations/partners/contract";
import { PARTNER_CONNECTORS } from "../integrations/partners";
import { partnerProvider } from "./partner-provider";
import type { BookingProvider } from "./provider";

/**
 * One booking provider per partner system, as google-provider.ts is one for
 * Google.
 *
 * Each is the shared partner behaviour (partner-provider.ts) over that
 * partner's own connector (integrations/partners/<id>.ts). They are built once
 * and are inert until the partner is connected: several can never be, because
 * no API exists to connect to, and their providers exist to refuse provably
 * rather than by accident.
 */
export const PARTNER_PROVIDERS: Record<PartnerId, BookingProvider> = {
  fresha: partnerProvider(PARTNER_CONNECTORS.fresha),
  zenoti: partnerProvider(PARTNER_CONNECTORS.zenoti),
  mindbody: partnerProvider(PARTNER_CONNECTORS.mindbody),
  msbookings: partnerProvider(PARTNER_CONNECTORS.msbookings),
  calcom: partnerProvider(PARTNER_CONNECTORS.calcom),
  treatwell: partnerProvider(PARTNER_CONNECTORS.treatwell),
  opentable: partnerProvider(PARTNER_CONNECTORS.opentable),
  sevenrooms: partnerProvider(PARTNER_CONNECTORS.sevenrooms),
  eatapp: partnerProvider(PARTNER_CONNECTORS.eatapp),
};

export function partnerProviderFor(id: PartnerId): BookingProvider {
  return PARTNER_PROVIDERS[id];
}
