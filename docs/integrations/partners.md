# Partner booking systems

What Belline can and cannot do through each booking system on the website's
integrations strip, researched from the partners' own documentation on
**18 September 2026**, and what the founder would have to apply for.

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

Priority follows what our customers use: Fresha and Zenoti (Gulf salons and
clinics), then Mindbody, then Treatwell, then the restaurant two. Note the
unhappy shape of that list — **the partner most asked for is the one with
nothing to build against.**

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

## Restaurants are not salons with tables

OpenTable and SevenRooms are not appointment systems, and forcing them into that
shape is the mistake this section exists to prevent.

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
duration, must not offer a person, and must expect a two-phase hold.

## How it is built

| File | What it is |
| --- | --- |
| `src/lib/integrations/partners/registry.ts` | The research above, as data: what each API offers, what gates it, what it cannot do. |
| `src/lib/integrations/partners/contract.ts` | What Belline needs from a partner, and the off/sandbox/live modes. |
| `src/lib/integrations/partners/<id>.ts` | One adapter per partner. Two are real clients; four are documented refusals. |
| `src/lib/integrations/partners/sandbox.ts` | A partner that exists only in this process, for the checks to drive. |
| `src/lib/integrations/partners/closed.ts` | The shared shape for a partner with no reachable API. |
| `src/lib/booking/partner-provider.ts` | The booking destination: ask the partner, never guess, never fall through to Belline's diary. |

Flags follow the existing shape: `booking.partner.<id>` needs
`PARTNER_<ID>_API_KEY` **and** an explicit `FLAG_BOOKING_PARTNER_<ID>=on`
(`src/lib/flags.ts`). `PARTNER_<ID>_ENV=live` plus that partner's production
credentials is what makes it live rather than sandbox — and only live may ever
change what the website says.

Checks: `check:partners` (the shared contract) plus `check:fresha`,
`check:zenoti`, `check:mindbody`, `check:treatwell`, `check:opentable` and
`check:sevenrooms`. All are in `check:all`, and every one blocks outbound fetches
for the whole run.
