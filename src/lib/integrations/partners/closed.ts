import { partnerLinkOf, type PartnerApi, type PartnerBookingRef, type PartnerConnector, type PartnerFacts, type PartnerVenue } from "./contract";

/**
 * A partner whose API Belline cannot reach, and will not pretend to.
 *
 * Four of the six are here: Fresha, which has no booking API at all; Treatwell,
 * which publishes nothing and works by signed agreement; OpenTable, whose
 * endpoint reference is behind a partner application; and SevenRooms, whose
 * documentation went behind a login in February.
 *
 * The temptation with these is a "sandbox mode" that books happily against a
 * fake and makes six green checks. That would be the worst thing in this
 * directory: a stub that behaves like a working integration teaches everybody —
 * the tests, the next developer, eventually the website — that the integration
 * works. So an adapter here has no API at all. `apiFor` returns null however
 * the flags are set, `usable` is false on every venue, and the venue keeps
 * taking requests exactly as it does today.
 *
 * What these adapters are *for*, then: they hold the researched facts
 * (registry.ts) where the checks and the website can read them, they prove by
 * running that a venue on this partner is never quoted a time and never told a
 * booking was made, and they are the file that gets an implementation the week
 * a signature arrives. The gate for each is written down in the registry, in
 * the words of whoever would have to act on it.
 */
export function closedConnector(facts: PartnerFacts): PartnerConnector {
  return {
    facts,

    /** A venue may have recorded that it uses this system. That is not a connection. */
    linked(location: PartnerVenue): boolean {
      return Boolean(partnerLinkOf(location, facts.id)?.venueId);
    },

    usable(): boolean {
      return false;
    },

    apiFor(): PartnerApi | null {
      return null;
    },

    refFields(ref: PartnerBookingRef) {
      return { partnerBookingId: ref.id, partnerRef: ref.ref };
    },
  };
}
