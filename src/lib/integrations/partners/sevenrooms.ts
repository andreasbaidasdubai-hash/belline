import { closedConnector } from "./closed";
import { PARTNERS } from "./registry";

/**
 * SevenRooms. The most closed of the six, as of this February.
 *
 * `api-docs.sevenrooms.com` and `pos-api-docs.sevenrooms.com` are login walls:
 * documentation moved to individually provisioned accounts, so a prospective
 * partner cannot read the endpoints, the auth model or the rate limits before
 * being let in. The capability set is well attested second-hand — venue lookup,
 * shift-level availability, reservations carrying party size, table assignment,
 * channel and tags, guest profiles — but no path and no base URL is officially
 * public, and second-hand is not good enough to build on.
 *
 * One trap recorded so nobody falls into it twice: a GitHub repository
 * (`PolyAI-LDN/sevenrooms-api`) documents `POST /check-availability` and
 * `POST /book` against a Railway host with a static bearer token. That is
 * somebody else's wrapper in front of eleven restaurants. It is not SevenRooms'
 * API, and nothing here is built against it.
 *
 * **What the founder would have to do:** email api-integration-support@sevenrooms.com
 * or submit the partnerships form to be provisioned a documentation account —
 * that is required to read the reference at all — then negotiate a partnership
 * agreement. Access is two-sided: credentials are scoped to a venue group and
 * each restaurant's own SevenRooms contract tier decides whether it can
 * authorise us, so a signed partnership is necessary and not sufficient.
 *
 * As with OpenTable: a restaurant's book is party size, tables, turn times,
 * shifts and pacing, with no staff to ask for and a slot lock in the middle.
 * See `RESTAURANT_MODEL_NOTE` in registry.ts.
 */
export const sevenroomsConnector = closedConnector(PARTNERS.sevenrooms);
