import { closedConnector } from "./closed";
import { PARTNERS } from "./registry";

/**
 * OpenTable. A restaurant system, and a closed door with a letterbox.
 *
 * The platform basics are public and worth having written down: the Partner
 * APIs are OAuth 2.0 over HTTPS with JSON, every write must carry a unique
 * `X-Request-Id` so retries are idempotent, and the families are Booking, CRM,
 * Directory, Menus, POS, Private Dining, Reviews, Sync and Profile Content.
 * The endpoint reference itself answers 404 without an approved account, so not
 * one path is written into this repository. Third-party articles describe an
 * availability → slot lock → reservation flow; the shape matches what OpenTable
 * says about locking a slot during checkout, but the paths are unverified and
 * are not treated here as if they were real.
 *
 * The part worth knowing before applying: approval grants **sandbox**, and the
 * documented sandbox covers Authorization, Directory and Sync only. The Booking
 * API is not in it. So even an approved partner cannot make a test reservation
 * until a further production review is passed.
 *
 * **What the founder would have to do:** apply at
 * https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/
 * with the use case. OpenTable contacts approved applicants in three to four
 * weeks. That grants sandbox; production needs a second review and a formal
 * commercial agreement, and not every API family is offered at every tier.
 *
 * And a reminder that outlives any of this: a restaurant is not an appointment
 * book. Party size decides whether a time exists, the house sets the turn time,
 * the room is solved as tables rather than as one person's calendar, pacing can
 * refuse an empty table, and nobody asks for a particular waiter. See
 * `RESTAURANT_MODEL_NOTE` in registry.ts before anyone tries to make this
 * adapter look like the salon ones.
 */
export const opentableConnector = closedConnector(PARTNERS.opentable);
