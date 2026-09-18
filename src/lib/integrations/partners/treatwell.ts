import { closedConnector } from "./closed";
import { PARTNERS } from "./registry";

/**
 * Treatwell. APIs exist; none of them is public.
 *
 * Treatwell's own Partner Terms of Business say they make machine-accessible
 * APIs available and that what a partner actually gets "will be set out in your
 * Specific Partner Agreement". That sentence is the whole integration story:
 * there is no developer portal, no reference, no base URL, no auth model and no
 * sandbox to read before signing. The integrations Treatwell does have —
 * Salonized, which it now owns, Phorest, ClinicSoftware — were negotiated one
 * at a time.
 *
 * Treatwell has merged with Uala, so the counterparty is the combined group and
 * the salon-software side of it is Treatwell Connect. Worth knowing before the
 * first call: Treatwell is also a marketplace that sells the salon its
 * bookings, so a partnership is a conversation about demand and commission as
 * much as about endpoints.
 *
 * **What the founder would have to do:** approach Treatwell/Uala partnerships
 * and negotiate a Specific Partner Agreement. Nothing can be built, and nothing
 * can honestly be estimated, until that agreement exists and the documentation
 * arrives with it.
 */
export const treatwellConnector = closedConnector(PARTNERS.treatwell);
