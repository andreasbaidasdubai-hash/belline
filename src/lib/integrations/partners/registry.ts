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

  /**
   * Microsoft Bookings, through Microsoft Graph: the most complete partner on
   * the list, and the one whose *permission model* is the whole story.
   *
   * Bookings is a first-class Graph resource under `/solutions/bookingBusinesses`
   * and every operation Belline needs is documented in v1.0:
   *
   *   GET   /solutions/bookingBusinesses                      the tenant's calendars
   *   GET   /solutions/bookingBusinesses/{id}                 businessHours, schedulingPolicy
   *   GET   /solutions/bookingBusinesses/{id}/services        duration, buffers, policy
   *   GET   /solutions/bookingBusinesses/{id}/staffMembers    who can be asked for
   *   POST  /solutions/bookingBusinesses/{id}/getStaffAvailability
   *   POST  /solutions/bookingBusinesses/{id}/appointments
   *   PATCH /solutions/bookingBusinesses/{id}/appointments/{id}
   *   POST  /solutions/bookingBusinesses/{id}/appointments/{id}/cancel
   *
   * Availability, create, move and cancel: all four, which no other partner on
   * this list offers. So why is it not simply an extension of the Outlook
   * connection Belline already has?
   *
   * **Because `getStaffAvailability` has no delegated permission at all.**
   * Microsoft's reference is explicit: for delegated work-or-school accounts
   * and for delegated personal accounts it says "Not supported." The only way
   * to read availability is an *application* permission — client credentials,
   * no user in the loop, and therefore tenant-wide admin consent. Belline's
   * Outlook app registration is the opposite of that: delegated scopes on the
   * `common` endpoint, consented by the owner who signs in, deliberately small
   * (integrations/microsoft-api.ts).
   *
   * Three consequences, and they are why this is its own destination rather
   * than a tick-box on the Outlook connection:
   *
   * 1. **Personal Microsoft accounts cannot do this at all.** Every Bookings
   *    permission row for personal accounts reads "Not supported", and the API
   *    overview says the Bookings API applies only to *shared* bookings, never
   *    personal ones. Outlook's `common` endpoint happily takes an Outlook.com
   *    account; Bookings will never work for one.
   * 2. **Admin consent is tenant-wide and cannot be narrowed.** There is no
   *    `Bookings.Read` scoped to one calendar — `Bookings.Read.All` and
   *    `BookingsAppointment.ReadWrite.All` reach every booking business in the
   *    tenant. Bolting that onto the Outlook app would turn a modest calendar
   *    consent screen into a tenant-wide grant for every Outlook customer,
   *    including the ones who only wanted their own diary read.
   * 3. **Microsoft makes the app responsible for the business rules.** Its
   *    "Business rules validation" page says apps creating appointments with
   *    application permissions must themselves honour business hours, the time
   *    slot interval, minimum and maximum lead time, pre- and post-buffers and
   *    the `allowStaffSelection` setting — service-level policy overriding
   *    business-level. Nothing validates this for us.
   *
   * That third point is the risk worth naming. `getStaffAvailability` returns
   * coarse Available/Busy *intervals* ("available 08:00–15:00"), not bookable
   * starts, so Belline has to cut them on the venue's own increment and fit the
   * service plus its buffers inside. That is computing a grid, which is exactly
   * what Mindbody's `availabledates` trap warns against — with one difference
   * that makes it acceptable here: for Mindbody a truer endpoint existed and we
   * were declining to use it, whereas Microsoft publishes no bookable-slots
   * endpoint at all and documents the arithmetic as the caller's job. The
   * inputs are all the venue's own (msbookings.ts), none is Belline's guess,
   * and `check:msbookings` pins every rule.
   */
  msbookings: {
    id: "msbookings",
    name: "Microsoft Bookings",
    model: "appointments",
    api: {
      documented: true,
      availability: true,
      create: true,
      // PATCH /appointments/{id} moves start, end and staffMemberIds.
      reschedule: true,
      // POST /appointments/{id}/cancel, and Microsoft mails the customer.
      cancel: true,
      staffSelection: true,
      catalogue: true,
    },
    auth:
      "Microsoft Graph application permissions only: OAuth 2.0 client credentials against the venue's own tenant, scope https://graph.microsoft.com/.default. getStaffAvailability has no delegated permission, for work or personal accounts.",
    sandbox: "on-request",
    gate: {
      what:
        "A separate multi-tenant Entra app registration holding BookingsAppointment.ReadWrite.All and Bookings.Read.All as APPLICATION permissions, plus a tenant administrator at each venue granting admin consent (the /adminconsent URL) — a staff member cannot approve this for themselves. The venue also needs a Microsoft 365 licence that includes Bookings and a shared Bookings calendar already set up. Microsoft's own free E5 sandbox tenant now requires a Visual Studio Professional or Enterprise subscription or membership of another qualifying programme, so it is not simply self-serve.",
      apply: "https://learn.microsoft.com/en-us/graph/auth-v2-service",
      docs: "https://learn.microsoft.com/en-us/graph/api/resources/booking-api-overview",
    },
    liveNeeds: ["PARTNER_MSBOOKINGS_CLIENT_ID", "PARTNER_MSBOOKINGS_CLIENT_SECRET"],
    venueNeeds: [
      "the venue's Microsoft 365 tenant id",
      "the bookingBusiness id (an SMTP-style address)",
      "admin consent granted by that tenant's administrator",
    ],
    limits: [
      "Availability has no delegated permission, so this can never ride on the Outlook connection the owner clicks through. It needs application permissions and a tenant administrator, which is a different and much larger conversation than 'connect my calendar'.",
      "Application permissions are tenant-wide and cannot be narrowed to one calendar: Bookings.Read.All and BookingsAppointment.ReadWrite.All reach every booking business in the tenant. Belline holds more access than the job needs, and that must be said plainly to the administrator being asked for it.",
      "Personal Microsoft accounts are not supported at all — the API covers shared bookings only. An owner running Bookings on a personal account has nothing to connect.",
      "getStaffAvailability returns Available/Busy intervals, not bookable starts. Belline has to cut them on the venue's own time increment and fit the service and its buffers inside, because Microsoft documents that arithmetic as the app's responsibility and publishes no slots endpoint.",
      "There is no idempotency key on POST /appointments. A retried create is a second appointment, so Belline's own key check is the only guard — the same exposure as Zenoti's confirm.",
      "Staff selection is only honest where the venue set allowStaffSelection on its scheduling policy. Where it is off, Bookings picks the person and Belline must not promise one.",
      "UNVERIFIED: whether a customer email address is mandatory on POST /appointments. The bookingCustomerInformation shape carries name, emailAddress and phone, and Bookings mails a confirmation, but the reference does not mark the address required. To be checked against a real calendar before any venue is connected.",
    ],
  },

  /**
   * Cal.com: the only one on this list with no gatekeeper at all.
   *
   * Open source (AGPLv3), a published REST API at `https://api.cal.com/v2`,
   * and a key the account holder mints for themselves in their own settings.
   * No programme, no application, no partnership, no review. A salon owner
   * could connect Belline this afternoon.
   *
   *   GET  /v2/slots?eventTypeId=&start=&end=&timeZone=&format=range
   *   POST /v2/bookings
   *   POST /v2/bookings/{uid}/reschedule
   *   POST /v2/bookings/{uid}/cancel
   *   GET  /v2/event-types
   *
   * Every endpoint is pinned to a dated contract through a mandatory
   * `cal-api-version` header, and the versions differ per endpoint — slots is
   * `2024-09-04`, bookings `2026-02-25`, event types `2024-06-14`. Cal.com's
   * own note says that sending the wrong value silently falls back to an older
   * version of the endpoint, which is the most dangerous kind of failure: the
   * call succeeds and means something else. The adapter pins all three and
   * `check:calcom` fails if any is dropped.
   *
   * ## The booking-page shape, and where Cal.com differs from Calendly
   *
   * This is the second worked example of the shape Calendly established, and
   * the two are not interchangeable. What they share: the *event type* decides
   * the length, not Belline; availability is the owner's real calendar, their
   * buffers, their notice and their caps, computed by the partner and never
   * reconstructed here; a booking needs an attendee email address; a pooled
   * event type lets the partner choose the host, so no name may be promised;
   * and neither holds a slot while a caller decides.
   *
   * Where they part:
   *
   * - **Cal.com can move a booking.** `POST /v2/bookings/{uid}/reschedule` is a
   *   real endpoint. Calendly has none, so a move there is a create followed by
   *   a cancel, two emails and two of the day's booking allowance. Cal.com
   *   keeps the guest's booking as one thing.
   * - **Cal.com can be self-hosted**, so the base URL is a property of the
   *   venue rather than a constant. A self-hosted instance may be on an older
   *   release than the pinned `cal-api-version`, which is a failure mode
   *   Calendly simply cannot have.
   * - **The version header.** Calendly has nothing like it.
   * - **Rate limits are flat**: 120 requests a minute on an API key, against
   *   Calendly's per-plan booking allowances (10 a minute, 50 an hour, 100 a
   *   day, five a day on a trial).
   * - **Managed event types are a trap Calendly has no equivalent of.** A
   *   managed event type is a template; Cal.com's docs say slots cannot be
   *   fetched for the parent at all, and the child event type ids must be used
   *   instead. A venue mapped to a parent would look connected and quote
   *   nothing.
   *
   * The credential model is Zenoti's rather than Calendly's: the key belongs to
   * the venue and is sealed on it, because Cal.com's OAuth — the `x-cal-client-id`
   * and `x-cal-secret-key` platform clients that would let an owner self-connect
   * from Belline's setup — is a paid Platform product and an official-partner
   * listing, which is a decision to make later rather than a prerequisite now.
   */
  calcom: {
    id: "calcom",
    name: "Cal.com",
    model: "appointments",
    api: {
      documented: true,
      availability: true,
      create: true,
      reschedule: true,
      cancel: true,
      // True only where the event type is a solo one; a round-robin or
      // collective type lets Cal.com choose, and the adapter refuses to name a
      // person for those. See `limits`.
      staffSelection: true,
      catalogue: true,
    },
    auth:
      "Authorization: Bearer <cal_live_… key>, minted by the account holder in their own Cal.com settings, plus a mandatory per-endpoint cal-api-version header. Platform OAuth clients exist but are a paid product.",
    sandbox: "self-serve",
    gate: {
      what:
        "Nothing to apply for, and nobody to ask. The venue's own Cal.com account holder creates an API key in their settings and gives it to Belline, exactly as a Zenoti admin does — except that here it is free, self-serve and takes a minute. The only thing that would need Cal.com's agreement is the paid Platform plan and a verified OAuth client, which would let owners self-connect from Belline's setup instead of pasting a key, and would be needed to be listed in Cal.com's own app store.",
      apply: "https://cal.com/docs/api-reference/v2/introduction",
      docs: "https://cal.com/docs/api-reference/v2/introduction",
    },
    liveNeeds: [],
    venueNeeds: [
      "the venue's own Cal.com API key, sealed",
      "the event type id for each service Belline may book",
      "the IANA time zone the account answers in",
      "the base URL, where the venue self-hosts",
    ],
    limits: [
      "A booking needs an attendee email address. Cal.com's POST /v2/bookings will not take one without it, and it is where the confirmation and the reschedule and cancel links go. A caller who will not give an address cannot be booked, and is taken as a request instead.",
      "The event type fixes the length. Belline's own service duration chooses which event type to use and what to say on the phone; it never overrides Cal.com's.",
      "A round-robin or collective event type lets Cal.com choose the host, so Belline must not promise the caller a particular person on those.",
      "Managed event types are templates: Cal.com documents that slots cannot be fetched for the parent, only for the per-member child event types. A venue mapped to a parent id would look connected and quote nothing.",
      "Nothing holds a slot. Between quoting a time and writing the booking, Cal.com may have given it to somebody else, and the caller is told at the time rather than afterwards.",
      "Every endpoint needs its own dated cal-api-version header, and Cal.com says an absent or wrong value silently falls back to an older version of that endpoint rather than failing.",
      "120 requests a minute on an API key. A busy evening asking for slots has to be cached rather than polled.",
      "A self-hosted instance may run an older release than the pinned API versions, so the base URL and the version are a pair the venue has to be asked about together.",
      "The key is the account holder's and is not scoped to one event type: it can read and write everything that account can. Sealed and audited like Zenoti's.",
      "UNVERIFIED: whether Cal.com's free plan can take API bookings. Calendly's cannot, which is the kind of difference that only shows up on a customer's first call, and it must be checked on a real free account before a venue is connected.",
      "The website's gate is weaker here than for a partner Belline holds credentials with. Mindbody cannot say 'Available' until Mindbody has approved us, because its liveNeeds hold credentials the approval issues; Cal.com has no such credential to wait for, so the only thing between the flag and the word 'Available' is somebody setting PARTNER_CALCOM_ENV=live on a deployment. Zenoti is the same shape. That is a human act rather than a partner's, and it is the one to be careful with.",
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
   * Eat App: Dubai-founded, strong in the Gulf, and — unlike the other two
   * restaurant systems — it actually publishes the API.
   *
   * Not on a developer portal: `eatapp.co/developers`, `developers.eatapp.co`
   * and `docs.eatapp.co` do not resolve at all. The documentation lives as
   * articles inside their customer help centre at `restaurant.eatapp.co/knowledge/`,
   * which is why it is easy to conclude there is nothing there. There is.
   *
   * Two separate APIs, and which one Belline is on decides what it can do.
   *
   * **The Partner API** is the one for booking channels, which is what Belline
   * is. It is two endpoints:
   *
   *   GET  /partners/v2/availability      time_slots for a date and a party size
   *   POST /partners/v2/reservations
   *
   * with `Authorization: Bearer <token>` and a documented sandbox at
   * `https://api.eat-sandbox.co`, production at `https://api.eatapp.co`, and a
   * sandbox partner portal to inspect what was booked. That is more than
   * OpenTable gives an approved partner, whose sandbox excludes booking
   * entirely.
   *
   * **The Concierge API** is the richer one — `POST /concierge/v2/availability/range`,
   * `POST /concierge/v2/reservations`, `PATCH /concierge/v2/reservations/:id`
   * for both modifying and cancelling, `GET /resources`, `GET /guests`, and an
   * `idempotency_token` on create — scoped by an `X-Restaurant-ID` or
   * `X-Group-ID` header. It is a different grant, issued to restaurants,
   * groups and vendors syncing data rather than to a booking channel.
   *
   * So the honest position: Belline builds on the Partner API, which can quote
   * and book and nothing else. Moving and cancelling are recorded as `false`,
   * the agent is given no tool for them, and a guest who rings to cancel is
   * taken as a message — exactly as for Mindbody. The Concierge `PATCH` is
   * written down above so that the day Eat App issues a Concierge grant the
   * work is an afternoon rather than a project, but nothing is built against a
   * credential nobody has offered.
   *
   * ## The restaurant note, tested against a real restaurant API
   *
   * Eat App confirms most of what the note at the foot of this file predicts,
   * from its own help centre: party size is the question (`guests` is required,
   * `covers` in the Concierge dialect — the two APIs disagree on the word);
   * the venue sets a slot interval, and 30 minutes is its own example; a shift
   * is "the range where customers can either make reservations or walk in"
   * rather than the kitchen's hours; turn time is "adjusted based on the number
   * of covers"; pacing caps either arrivals per slot or covers per shift; and
   * there is a notice period.
   *
   * But it contradicts the note on one point, and that is the useful finding:
   * **there is no slot lock.** The note says a partner reservation adapter
   * "must expect a two-phase hold", because OpenTable and SevenRooms both have
   * one. Eat App publishes no hold and no lock primitive at all — the only
   * concurrency protection documented anywhere is the Concierge
   * `idempotency_token`, and that is on the API Belline is not on. For a voice
   * agent that is a real limitation: the table cannot be held while the caller
   * makes up their mind, so a time quoted at the start of a sentence may be
   * gone by the end of it.
   */
  eatapp: {
    id: "eatapp",
    name: "Eat App",
    model: "reservations",
    api: {
      documented: true,
      availability: true,
      create: true,
      // Both live on the Concierge API's PATCH /reservations/:id, which is a
      // different grant from the Partner API Belline would be issued. See the
      // comment above and `limits`.
      reschedule: false,
      cancel: false,
      // Nobody asks for a waiter.
      staffSelection: false,
      // GET /resources is Concierge-only; the Partner API publishes no
      // catalogue, so Belline is told the restaurant's shape rather than reading it.
      catalogue: false,
    },
    auth: "Authorization: Bearer <api token>, issued by Eat App per partner. The Concierge API adds an X-Restaurant-ID or X-Group-ID scope header.",
    sandbox: "on-request",
    gate: {
      what:
        "A partner onboarding conversation with Eat App: their become-a-partner page books a 30-minute call, and their integrations page says plainly to reach out for API access. The sandbox at api.eat-sandbox.co and the token are both things Eat App issues — there is no self-serve key generation — and each restaurant must be on a subscription that includes the integration. Write to info@eatapp.co for partnerships or support@eatapp.co for the technical side.",
      apply: "https://restaurant.eatapp.co/become-a-partner-eat-app",
      docs: "https://restaurant.eatapp.co/knowledge/using-the-eat-app-partner-api-to-get-and-post-availability",
    },
    liveNeeds: [],
    venueNeeds: ["the restaurant's own Eat App id", "that restaurant enabled on Belline's partner token"],
    limits: [
      "Nothing holds a table. Eat App publishes no slot lock or hold on the Partner API, so a time quoted while a caller is still deciding may be gone before they finish. This is the one place the restaurant note's 'expect a two-phase hold' does not hold.",
      "Moving and cancelling are on the Concierge API (PATCH /concierge/v2/reservations/:id), which is a different grant from the Partner API a booking channel is issued. Until Eat App grants both, a guest who rings to cancel is taken as a message and Belline never says it is done.",
      "No idempotency key on the Partner API's create. The Concierge API has an idempotency_token and the Partner API does not, so Belline's own key check is the only guard against a retry becoming two tables.",
      "No catalogue on the Partner API. GET /resources is Concierge-only, so the restaurant's rooms and tables are whatever setup recorded rather than something Belline can read back.",
      "Party size is required, and the two APIs disagree on the word for it — 'guests' on the Partner API, 'covers' on the Concierge one. A port from one to the other that keeps the field name would silently book parties of nobody.",
      "The waitlist is a product Eat App sells and does not expose: no waitlist endpoint is published, so Belline cannot put a caller in a real queue or quote them a wait.",
      "No rate limits are published, so the safe assumption is that a busy evening's availability must be cached rather than polled.",
      "UNVERIFIED: the exact JSON:API envelope of GET /partners/v2/availability, and how the restaurant is identified on it. The field name time_slots and the 30-minute example values come from Eat App's own help centre, but the surrounding shape was not confirmed against a live sandbox. The adapter refuses anything it does not recognise rather than guessing, and this must be checked before any restaurant is connected.",
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
