# Partner booking systems

What Belline can and cannot do through each booking system we have looked at,
researched from the partners' own documentation on **18 September 2026**, and
what the founder would have to apply for.

Thirteen partners, in three batches. The first six — Fresha, Zenoti, Mindbody,
Treatwell, OpenTable, SevenRooms — are the ones on the website's integrations
strip. The second six — Microsoft Bookings, Cal.com, Eat App, Booksy, Vagaro,
Doctolib — are **not on the strip at all**; see "Why the later seven are not on
the website" at the foot of this document. The third batch begins with
**SimplyBook.me**, researched on **19 September 2026**: a system small Gulf
businesses actually run, and one that turned out to be buildable. It is not on
the strip either.

The founder's question for the third batch was the commercial one — *does the
customer have to be on a paid tier for the API?* — because several booking
products put their API behind their most expensive plan, which would make an
integration worthless to the salons we sell to. **For SimplyBook.me the answer
is no**, and that is the most important finding here:

- **SimplyBook.me** delivers the API as an ordinary *custom feature*. Free
  allows one custom feature, Basic (€11.90) three, Standard (€24.90) eight,
  Premium (€49.90) unlimited. The only Enterprise-gated line item is "High Load
  API", which is volume, not access. What it really costs a customer is one
  feature slot, so in practice a working salon moves up a tier — a €13
  conversation, not a €600 one.

Nothing here is connected. No partner has issued Belline credentials, no
application has been made, and every `booking.partner.<id>` flag is off on every
deployment. The website says "on our roadmap" for all of them and keeps saying
it until an agreement exists — a flag alone cannot promote a logo
(`scripts/site-integrations.ts`, `npm run check:partners`).

Google Calendar and Outlook are not in this document. They are calendars, they
are built, and they live in `src/lib/integrations/google.ts` and `outlook.ts`.

## The short answer

| Partner | Availability | Booking | What works now | What is blocked | The founder's move |
| --- | --- | --- | --- | --- | --- |
| **Fresha** | none | none | nothing — there is no API | everything | A commercial approach to Fresha. There is no developer programme, no docs and no form. |
| **Zenoti** | `GET /v1/bookings/{id}/slots` | create → reserve → confirm | adapter written against the documented flow, driven by `check:zenoti` | each salon must buy Zenoti's paid API package and hand us its own key; no third-party OAuth | Ask a Zenoti salon's owner to have their CSM enable the API package and issue Belline a key. |
| **Mindbody** | `GET appointment/bookableitems` | `POST appointment/addappointment` | full adapter; free self-serve sandbox (site `-99`) | go-live approval, then **each studio** activates us with a code its owner types in; no appointment cancellation in v6 | Create a developer account, build on the sandbox, submit "request to go live". |
| **Treatwell** | none published | none published | nothing | no public developer surface whatsoever | Negotiate a Specific Partner Agreement with Treatwell/Uala. |
| **OpenTable** | gated | gated | nothing; platform basics recorded | endpoint reference needs approval; sandbox excludes the Booking API | Apply as an API partner; 3–4 weeks to a reply. |
| **SevenRooms** | gated | gated | nothing | docs behind individually provisioned accounts since February | Email `api-integration-support@sevenrooms.com` for a documentation account. |
| **Microsoft Bookings** | `POST getStaffAvailability` | `POST /appointments`, PATCH to move, `POST /cancel` | **full adapter, all four operations** — the most complete one we have | availability has **no delegated permission**, so it needs application permissions and a tenant admin's consent at every venue; personal Microsoft accounts can never work | Register a second Entra app for application permissions, get publisher verification, and ask each venue's IT administrator for admin consent. |
| **Cal.com** | `GET /v2/slots` | `POST /v2/bookings`, reschedule and cancel endpoints | **full adapter, all four operations**; free and self-serve | nothing — this is the only one with no gatekeeper | Nothing to apply for. Ask a venue's Cal.com account holder for an API key. |
| **Eat App** | `GET /partners/v2/availability` | `POST /partners/v2/reservations` | **adapter for quote and book**; documented sandbox at `api.eat-sandbox.co` | moving and cancelling are on the separate Concierge grant; no slot hold at all | Partner onboarding call via their become-a-partner page; `info@eatapp.co`. |
| **Booksy** | none readable | none readable | nothing | `docs.booksy.com` exists and answers **401**; no programme, no form, no developer address | A cold commercial approach asking to be provisioned a documentation account. |
| **Vagaro** | none published | none published | nothing | docs are readable and contain **no booking API** — read-oriented areas and webhooks only | Enterprise Sales form, and ask the one question: is there an unpublished endpoint that reads availability and writes an appointment? |
| **Doctolib** | none published | none published | nothing | no public API; and appointment data is regulated **health data** — the obstacle is legal, not technical | The German partnership form, expecting a reseller conversation. **Do not hold the launch for it.** |
| **SimplyBook.me** | `GET /admin/schedule/available-slots` | `POST /admin/bookings`, `PUT` to move, `DELETE` to cancel | **full adapter, all four operations**; REST v2, publicly specced in OpenAPI | nothing of ours — but the venue must spend a custom-feature slot, mint an API User Key, turn 2FA off for that user, and tell us which of **thirteen** regional hosts it is on | Nothing to apply for. Ask the salon to enable the API custom feature and issue Belline an API User Key. |

Priority for the first six follows what our customers use: Fresha and Zenoti
(Gulf salons and clinics), then Mindbody, then Treatwell, then the restaurant
two. Note the unhappy shape of that list — **the partner most asked for is the
one with nothing to build against.**

For the second six the shape is happier, and the order is effort against value:
**Cal.com is free and needs nobody's permission**, Microsoft Bookings is the
most capable but needs an administrator at every venue, and Eat App is the first
restaurant system we can actually book into. Booksy, Vagaro and Doctolib are
three more closed doors, and Doctolib's is closed for a reason no partnership
team can open.

## Fresha — no API exists

Not "gated". Absent. `developers.fresha.com`, `developer.fresha.com` and
`docs.fresha.com` do not resolve at all; `api.fresha.com` is Fresha's own app
gateway and answers 404 at the root. Several confident third-party articles cite
a Fresha developer portal — that citation is wrong, and `check:fresha` fails if
the URL ever appears in this repository.

The one official programmatic product is the **Data Connector**: a paid add-on
that shares reporting data through Snowflake. Fresha's own help centre calls it
a one-way sync and says Fresha receives nothing back through it. It cannot read
a bookable time and cannot write an appointment, so it is not a route to this
integration at any price.

That leaves scraping the marketplace, which Belline will not do: it breaks
Fresha's terms, it takes the salon's data without the salon's software agreeing,
and a booking made that way is one nobody could stand behind at the chair.

**Could do:** nothing.
**Could not do:** quote a time, take a booking, move one, cancel one, read the
salon's services or staff.
**Apply for:** nothing — there is no queue. It is a partnerships/BD conversation
asking Fresha for booking API access that does not exist as a product today.

## Zenoti — real API, gated at the salon

`https://api.zenoti.com/v1`, documented publicly at docs.zenoti.com. The flow is
a cart rather than a calendar, which suits a telephone call:

```
POST /v1/bookings                         the guest, the centre, the services
GET  /v1/bookings/{id}/slots              what the centre will actually take
POST /v1/bookings/{id}/slots/reserve      hold it while the guest decides
POST /v1/bookings/{id}/slots/confirm      it is now the salon's appointment
PUT  /v1/invoices/{invoice_id}/cancel
```

Auth is `Authorization: apikey <key>`. **The key belongs to the salon, not to
Belline.** Zenoti has no third-party OAuth and no "Connect with Zenoti" button:
each centre's admin subscribes to the paid API package, creates a backend app
under Admin → Setup → Apps, and issues a key the docs describe as unrestricted.
It is stored sealed on the venue, never in env.

**Could do:** quote the centre's own bookable times, take a booking the salon's
staff see immediately, cancel one, read services and staff, ask for a particular
therapist.
**Could not do:** move an appointment — Zenoti documents rescheduling as
cancel-then-rebook, and Belline will not cancel a guest's appointment on the
chance the new time is still there. Also: no idempotency key (the reserve/confirm
split and Belline's own key are the only guards), 60 calls a minute per
organisation, and no way for an owner to self-connect from Belline's setup.

**Unverified, and marked `UNVERIFIED` in the source:** the guest lookup/create
shape, and that cancellation is at the invoice rather than the appointment. Both
must be checked against a live tenant before the flag is ever set.

**Apply for:** nothing self-serve. Ask a Zenoti salon to have its CSM enable the
API package, then to issue Belline a key scoped to the endpoints above.

## Mindbody — buildable today, production double-gated

Public API v6 at `https://api.mindbodyonline.com/public/v6/`, with a swagger
document anyone can fetch and a **free sandbox** (site `-99`, wiped nightly).

```
POST /public/v6/usertoken/issue            a staff token, per site
GET  /public/v6/appointment/bookableitems  what can actually be booked
POST /public/v6/appointment/addappointment
POST /public/v6/appointment/updateappointment
GET  /public/v6/site/activationcode        after go-live approval only
```

Three headers authenticate every call: `Api-Key` (Belline's), `SiteId` (the
studio's) and `Authorization` (a staff user token).

Mindbody is explicit that `appointment/availabledates` shows when staff are
**rostered**, which is not the same as bookable. Only `bookableitems` is quoted,
and `check:mindbody` fails if that changes.

**Could do:** quote real availability, take a booking, move one, ask for a
particular therapist, read the studio's session types and staff. Mindbody
deduplicates `addappointment` itself, so a retried booking is one appointment.

**Could not do:** cancel a booked appointment — public API v6 has no endpoint
for it (classes can be cancelled; appointments cannot). A guest who rings to
cancel is taken as a message for the studio, and the agent is never given a
cancel tool.

**The gates, in order:**

1. Free developer account at <https://developers.mindbodyonline.com/> — self-serve,
   gives sandbox credentials.
2. "Request to go live": describe the integration and wait for Mindbody to
   approve live credentials. Until then `GET site/activationcode` does not work.
3. **Per studio**: call `site/activationcode` for that Site ID, and the studio's
   owner enters the code under Manager Tools → Mindbody Add Ons → API
   Integrations. Mindbody's support documentation says plainly that the owner's
   step cannot be automated. One approval opens no other door.
4. Commercial: live calls are metered — 1,000 calls per key per day, billed at
   roughly a third of a cent per call over the allowance. Availability lookups
   have a price.

## Treatwell — nothing public at all

No developer portal, no reference, no base URL, no auth model, no sandbox.
Treatwell's own Partner Terms of Business confirm APIs exist and say the services
provided "will be set out in your Specific Partner Agreement". That sentence is
the whole story: access is defined by a signed contract, one partner at a time.

Treatwell has merged with Uala, so the counterparty is the combined group, and
its salon software is Treatwell Connect. The integrations Treatwell does have
(Salonized, which it now owns, Phorest, ClinicSoftware) were negotiated
bilaterally.

**Could do / could not do:** unknowable until the documentation arrives with an
agreement. Nothing can honestly be estimated before then.
**Apply for:** a Specific Partner Agreement, through Treatwell/Uala partnerships.
Expect a commercial negotiation about demand and commission as much as a
technical one — Treatwell also sells the salon its bookings.

## OpenTable — a closed door with a letterbox

Public: the Partner APIs are OAuth 2.0 over HTTPS with JSON, every write carries
a unique `X-Request-Id` so retries are idempotent, and the families are Booking,
CRM, Directory, Menus, POS, Private Dining, Reviews, Sync and Profile Content.
Not public: a single endpoint path or base URL — the reference answers 404
without an approved account. Third-party write-ups describe an
availability → slot lock → reservation flow; the shape matches OpenTable's own
description of locking a slot during checkout, but the paths are unverified and
are **not** written into this repository.

Worth knowing before applying: approval grants **sandbox**, and the documented
sandbox covers Authorization, Directory and Sync only. **The Booking API is not
in it** — an approved partner cannot make a test reservation until production
review is passed.

**Apply for:** <https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/>.
Approved applicants are contacted in 3–4 weeks. Production needs a second review
and a formal commercial agreement, and not every API family is offered at every
tier.

## SevenRooms — the most closed

`api-docs.sevenrooms.com` and `pos-api-docs.sevenrooms.com` are login walls:
documentation moved to individually provisioned accounts in February, so a
prospective partner cannot read the endpoints, the auth model or the rate limits
before being let in. The capability set is well attested second-hand — venue
lookup, shift-level availability, reservations carrying party size, table
assignment, channel and tags, guest profiles — but no path and no base URL is
officially public.

A trap recorded so nobody re-finds it and trusts it: the GitHub repository
`PolyAI-LDN/sevenrooms-api` documents `POST /check-availability` and `POST /book`
against a Railway host with a static bearer token. That is somebody else's
wrapper in front of eleven restaurants. It is not SevenRooms' API.

**Apply for:** a documentation account, by emailing
`api-integration-support@sevenrooms.com` or through the partnerships form, then a
partnership agreement. Access is two-sided: credentials are scoped to a venue
group and each restaurant's own SevenRooms contract tier decides whether it can
authorise us, so a signed partnership is necessary and not sufficient.

## Microsoft Bookings — the most capable, and an administrator's decision

Bookings is a first-class Microsoft Graph resource under
`/solutions/bookingBusinesses`, and every operation Belline needs is documented
in v1.0:

```
GET   /solutions/bookingBusinesses/{id}                  businessHours, schedulingPolicy
GET   /solutions/bookingBusinesses/{id}/services         duration, buffers, policy
GET   /solutions/bookingBusinesses/{id}/staffMembers
POST  /solutions/bookingBusinesses/{id}/getStaffAvailability
POST  /solutions/bookingBusinesses/{id}/appointments
PATCH /solutions/bookingBusinesses/{id}/appointments/{id}
POST  /solutions/bookingBusinesses/{id}/appointments/{id}/cancel
```

Availability, create, move and cancel — all four, which no other partner on the
list offers.

**The question the founder asked: can our existing Microsoft app registration
carry this?** Technically an Entra app can hold both delegated and application
permissions, so yes. But it should not, and the reason is one line of
Microsoft's own reference: **`getStaffAvailability` lists "Not supported" for
delegated work-or-school accounts and for delegated personal accounts alike.**
Availability is application permissions or nothing — client credentials, no user
in the loop, tenant-wide admin consent.

Three things follow.

1. **Personal Microsoft accounts can never work.** Every Bookings permission row
   for personal accounts reads "Not supported", and the API overview says the
   Bookings API applies to *shared* bookings only. Our Outlook connection uses
   the `common` endpoint and happily takes an Outlook.com account. Those two
   audiences are not the same audience.
2. **The grant is tenant-wide and cannot be narrowed.** There is no
   `Bookings.Read` scoped to one calendar; `Bookings.Read.All` and
   `BookingsAppointment.ReadWrite.All` reach every booking business in the
   tenant. Microsoft's guidance is to control this with Entra app-consent
   policies, not with a smaller scope. Bolting that onto the Outlook app would
   turn a modest calendar consent screen into a tenant-wide grant for every
   Outlook customer, including those who only wanted their diary read.
3. **Microsoft makes the app responsible for the business rules.** Its "Business
   rules validation" page says apps creating appointments with application
   permissions must themselves honour business hours, the time slot interval,
   minimum and maximum lead time, pre- and post-buffers and
   `allowStaffSelection`, with service-level policy overriding business-level.

So: **its own destination, its own app registration**, not an extension of the
Outlook connection. `PARTNER_MSBOOKINGS_CLIENT_ID` and `_CLIENT_SECRET` in env,
the venue's tenant id and bookingBusiness id on the location, and the
administrator's consent sealed on the venue.

That third point is the risk worth reviewing. `getStaffAvailability` returns
coarse Available/Busy intervals, not bookable starts, so `slotsFrom` in
`msbookings.ts` cuts them on the venue's own increment and fits the service plus
its buffers inside. That is arithmetic over a partner's availability, which is
exactly what Mindbody's `availabledates` taught us not to do — with one
difference that makes it acceptable: Mindbody had a truer endpoint we were
declining to use, and Microsoft publishes none at all. Every input is read off
the venue's calendar on every call, an unreadable duration or increment means
"no times" rather than a Belline default, and `check:msbookings` fails if a
`?? 30` ever appears beside either.

**Could do:** quote real availability, take a booking, move one, cancel one with
a message Microsoft mails the guest, ask for a particular person where the venue
allows it, read the venue's services and staff.
**Could not do:** work for a personal Microsoft account; hold a narrower grant
than tenant-wide; rely on Microsoft to deduplicate a retried create (there is no
idempotency key — Belline's own key check is the only guard); promise a person
where `allowStaffSelection` is off.
**Unverified, and marked so in the source:** whether a customer email address is
mandatory on `POST /appointments`.

**Apply for:** a second multi-tenant Entra app registration with those two
application permissions; Microsoft publisher verification (organisations
commonly allow staff to approve only verified apps); then, per venue, the
tenant administrator granting admin consent at the `/adminconsent` URL. Note the
sandbox: Microsoft's free E5 developer tenant now requires a Visual Studio
Professional or Enterprise subscription or membership of another qualifying
programme, so it is **not** simply self-serve.

## Cal.com — nobody to ask

Open source under AGPLv3, a published REST API at `https://api.cal.com/v2`, and
a key the venue's own account holder mints in their settings. There is no
programme, no application, no partnership and no review. This is the only one of
the twelve a salon owner could connect this afternoon.

```
GET  /v2/slots?eventTypeId=&start=&end=&timeZone=&format=range
POST /v2/bookings
POST /v2/bookings/{uid}/reschedule
POST /v2/bookings/{uid}/cancel
GET  /v2/event-types
```

Auth is `Authorization: Bearer cal_live_…` plus a **mandatory per-endpoint
`cal-api-version` header** — `2024-09-04` for slots, `2026-02-25` for bookings,
`2024-06-14` for event types. Cal.com documents that a wrong or absent value
silently falls back to an older version of the endpoint instead of failing,
which is the dangerous kind of failure: the call succeeds and means something
else. The versions live in one table in `calcom.ts` and `check:calcom` inspects
every request.

### Where Cal.com and Calendly differ

This is our second worked example of the **booking page** shape. What the two
share: the event type fixes the length, not Belline; availability is the owner's
real calendar and is never reconstructed here; a booking needs an attendee email
address; a pooled event type lets the partner choose the host, so no name may be
promised; and neither holds a slot while a caller decides.

Where they part:

- **Cal.com can move a booking.** `POST /v2/bookings/{uid}/reschedule` is a real
  endpoint. Calendly has none, so a move there is a create followed by a cancel
  — two emails and two of the day's booking allowance. Cal.com keeps the guest's
  booking as one thing, and issues a new uid the mirror must follow.
- **Cal.com can be self-hosted**, so the base URL is a property of the venue
  rather than a constant, and a self-hosted instance may run an older release
  than the pinned API versions. Calendly cannot have that failure mode.
- **The version header.** Calendly has nothing like it.
- **Rate limits are flat**: 120 requests a minute on an API key, against
  Calendly's per-plan booking allowances (10 a minute, 50 an hour, 100 a day,
  five a day on a trial).
- **Managed event types** are a trap with no Calendly equivalent: they are
  templates, and Cal.com's docs say slots cannot be fetched for the parent at
  all — the per-member child ids must be used. A venue mapped to a parent would
  look connected and quote nothing.

Time is the one thing Belline must get right here. Cal.com books an **instant**,
so the venue records the IANA zone its account answers in and a venue without
one is not connected. Slots are asked for in that zone and the instant Cal.com
offered is handed straight back on the booking. The check pins 09:00 in Dubai to
05:00Z, because the failure mode is a Gulf salon taking bookings four hours out.

**Could do:** quote the owner's real availability, take a booking, move one,
cancel one, read the event types.
**Could not do:** book a caller who will not give an email address; override
Cal.com's duration; promise a person on a round-robin or collective event type;
hold a time while the caller decides.
**Unverified:** whether Cal.com's free plan can take API bookings. Calendly's
cannot, and that difference would only show up on a customer's first call.

**Apply for:** nothing. The only thing needing Cal.com's agreement is the paid
Platform plan and a verified OAuth client, which would let owners self-connect
from Belline's setup instead of pasting a key, and would be needed to be listed
in Cal.com's own app store. That is a decision for later, not a prerequisite.

## Eat App — the restaurant API that is actually published

Dubai-founded, strong in the Gulf, and the first restaurant reservation system
Belline can build against rather than refuse. It looks absent because there is
no developer portal — `developers.eatapp.co` and `docs.eatapp.co` do not resolve
— and the reference lives as articles in their customer help centre.

Two APIs, and which one Belline is on decides everything.

**The Partner API**, for booking channels, which is what Belline is:

```
GET  /partners/v2/availability      time_slots for a date and a party size
POST /partners/v2/reservations
```

with a bearer token, a documented sandbox at `https://api.eat-sandbox.co`,
production at `https://api.eatapp.co`, and a sandbox portal to inspect what was
booked. That is more than OpenTable gives an approved partner, whose sandbox
excludes the Booking API entirely.

**The Concierge API** is richer — `POST /concierge/v2/availability/range`,
`PATCH /concierge/v2/reservations/:id` for both modifying and cancelling,
`GET /resources`, `GET /guests`, and an `idempotency_token` on create — scoped by
an `X-Restaurant-ID` or `X-Group-ID` header. It is a different grant, issued to
restaurants and vendors rather than to booking channels.

So Belline builds on the Partner API and can quote and book, and nothing else.
Moving and cancelling are recorded as `false`, the agent gets no tool for them,
and a guest who rings to cancel is taken as a message.

**Could do:** quote the restaurant's real availability for a given party size on
a given date, and take a reservation the floor sees immediately.
**Could not do:** move or cancel one; hold a table while the caller decides
(there is no lock — see below); read the restaurant's rooms or tables; put
somebody on a real waitlist; rely on an idempotency key.
**Unverified, and marked so in the source:** the exact JSON:API envelope of
`GET /partners/v2/availability` and how the restaurant is identified on it. The
`time_slots` field name and the 30-minute example values are Eat App's own, but
the surrounding shape was not confirmed against a live sandbox. `slotsIn`
accepts only shapes it recognises and yields nothing for anything else.

**Apply for:** a partner onboarding conversation. Their become-a-partner page
books a 30-minute call, and their integrations page says plainly to reach out
for API access. `info@eatapp.co` for partnerships, `support@eatapp.co` for the
technical side.

## Booksy — the API exists and is behind a 401

Booksy's own documentation host, `docs.booksy.com`, and its sibling
`alpha.docs.booksy.net` resolve and answer **401 Unauthorized**. That is the
strongest evidence available that a partner API exists, and no help at all in
writing against it. Everything else is absent: `developers.booksy.com` and
`api.booksy.com` resolve only to redirect to the consumer marketplace,
`booksy.com/en-us/partners` is a 404, and nothing on booksy.com, biz.booksy.com
or their help centre mentions an API, a programme, a form or a developer
address.

The difference from Fresha is worth keeping: Fresha has no API, so the ask is
"would you build one". Booksy has one, so the ask is concrete and much smaller —
provision a documentation account.

Every named Booksy integration (Reserve with Google, Google AI Mode, Instagram,
Facebook, Yelp) is one Booksy built and announced itself, and there is no
third-party app marketplace. That pattern suggests access goes to partners
Booksy chose rather than to applicants.

**A trap, recorded so nobody re-finds it cold.** Precisely because the real
reference is gated, third-party API directories publish confident
reconstructions of it — a country-prefixed public API base URL, an RS256
partner-keypair flow exchanged for a short-lived token, exact rate limits. Their
authors could not open that page either. `check:booksy` keeps the warning alive
in `booksy.ts` and in Booksy's registry entry, and fails if any of it appears
anywhere else.

**Apply for:** nothing published. It is a cold commercial approach through their
general contact or support channels, and it may not be answered.

## Vagaro — the documentation opens, and has no booking in it

The only refusal here that is not about access. `docs.vagaro.com` is Vagaro's
own developer site and it opens to anyone. The reason there is no adapter is
that what is documented cannot take a booking.

Vagaro's API introduction names five capability areas — Employee Management,
Locations, Appointments, Customers, Employees — and describes them in read
terms: an appointment can be *retrieved*, with its status, start time and who is
providing the service. There is no availability search, and no documented
endpoint to create, move or cancel an appointment. The pages that would carry
the reference are unfilled template stubs, concrete slugs 404, and no base URL
is published. `developers.vagaro.com` and `sandbox.vagaro.com` do not resolve.

What *is* well documented is the webhook side: Appointment, Customer,
FormResponse, Transaction, location and Employee events, an envelope of `id`,
`createdDate`, `type`, `action`, `payload`, and a delivery contract of HTTPS
POST, 2xx within twenty seconds, five retries over fifteen minutes with
exponential backoff. That is a real integration surface — for knowing what has
already happened. A receptionist needs to know what is free on Tuesday.

**The commercial gate is the part to know before spending a call.** Access goes
through Enterprise Sales, and Vagaro's support material conditions it on the
merchant being a paid, non-trial account **actively using Vagaro's own credit
card processing**. That is not a hurdle Belline clears once; it lands on every
salon we would want to connect, and will disqualify some outright.

Not to be confused: the "Vagaro Marketplace" is the consumer directory where
clients find businesses, not a developer app store. Several third-party
write-ups treat it as one.

**Apply for:** the Enterprise Sales form linked from Vagaro's APIs and Webhooks
page, with one question — is there an unpublished endpoint that reads
availability and writes an appointment? If not, Vagaro belongs on the reporting
roadmap and should come off the booking one.

## Doctolib — the obstacle is the health-data question

Needed for the German-speaking clinic launch, and the hardest door on the list.
`developers.doctolib.com` resolves and answers 401; `developers.doctolib.fr`
does not exist; `doctolib.de/api` and `doctolib.fr/api` are 404;
`partners.doctolib.fr` redirects to the consumer site; and
`partnerportal.doctolib.com` is a Salesforce login wall that asks for a company
custom domain, so it is reachable only once a commercial relationship exists. No
reference, no base URL, no auth model, no sandbox.

The partner routes are all lead-capture forms, and their shape says who Doctolib
integrates with. The German one is framed around partner discounts — a reseller
channel. The French taxonomy lists télésecrétariat, IT consultants, equipment
makers and distributors, training bodies and "other": no category for a software
vendor, and none a voice agent fits. Doctolib Connect exposes a SCIM API, which
provisions users and has nothing to do with appointments.

Every integration Doctolib names publicly is with a practice-management software
vendor — PRO MEDISOFT, zollsoft's tomedo — and every one runs the *other*
direction: Doctolib's calendar syncing into the practice's own software to stop
double entry. That is the detail most likely to be misread as evidence that a
booking API exists.

**And the real obstacle is not the API.** Appointment data at a clinic is health
data. Doctolib holds HDS certification in France — the regulated regime for
hosting health data — and its public position is that patient data is reachable
only by authorised healthcare providers. Germany adds medical confidentiality
under §203 StGB on top of GDPR Article 9. A voice agent booking on a patient's
behalf is a non-clinical third party handling regulated health data, and that is
an argument to have with lawyers before it is one to have with an API team.

Doctolib does not publish a prohibition on third-party booking. It does not
address it at all — and reading permission into that silence would be the wrong
call. **Absence of a refusal is not consent.**

**Apply for:** the German partnership form at
<https://info.doctolib.de/commercial-partnerships/>, or the French one, expecting
a commercial-reseller conversation. It is worth one email to learn whether an ISV
route exists that their published taxonomies do not mention.

**Plan for Doctolib not being connected** — not "not yet", not connected. A
clinic on Doctolib is one where Belline answers, takes the request, and the
practice confirms. That is a product to design deliberately, not a gap to leave
open while an application is pending, because there is no application to be
pending.

## SimplyBook.me — open, complete, and priced for the customers we have

The second partner on the whole list with no gatekeeper, and the first whose
commercial shape suits a small Gulf salon rather than an enterprise. All four
operations are documented, so it joins Microsoft Bookings and Cal.com as an
adapter that could work the day a venue hands over a key.

### Which API is current, because this is the question that misleads everyone

SimplyBook has **two live APIs and neither is marked deprecated**, and the older
one is the one every third-party guide describes.

- **REST v2 — current, and what we built against.** SimplyBook publishes
  OpenAPI 3.0 documents at `https://simplybook.me/api/swagger-admin` and
  `.../swagger-public`, readable by anyone. The admin document alone carries 78
  paths.
- **JSON-RPC 2.0 — legacy, still answering** at `user-api.simplybook.me`, with
  `getToken`, `getStartTimeMatrix` and `book`. It works, and choosing it would
  have cost us two of the four operations: its public service has **no
  reschedule at all**, and cancelling needs an
  `md5(bookingId . bookingHash . secretKey)` signature computed from a hash
  returned by the original booking.

```
POST   /admin/auth                       company + login + API user key
POST   /admin/auth/refresh-token
GET    /admin/schedule/available-slots   service_id, provider_id, date, count
GET    /admin/services                   the duration, so none is invented
POST   /admin/bookings
PUT    /admin/bookings/{id}              a real move, not cancel-and-rebook
DELETE /admin/bookings/{id}
```

### The credential, and the two traps in it

`POST /admin/auth` takes `{company, login, password}` and the spec says
`password` may be **either the user's real password or an API User Key** the
business generates under Settings → API User Keys. Belline takes the key and
never a password: those keys exist so a business can issue "separate keys per
application", they can be revoked on their own, and they do not break when
somebody changes their password. `check:simplybook` asserts the `api_user_key_`
shape, because a pasted password would otherwise *work* — and that is the only
moment anybody would notice.

**Trap one: thirteen regional hosts.** `user-api-v2.simplybook.me` is the global
default, and `simplybook.it`, `.asia`, `.us`, `.pro`, `.cc`, `.vip`,
`enterpriseappointments.com` and further white-label hosts all exist. A company
lives on exactly one, and the wrong host does not fail as a wrong host — it
answers that the company does not exist. So the host is recorded on the venue
and a venue without one is **not connected**, rather than tried against a
default that would be wrong for most of the world while looking like a broken
salon.

**Trap two: two-factor authentication.** With 2FA on the API user, `POST
/admin/auth` returns `require2fa` and *empty* tokens. There is no unattended
path past it, so Belline says "not connected" in words a person can act on and
does not retry. The check pins that it is attempted exactly once.

**Could do:** quote the company's own bookable times, take a booking, move one,
cancel one, ask for a particular provider, read the services and providers.
**Could not do:** book without knowing both the service and the provider; hold a
slot while a caller decides; rely on SimplyBook to deduplicate a retried create
(there is no idempotency key); connect a company with 2FA on its API user.
**Unverified, and marked so in the source:** the rate limits (neither OpenAPI
document nor the help centre publishes a number, and the "5,000 a day, five a
second" figures third-party guides quote appear on no SimplyBook page); the
v2 access token's lifetime; and that the API feature is selectable on the Free
plan *specifically* — no page states a restriction and their own subscription
calculator implies none, but the definitive matrix is behind a login.

**Apply for:** nothing. The work is the venue's: enable the API custom feature,
mint an API User Key, turn 2FA off for that user, and tell us the host.

## Restaurants are not salons with tables

OpenTable, SevenRooms and Eat App are not appointment systems, and forcing them
into that shape is the mistake this section exists to prevent.

- **Party size is the question, not a detail.** "Is 19:00 free?" has no answer.
  19:00 for two and 19:00 for six are different questions.
- **The room is the resource.** A floor plan of tables with capacities and
  joining rules, solved across the whole evening. There is no per-person calendar.
- **The house sets the length**, by party size, not the guest by choosing a
  service.
- **Shifts and sittings.** Lunch, dinner, first and second sitting, each with its
  own hours, pacing and menus. SevenRooms availability is shift-level.
- **Pacing.** An empty table is not always bookable: the kitchen caps covers per
  fifteen minutes.
- **Nobody asks for a waiter.** The staff dimension a salon integration is mostly
  about does not exist.
- **Slot locks.** Read availability, lock a slot while the guest finishes talking,
  then confirm. Availability tokens go stale and must not be cached.
- **The waitlist is a live queue** with a quoted wait, not "let me know if
  something frees up".

Belline's own restaurant engine already models tables, sittings and turn times
(`src/lib/booking/restaurant.ts`), so none of this is foreign — but a partner
reservation adapter must take `partySize` as required, must not invent a
duration and must not offer a person.

### One correction, from the first restaurant API we could actually read

This note used to end "…and must expect a two-phase hold". Eat App is the first
restaurant system on the list whose API is published, and it **has no slot lock
at all**. The only concurrency protection documented anywhere is the
`idempotency_token` on the Concierge API, which is the grant a booking channel
does not get.

So a hold is something to *check for* per partner, not something to assume.
OpenTable describes locking a slot during checkout and SevenRooms is reported to
do the same; Eat App does not. Where there is no hold, the table may be gone
between quoting a time and writing the reservation, the caller is told at the
time, and nothing is pre-announced. For a voice agent — where the caller is
still talking while the slot ages — that is a real limitation and belongs in the
conversation design, not only in a footnote.

## Why the later seven are not on the website

Microsoft Bookings, Cal.com, Eat App, Booksy, Vagaro, Doctolib and
SimplyBook.me are **not in `INTEGRATIONS`** in
`scripts/site-integrations.ts`, so they do not appear on the landing page in any
state — not even "On our roadmap".

Two reasons, and both are the founder's call to reverse:

1. **The strip needs an icon per name.** Every entry carries a self-hosted PNG in
   `public/img/logos`, and `check:webchat` asserts the file exists and that no
   logo is loaded from anyone else's domain. Those six files do not exist, and
   inventing a company's mark is worse than leaving it off.
2. **Which partners to list is a positioning decision, not a build one.** The
   existing six were put on the strip at the founder's request on 2026-09-16.
   Adding Booksy, Vagaro and Doctolib would advertise three doors we have found
   closed; adding Cal.com or SimplyBook.me would advertise the two things on
   the list that already work, which may be exactly right — but
   it is a decision, not a default.

Each new provider's own check asserts it is absent from the strip, and
`check:msbookings`, `check:calcom` and `check:simplybook` additionally prove the honesty gate would hold if it were added: flag on, key
set, stubs on — still "On our roadmap".

One caveat the founder should know before adding Cal.com or SimplyBook.me. For
a partner whose credentials belong to the **venue** rather than to Belline —
Cal.com, Zenoti and now SimplyBook.me — `liveNeeds` is empty, so nothing is
waiting on a partner's approval, and setting `PARTNER_<ID>_ENV=live` on a
deployment is enough to turn the tag to "Available". For Mindbody the gate is
Mindbody's own decision, because `liveNeeds` holds the credentials that approval
issues. Both behaviours are deliberate (`contract.ts`), but they are not equally
strong, and the weaker one is a human act rather than a partner's.

## How it is built

| File | What it is |
| --- | --- |
| `src/lib/integrations/partners/registry.ts` | The research above, as data: what each API offers, what gates it, what it cannot do. |
| `src/lib/integrations/partners/contract.ts` | What Belline needs from a partner, and the off/sandbox/live modes. |
| `src/lib/integrations/partners/<id>.ts` | One adapter per partner. Six are real clients (Zenoti, Mindbody, Microsoft Bookings, Cal.com, Eat App, SimplyBook.me); seven are documented refusals. |
| `src/lib/integrations/partners/sandbox.ts` | A partner that exists only in this process, for the checks to drive. |
| `src/lib/integrations/partners/closed.ts` | The shared shape for a partner with no reachable API. |
| `src/lib/booking/partner-provider.ts` | The booking destination: ask the partner, never guess, never fall through to Belline's diary. |

Flags follow the existing shape: `booking.partner.<id>` needs
`PARTNER_<ID>_API_KEY` **and** an explicit `FLAG_BOOKING_PARTNER_<ID>=on`
(`src/lib/flags.ts`). `PARTNER_<ID>_ENV=live` plus that partner's production
credentials is what makes it live rather than sandbox — and only live may ever
change what the website says.

Two fields on `PartnerVenueLink` exist for partners whose host or clock is not a
constant. `timeZone`, because Cal.com books an exact instant rather than a wall
time. And `baseUrl`, for the two partners whose host belongs to the venue —
Cal.com because it can be self-hosted, and SimplyBook.me because it runs
thirteen regional hosts and a company is on exactly one.

Checks: `check:partners` (the shared contract) plus `check:fresha`,
`check:zenoti`, `check:mindbody`, `check:treatwell`, `check:opentable`,
`check:sevenrooms`, `check:msbookings`, `check:calcom`, `check:eatapp`,
`check:booksy`, `check:vagaro`, `check:doctolib` and `check:simplybook`. All are
in `check:all`, and every one blocks outbound fetches for the whole run.
