import type { PartnerFacts, PartnerId } from "./contract";

/**
 * What each partner booking system actually offers Belline, researched from
 * the partners' own documentation on 2026-09-18 and from nothing else.
 *
 * This file is the honest answer to "can we?", and the website, the checks and
 * the adapters all read it rather than each holding an opinion. Two of the six
 * have a documented API we could write against tomorrow with a key. Four do
 * not, and for those the repository holds a refusal and an application route,
 * not an implementation — a stub that pretends is worse than no stub, because
 * it is a green check that lies.
 *
 * Where a claim below is uncertain it says so in `limits`. Nothing here was
 * inferred from a blog post, a competitor's marketing page or an AI summary:
 * the Fresha research in particular turned up several confident third-party
 * citations of a `developers.fresha.com` that does not resolve at all.
 *
 * None of these is connected. No partner has issued Belline credentials, no
 * application has been made, and `flag("booking.partner.<id>")` is off on every
 * deployment. The website says "on our roadmap" for all six and must keep
 * saying it until an agreement exists — see site-integrations.ts, where a flag
 * alone is deliberately not enough to promote a logo.
 */

export const PARTNERS: Record<PartnerId, PartnerFacts> = {
  // -------------------------------------------------------------------------
  // Salons and clinics in the Gulf: what our customers actually use.
  // -------------------------------------------------------------------------

  /**
   * Fresha: no booking API exists. Not gated — absent.
   *
   * There is no developer portal (`developers.fresha.com`, `developer.fresha.com`
   * and `docs.fresha.com` do not resolve), no API reference, no partner
   * programme to apply to, and no published contact for one. `api.fresha.com`
   * resolves to Fresha's own app gateway and answers 404 at the root; it is
   * their internal traffic, not an offer to us.
   *
   * The only official programmatic surface is the **Data Connector**, a paid
   * add-on that shares reporting data through Snowflake. Fresha's own help
   * centre calls it a one-way sync and says Fresha receives nothing back
   * through it. It cannot read a bookable time and cannot write a booking, so
   * it is not a route to this integration at any price.
   *
   * Which leaves scraping the marketplace, which we will not do: it breaks
   * Fresha's terms, it would be the salon's own data taken without the salon's
   * partner agreeing, and a booking written that way is not a booking anyone
   * would stand behind.
   *
   * So: the adapter refuses, the venue takes requests, the website says "on our
   * roadmap", and the founder's action is a commercial conversation rather than
   * a form.
   */
  fresha: {
    id: "fresha",
    name: "Fresha",
    model: "appointments",
    api: { documented: false, availability: false, create: false, reschedule: false, cancel: false, staffSelection: false, catalogue: false },
    auth: "None published. There is no developer credential to hold.",
    sandbox: "none",
    gate: {
      what:
        "No public API and no partner programme to apply to. The route is a commercial approach to Fresha (partner/BD contact) asking for booking API access, which does not exist as a product today. The Data Connector add-on is reporting only and would not help.",
      docs: "https://www.fresha.com/help-center/knowledge-base/reports/432-data-connector-overview",
    },
    liveNeeds: [],
    venueNeeds: [],
    limits: [
      "No endpoint to read bookable times, so Belline could never quote a Fresha salon's availability.",
      "No endpoint to write, move or cancel an appointment.",
      "The Data Connector is a paid, one-way Snowflake share of reporting data: read-only, no slots, no writes, no webhooks.",
      "Scraping the public marketplace is the only technical route and is not one Belline will take.",
    ],
  },

  /**
   * Zenoti: a real, documented REST API — gated commercially rather than
   * technically, and gated at the salon rather than at us.
   *
   * `https://api.zenoti.com/v1`, documented publicly at docs.zenoti.com.
   * Availability and booking are a four-step flow, which is a better fit for a
   * telephone call than it looks: create a booking (a cart), read its slots,
   * reserve one while the guest decides, then confirm.
   *
   *   POST /v1/bookings                          → booking_id
   *   GET  /v1/bookings/{booking_id}/slots       → slots[] the centre will take
   *   POST /v1/bookings/{booking_id}/slots/reserve
   *   POST /v1/bookings/{booking_id}/slots/confirm
   *   PUT  /v1/invoices/{invoice_id}/cancel
   *
   * The thing to understand before any of that: **the key belongs to the
   * salon, not to Belline.** Zenoti has no third-party OAuth and no
   * "Connect with Zenoti" button. Each centre's admin subscribes to Zenoti's
   * paid API package, creates a backend app under Admin → Setup → Apps, and
   * mints an `Authorization: apikey …` credential which the docs describe as
   * unrestricted. So onboarding a salon means asking its owner to buy an
   * add-on and hand us a full-power key, and the key is stored sealed on the
   * venue, never in env.
   */
  zenoti: {
    id: "zenoti",
    name: "Zenoti",
    model: "appointments",
    api: {
      documented: true,
      availability: true,
      create: true,
      // Zenoti's own docs describe rescheduling as a recipe — cancel, then
      // create, fetch slots, reserve and confirm again — not an endpoint.
      // Belline will not cancel a guest's appointment before it holds the new
      // time, so the agent takes a message instead. See `limits`.
      reschedule: false,
      cancel: true,
      staffSelection: true,
      catalogue: true,
    },
    auth: "Authorization: apikey <key>, minted by each centre's own Zenoti admin. No third-party OAuth exists.",
    sandbox: "on-request",
    gate: {
      what:
        "Each salon must already be a Zenoti customer, must subscribe to the paid Zenoti API package (their CSM enables it), and must create a backend app and issue Belline an API key with the needed endpoints assigned. There is no developer signup, no self-serve sandbox and no public application URL: it goes through the customer's Zenoti account manager, per salon.",
      docs: "https://docs.zenoti.com/docs/authentication",
    },
    liveNeeds: [],
    venueNeeds: ["centre id (center_id)", "the centre's own API key, sealed"],
    limits: [
      "The API key is per salon and unrestricted. Belline holds a credential that can read and write the salon's whole Zenoti tenant, which is a bigger grant than the job needs and must be sealed and audited accordingly.",
      "No third-party OAuth, so a salon cannot self-connect from Belline's setup: its admin mints a key by hand and sends it to us.",
      "Rescheduling is documented as cancel-and-rebook rather than a single call. Belline reports it as unsupported rather than risk cancelling an appointment and failing to get the new time.",
      "Cancellation is documented at the invoice, not the appointment. The confirm response's invoice id is what Belline would store; this is the one part of the flow the research could not pin down with confidence and must be verified against a live tenant before go-live.",
      "No idempotency key. The create/reserve/confirm split limits the damage (an unconfirmed booking is inert) but a retried confirm could double-book; Belline's own key check is the only guard.",
      "60 API calls a minute per organisation by default. Availability for a busy evening has to be cached, not polled.",
    ],
  },

  /**
   * Mindbody: the only one of the six we can build and test today.
   *
   * Public API v6 at `https://api.mindbodyonline.com/public/v6/`, with a
   * swagger document anyone can fetch and a free sandbox (site `-99`, refreshed
   * nightly). Availability is `GET appointment/bookableitems` — Mindbody is
   * explicit that `availabledates` shows when staff are rostered and does not
   * mean bookable, which is exactly the kind of distinction that turns into a
   * caller being offered a time that is not there.
   *
   * Two gates, and the second is the one that shapes our product:
   *
   * 1. Mindbody approves the developer account for live access. Only then does
   *    `GET site/activationcode` work at all.
   * 2. **Every single studio activates us itself.** We call for an activation
   *    code and link for that Site ID; the studio owner signs in and enters it
   *    under Manager Tools → Mindbody Add Ons → API Integrations. Mindbody's
   *    support documentation says plainly that this step cannot be automated.
   *
   * So a Mindbody connection is never a switch we throw for a customer: it is a
   * code we generate and an owner who clicks. Setup will have to say so.
   */
  mindbody: {
    id: "mindbody",
    name: "Mindbody",
    model: "appointments",
    api: {
      documented: true,
      availability: true,
      create: true,
      // POST appointment/updateappointment moves start, end, staff, notes and
      // session type, with a staff token that has the permission.
      reschedule: true,
      // No public v6 endpoint cancels a booked appointment (classes can be
      // cancelled; appointments cannot). See `limits`.
      cancel: false,
      staffSelection: true,
      catalogue: true,
    },
    auth: "Api-Key and SiteId headers on every call, plus a staff user token from POST /public/v6/usertoken/issue in Authorization.",
    sandbox: "self-serve",
    gate: {
      what:
        "Free developer account, then a 'request to go live' that Mindbody reviews and approves for live credentials, then per-studio activation: Belline calls GET site/activationcode for that Site ID and the studio's owner enters the code (Manager Tools → Mindbody Add Ons → API Integrations). The owner's step cannot be automated. Live calls are metered and billed.",
      apply: "https://developers.mindbodyonline.com/",
      docs: "https://developers.mindbodyonline.com/PublicDocumentation/V6",
    },
    liveNeeds: ["PARTNER_MINDBODY_STAFF_USERNAME", "PARTNER_MINDBODY_STAFF_PASSWORD"],
    venueNeeds: ["Site ID", "the studio's activation, confirmed by its owner"],
    limits: [
      "Every studio must activate Belline itself with a code its owner enters. One approval does not open the next salon's door.",
      "No public endpoint cancels a booked appointment in v6, so a guest who rings to cancel is taken as a message for the studio. Belline will not tell them it is cancelled.",
      "1,000 calls per key per day. The sandbox is capped hard; live is billed per call over the allowance, so availability lookups have a price per call.",
      "The booking needs a Mindbody client record, so a first-time guest means creating a client on the studio's account, under its own required-fields rules.",
      "Sandbox data is wiped nightly, so nothing there is evidence of anything a day later.",
    ],
  },

  /**
   * Treatwell: nothing public at all.
   *
   * No developer portal, no reference, no base URL, no auth model, no sandbox.
   * Treatwell's own Partner Terms of Business confirm APIs exist and say the
   * services provided "will be set out in your Specific Partner Agreement" —
   * which is the whole story: access is defined by a signed contract, one
   * partner at a time. The integrations Treatwell does have (Salonized, which
   * it now owns, Phorest, ClinicSoftware) are negotiated bilaterally.
   *
   * Treatwell has merged with Uala, so the counterparty is the combined group,
   * and its own salon software is Treatwell Connect.
   *
   * Nothing is built here beyond a refusal. There is no endpoint to write
   * against, and writing one from guesswork would be inventing an integration.
   */
  treatwell: {
    id: "treatwell",
    name: "Treatwell",
    model: "appointments",
    api: { documented: false, availability: false, create: false, reschedule: false, cancel: false, staffSelection: false, catalogue: false },
    auth: "Not published.",
    sandbox: "none",
    gate: {
      what:
        "A Specific Partner Agreement with Treatwell/Uala, negotiated through their partnerships team. Their Partner Terms of Business confirm APIs exist and are scoped by that agreement; there is no public developer portal, application form or documentation to read first.",
      docs: "https://www.treatwell.co.uk/info/supplier-terms-and-conditions/",
    },
    liveNeeds: [],
    venueNeeds: [],
    limits: [
      "No public documentation of any kind: not endpoints, not auth, not a sandbox. Nothing can be built or estimated until an agreement is signed and the documentation arrives.",
      "Treatwell is also a marketplace that sells the salon its own bookings, so a partnership is a commercial negotiation about demand, not only a technical one.",
    ],
  },

  // -------------------------------------------------------------------------
  // The restaurant two. A different model, not a variant of the one above.
  // -------------------------------------------------------------------------

  /**
   * OpenTable: gated at every technical door, with the platform basics public.
   *
   * What OpenTable does say publicly: the Partner APIs are OAuth 2.0, HTTPS
   * and JSON, every POST/PUT/PATCH must carry a unique `X-Request-Id` so
   * processing is idempotent, and there are Booking, CRM, Directory, Menus,
   * POS, Private Dining, Reviews, Sync and Profile Content families. What it
   * does not say publicly: a single endpoint path or a base URL. The reference
   * pages answer 404 without an approved account.
   *
   * There are third-party write-ups claiming an availability → slot lock →
   * reservations flow. The shape is plausible and matches OpenTable's own
   * description of locking a slot during checkout, but the paths are
   * unverified and are not written into this repository as though they were
   * real.
   *
   * Worth knowing before applying: approval grants **sandbox** access, and the
   * documented sandbox covers Authorization, Directory and Sync only — the
   * Booking API is not in it. So even an approved partner cannot test a
   * reservation until production review is done.
   */
  opentable: {
    id: "opentable",
    name: "OpenTable",
    model: "reservations",
    api: { documented: false, availability: false, create: false, reschedule: false, cancel: false, staffSelection: false, catalogue: false },
    auth: "OAuth 2.0, HTTPS and JSON, with a unique X-Request-Id on every write. The endpoint reference itself is behind partner approval.",
    sandbox: "on-request",
    gate: {
      what:
        "Apply as an API partner, describe the use case, and wait: OpenTable contacts approved applicants in three to four weeks. Approval grants sandbox only, and the sandbox does not include the Booking API. Production needs a further review and a formal commercial agreement, and not every API family is offered at every partnership tier.",
      apply: "https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/",
      docs: "https://docs.opentable.com/",
    },
    liveNeeds: [],
    venueNeeds: [],
    limits: [
      "No public endpoint reference, so nothing can be written against it before approval.",
      "The sandbox excludes the Booking API: a reservation cannot be tested until production review is passed.",
      "Rate limits exist and are not published; OpenTable's platform policy reserves the right to set and charge for them.",
      "A restaurant is not an appointment book (see the note at the foot of this file): party size decides availability, the house decides the turn time, and there is no person to ask for.",
    ],
  },

  /**
   * SevenRooms: the most closed of the six as of February this year.
   *
   * `api-docs.sevenrooms.com` and `pos-api-docs.sevenrooms.com` are login walls;
   * the documentation moved to individually provisioned accounts, so a
   * prospective partner cannot read the endpoint reference, the auth model or
   * the rate limits before being let in. SevenRooms' own marketing describes a
   * flexible API and the capability set is well attested second-hand — venue
   * lookup, shift-level availability, reservations carrying party size, table
   * assignment, channel and tags, guest profiles — but no path, no base URL
   * and no auth detail is officially public.
   *
   * A warning recorded here so nobody re-finds it and trusts it: a GitHub
   * repository (`PolyAI-LDN/sevenrooms-api`) documents `POST /check-availability`
   * and `POST /book` against a Railway host with a static bearer token. That is
   * somebody's own wrapper in front of eleven restaurants. It is not
   * SevenRooms' API and nothing in this repository is built against it.
   *
   * Access is also two-sided: even with a partnership, each venue's own
   * SevenRooms contract tier decides whether it can authorise us.
   */
  sevenrooms: {
    id: "sevenrooms",
    name: "SevenRooms",
    model: "reservations",
    api: { documented: false, availability: false, create: false, reschedule: false, cancel: false, staffSelection: false, catalogue: false },
    auth: "Not published since the February documentation lockdown. Second-hand reports say OAuth 2.0 client credentials scoped to a venue group; unverified.",
    sandbox: "none",
    gate: {
      what:
        "Email api-integration-support@sevenrooms.com or submit the partnerships form to be provisioned a documentation account — reading the reference at all requires it. A partnership agreement follows, and credentials are scoped per venue group, so each restaurant's own SevenRooms contract must also allow it.",
      docs: "https://api-docs.sevenrooms.com/",
    },
    liveNeeds: [],
    venueNeeds: [],
    limits: [
      "Nothing technical is public: no endpoints, no auth, no sandbox, no rate limits. The first honest estimate can only be made after the documentation account is granted.",
      "Credentials are scoped to a venue group and depend on each restaurant's own contract tier, so a signed partnership is necessary and not sufficient.",
      "A restaurant is not an appointment book (see the note below).",
    ],
  },
};

export const PARTNER_IDS = Object.keys(PARTNERS) as PartnerId[];

/**
 * Restaurants are not salons with tables, and this is the note that stops the
 * next person forcing them into one shape.
 *
 * A salon booking is *a person × a service × a time*: the service fixes the
 * length, the guest may ask for Nadia, and availability is one stylist's
 * calendar with the gaps read off it.
 *
 * A restaurant booking is none of those things.
 *
 * - **Party size is the question, not a detail.** "Is 19:00 free?" has no
 *   answer. 19:00 for two and 19:00 for six are different questions with
 *   different answers, in both directions.
 * - **The room is the resource.** A floor plan of tables with capacities and
 *   joining rules, solved across the whole evening. There is no per-person
 *   calendar to read.
 * - **The house sets the length.** A turn time by party size, not a duration
 *   the guest chose. A table booked at 19:00 shapes what 20:00 can be.
 * - **Shifts and sittings.** Inventory is cut into lunch, dinner, first and
 *   second sitting, each with its own hours, pacing and menus. SevenRooms
 *   availability is shift-level for that reason.
 * - **Pacing.** A physically empty table is not always bookable: the kitchen
 *   caps covers per fifteen minutes. A free stylist is always bookable; a free
 *   table is not.
 * - **Nobody asks for a waiter.** The staff dimension that a salon integration
 *   is largely about simply does not exist here.
 * - **Slot locks.** Because the room is re-solved continuously, these APIs
 *   hold a slot while the guest finishes talking and then confirm it. An
 *   availability token goes stale and must not be cached.
 * - **The waitlist is live.** A real queue with a quoted wait, not a salon's
 *   "let me know if something frees up".
 *
 * Belline's own restaurant engine already models tables, sittings and turn
 * times (booking/restaurant.ts), so the concepts are not foreign. But a partner
 * reservation adapter must take `partySize` as required, must not invent a
 * duration, must not offer a person, and must expect a two-phase hold. The
 * shared provider (booking/partner-provider.ts) is written so that a
 * reservations partner cannot quietly behave like an appointments one.
 */
export const RESTAURANT_MODEL_NOTE =
  "Restaurant reservations are party size, table inventory, house-set turn times, shifts and pacing, with no staff selection and a two-phase slot lock. They are not appointments with a party size attached.";

export function partnerFacts(id: PartnerId): PartnerFacts {
  return PARTNERS[id];
}
