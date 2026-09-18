import { closedConnector } from "./closed";
import { PARTNERS } from "./registry";

/**
 * Fresha. There is nothing to connect to.
 *
 * This is the one on the list our Gulf customers ask about most, and it is the
 * one with the least to work with. Fresha publishes no booking API: no
 * developer portal (the `developers.fresha.com` that several third-party
 * articles cite does not resolve at all), no reference, no sandbox, no partner
 * programme with a form on it. Their one official programmatic product, the
 * Data Connector, is a paid one-way Snowflake share of reporting data — Fresha
 * say themselves that nothing flows back through it — so it can neither read a
 * bookable time nor write an appointment.
 *
 * That leaves scraping, which Belline will not do. It breaks Fresha's terms, it
 * takes the salon's data without the salon's software agreeing, and a booking
 * made that way is one nobody could stand behind when it goes wrong at the
 * chair.
 *
 * **What the founder would have to do:** approach Fresha commercially — a
 * partnerships or business development conversation — and ask for booking API
 * access that does not exist as a product today. There is no queue to join and
 * no application to submit. Until that conversation happens and changes
 * something, a salon on Fresha is a salon where Belline takes the request and
 * the team confirms, and the website says "on our roadmap", which is true.
 *
 * Prioritised first among the six on customer demand, and honestly last on what
 * can be built. Those two facts belong in the same sentence whenever Fresha
 * comes up.
 */
export const freshaConnector = closedConnector(PARTNERS.fresha);
