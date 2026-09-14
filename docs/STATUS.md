# Belline — status against the directives

Rewritten 11 September 2026. Honest rather than flattering: the point of this
document is to be usable for planning, and a status report that overstates
progress is worse than none.

Three states are used throughout:

- **Live** — running in production, and I have verified it from outside.
- **Built** — written, tested, committed; not yet confirmed in production.
- **Not started** — nothing exists.

---

## The one-paragraph version

Belline is a working voice agent with a deterministic booking engine, a real
phone number, an eight-page marketing site with four vertical pages, a
personalised-demo generator, a versioned Business Brain, an Action Inbox, a
diary you can work in, a waitlist that converts, and one-way Google Calendar
sync. 620 unit tests across 28 suites and 48 rendered-browser checks pass. What is still
missing is the commercial machinery — billing, CRM, multi-tenancy worth the
name, observability — and the four partner-gated integrations, which are
blocked on contracts rather than engineering. Roughly 45% of the two
directives is built, up from 15% a day ago.

---

## Deployment

| Target | What runs there | State |
|---|---|---|
| **Railway** — `app.belline.ai` | The app: custom Node server, websockets, Twilio media streams | **Live** |
| **Vercel** — `belline.ai`, `www` | The static marketing site | **Live** |
| **Twilio** — +1 (571) 778-5920 | The inbound number | **Live** |

Netlify is gone — its free build credits ran out mid-project and paused
production deploys, which cost most of an afternoon before I found the banner
saying so. The Railway trial caps custom domains at one, which is why the
split exists.

### Two failure modes worth remembering

**UTF-8 BOM in `package.json`.** PowerShell's `Set-Content -Encoding utf8`
writes a BOM. `tsc`, the tests and the site build all stayed green while every
Railway deploy failed. Always:
`[IO.File]::WriteAllText(path, text, (New-Object System.Text.UTF8Encoding $false))`.

**The `build-site.ts` asset regex.** It has silently shipped a broken site
three times — once missing `img/`, once `css|js`, once `json`. If an asset type
is new, the regex needs it.

---

## Directive 1 — website and design

| # | Item | State | Note |
|---|---|---|---|
| 1–4 | Brand system, creative direction, no AI slop | **Live** | Navy/gold, Manrope, one light world. The page is structured as a single call from 19:47 to 19:49 — the timestamps carry the claim rather than decorate it. |
| 5 | Tooling: Playwright, axe-core, breakpoints | **Live** | `npm run audit` — 8 pages × 5 widths (390/768/1280/1440/1728) plus WCAG 2.2 AA. 48 checks, all green. Waits on fonts and layout rather than `networkidle`, which was flaking under parallel workers on pages that preload 28 audio clips. |
| 5 | Lighthouse | **Not started** | Still not measured. |
| 5 | Figma MCP, Sentry | **Not started** | Design lives in code; no error monitoring. |
| 6 | Specialist agents | **Not started** | I have done these roles inline rather than as configured subagents. |
| 7 | Project design skill | **Not started** | |
| 8 | Audit before redesign | **Live** | Done, and the findings drove the fixes. |
| 9 | Competitive research | **Live** | `market.html`. |
| 10 | Homepage: understand in 5s, then proof | **Live** | "Someone always answers." beside a call that plays out, with the real number in the caller frame. |
| 11 | Narrative arc | **Live** | Problem → answer → decide → check → write to book. |
| 12 | Visual storytelling | **Live** | Your five illustrations, compressed 9.6 MB → 594 KB. |
| 13 | Motion | **Live** | The waveform moves only while Belline is actually speaking — it reports state. Respects `prefers-reduced-motion`. |
| 14 | Microinteractions | **Partial** | Hover/focus/pressed done. No skeletons or toasts. |
| 15 | Copy | **Live** | No "revolutionary", no invented statistics. |
| 16 | Industry personalisation | **Live** | `/dental`, `/clinics`, `/salons`, `/restaurants` — each with its own constraints and its own refusal, not a swapped photo. |
| 17 | Trust | **Partial** | The refusal is on the page. No security page, no data-handling statement. |
| 18 | Mobile designed independently | **Partial** | Verified at 390px, no overflow, real tap targets. Not separately *designed*. |
| 19 | **Dashboard as product** | **Built** | Rewritten today — see below. |
| 20 | Design system | **Live** | `site.css` + `site.js`, one source for the whole site. |
| 21 | Screenshot → critique → improve loop | **Partial** | The harness exists and I use it on every UI change. Not run as a scored adversarial loop. |
| 22 | Quality gates | **Partial** | Green: no console errors, no overflow, WCAG AA, OG/Twitter/canonical, favicon, share image. Missing: 404 page, analytics, structured data. |
| 23 | Details | **Partial** | Favicon, titles, OG, `tel:` links. No 404/500 page, no legal pages. |
| 24 | Don't rewrite good tech | **Live** | Architecture untouched. |
| — | Voice on the site | **Live** | 28 clips rendered at build time, playback driving the transcript so the words cannot drift from the audio. |

### The dashboard home (19, 20, 21 of directive 2)

It used to open with calls, containment rate and p50 latency — all true,
measurable, and none of them the question an owner opens the app to ask. It
now answers *what did Belline do for me* in one sentence, then the outcomes
behind it, then anything broken, then what needs a person. Specifics worth
recording because they were deliberate:

- **Money only ever comes from the venue's own number.** No average booking
  value entered means no estimate at all — `null`, not `0`. "No estimate" and
  "worth nothing" are different, and showing £0 to a venue that has simply not
  filled in the field is worse than showing nothing.
- **After-hours is computed in the venue's timezone**, out of
  `Intl.DateTimeFormat.formatToParts` rather than parsed back out of a
  formatted string — the formatted shape changes with locale, the parts do not.
- **A run of hang-ups is now flagged.** The health panel would previously have
  reported everything green while four of the last seven callers rang off
  part-way through, which is exactly the silent failure it exists to catch.
  Judged over the last 20 calls with a floor of 5, because a venue taking four
  calls a day has no signal in a single day.
- **"5 things need you", not "5 calls".** A freed slot with somebody waiting
  for it has no call attached. The banner names the venue, because the sidebar
  badge counts every venue the user can see and the same words were carrying
  two different numbers on one screen.

---

## Directive 2 — product and business

### Built or live

| # | Item | State | Note |
|---|---|---|---|
| 4 | ANSWER / ACT / ASK / ESCALATE | **Live** | ESCALATE is deterministic and runs *before* the model — a model never asked cannot be talked round. 26 tests, half of them false-positive cases on purpose. |
| 5 | Call experience | **Live** | Barge-in with generation fencing, phone-tuned endpointing, cached greeting, per-venue speaking pace. |
| 5 | **Spoken-language layer** | **Live** | Reasoning separated from speaking: the model decides what to say, then `toSpoken()` rewrites it for the mouth — money, clock times, references and phone numbers spoken as people say them, pace dropping from 1.06 to 0.92 on anything a caller has to write down. 25 tests. |
| 5 | **Speculative generation** | **Live** | Read-only turns start generating on the interim transcript and are adopted if the final matches. Measured: 2057ms → 1497ms. |
| 8 | **Business Brain** | **Built** | Structured, versioned, diffable, revertible. Every published version records who changed what. 13 tests. |
| 11 | Restaurant intelligence | **Live** | Turn times by party size, tightest-fit tables, same-section combinations, kitchen pacing, last seating. |
| 12 | Clinic and dental intelligence | **Live** | Practitioners, surgeries and rooms as separate constraints; first visit books as consultation. |
| 13 | Salon intelligence | **Live** | Qualified staff, service chains, shared stations, cleanup buffer held but not quoted. |
| 14 | Scheduling engine | **Live** | Deterministic. The model interprets intent; it never invents availability. 28 tests. |
| 15 | **Booking idempotency** | **Built** | The key is derived from what the booking *is*, not from the request — so a retried webhook and a caller who rang twice both collapse to one booking. 12 tests. |
| 16 | **Waitlist** | **Built** | Joins, matches against freed slots, 30-minute offer hold, releases stale offers, tracks conversion. Matches surface at the top of the Action Inbox because they go cold fast. 15 tests. |
| 18 | Call inbox | **Live** | Calls list with transcripts and tool calls. |
| 19 | **Action Inbox** | **Built** | Derived, not stored — a call that was mishandled cannot quietly fail to raise a flag, and a new rule applies to history immediately. 13 tests. |
| 20/21 | **Home and value dashboard** | **Built** | Above. 15 tests. |
| 24 | Test lab | **Live** | Talk or type, with every tool call and its result on screen. |
| 26 | Versioning and rollback | **Built** | Part of the Business Brain. |
| 27 | **Google Calendar** | **Built** | One-way. Belline stays in charge of availability because it knows things a calendar cannot — who is qualified, what the kitchen can take at eight, that the chair is held ten minutes after the guest leaves. **Needs credentials to go live — see below.** |
| — | **The calendar** | **Built** | Day and week views, drag-to-move, quick-book that refuses with alternatives rather than failing, buffers drawn as held-but-not-quoted. 11 tests. |
| 41 | Personalised demo generator | **Live** | Paste a URL, get a link that answers as their business. 6.2s measured end to end. 22 tests, mostly SSRF refusals. |
| 66 | Vertical starter packs | **Live** | Three seeded fixtures acting as templates. |

### Partial

| # | Item | What is missing |
|---|---|---|
| 6 | Human handoff | Transfers work. No warm handoff — the human still gets no context. |
| 10 | Customer recognition | Returning callers recognised by number. No profile depth. |
| 29 | Multi-location | Venue scoping and a location switcher. No org-level rollup. |
| 30 | Roles and permissions | owner/manager/staff with venue scoping. No custom roles, no MFA, no SSO. |
| 31 | Security | scrypt, server sessions, signed stream tokens, login throttling, SSRF defence resolved through DNS rather than hostname strings. No encryption at rest, no audit log, no retention policy. |
| 32 | Recording and consent | Transcript-only by default, demo disclosure in the greeting. No configurable policy. |
| 40 | Live website demo | Recorded audio on the site; the personalised-demo page takes a live microphone call behind a signed token. Not yet on the marketing homepage. |

### Not started

Knowledge extraction workflow (9) · SMS/messaging (17) · quality score (22) ·
continuous improvement loop (23) · regression testing per account (25) · API
and webhooks (28) · reliability and failover (33) · observability (34) ·
internal ops console (35) · onboarding flow (36) · white-glove checklist (37) ·
first-7-days report (38) · demo scheduler (44) · pre-demo brief (45) · sales
CRM (47) · outbound sequences (48–51) · speed to lead (52) · follow-up (53) ·
trials (54) · land and expand (55) · referrals (56) · reviews (57) · case
studies (58) · partners (59) · pricing (60) · billing (61) · customer success
(62) · churn prevention (63) · data flywheel (65) · provider abstraction (67) ·
cost control (68) · feature flags (69) · executive dashboard (74) · sales
analytics (75) · website analytics (76) · SEO (77)

---

## Commercial build-out — `docs/strategy/belline-claude-code-prompt.md`

Worked phase by phase against `docs/strategy/belline-commercial-strategy-2026-09-14.md`. Committed per phase, not deployed.

### Phase 1 — cost metering per channel (14 September 2026)

| Item | State | Note |
|---|---|---|
| Rate card | **Built** | `src/lib/billing/cost.ts`, dated 2026-09-14, one line per vendor rate with its source. Every line overridable as `RATE_<KEY>` in the environment. 5 of 34 lines are marked unverified (see below). |
| Cost events | **Built** | Reported where the money is spent: the voice session at call end (Twilio line + Media Streams on phone, Deepgram on every voice call), the speech provider per synthesised request (characters × credits × plan), the model loop after every Anthropic response including speculative guesses (input, output, cache read, cache write), both WhatsApp adapters per message sent, the web-chat voice-note route (Deepgram pre-recorded), and the boot-time greeting warm-up. Batched for one second and written to `data/costs.json` through `store.ts` (`appendCosts` / `listCosts`). |
| Roll-ups | **Built** | `costOfCall`, `costOfConversation`, `costPerVenuePeriod`, and `unitCosts()` — USD per phone minute, per web-voice minute, per chat conversation, per WhatsApp conversation, each with its sample size. |
| Client book and projection | **Built** | `VENDOR_COST_PER_MINUTE_FILS` is gone. `/sales/clients` costs the book at the measured phone minute once there are 50 calls and at the 40-fils planning figure until then, says which, and shows a "What a unit costs us" table with measured figure, samples and fallback state per channel. The projection's cost-per-minute default follows the same rule. |
| `check:cost` | **Built** | 17 cases. A synthetic 3-minute US phone call meters at $0.0626/min against the strategy doc's lean $0.063; an 8-turn Haiku chat at $0.0148 against $0.015. Also: UAE rate and env override, Twilio minute rounding, model not on the card, ElevenLabs model and plan, WhatsApp via Meta vs Twilio, the 50-sample switch-over, persistence. |

**Still needs a figure or a decision from you**

- **UAE line rate.** `TWILIO_INBOUND_AE` is the strategy doc's unverified $0.03–0.06 midpoint ($0.045). Set `RATE_TWILIO_INBOUND_AE` from the carrier's quote — it is the number that decides UAE phone margins.
- **ElevenLabs plan.** Priced as Scale unless `ELEVENLABS_PLAN` is set (`creator`, `pro`, `scale`, `business`). Set it to the plan you are actually on.
- **Unverified lines**: Deepgram pre-recorded ($0.0043/min — voice notes run on Deepgram, not Whisper as the prompt assumed), Twilio's WhatsApp fee ($0.005/message — the sandbox runs through Twilio; the doc assumes Meta direct), ElevenLabs Pro credit price, UAE number rental. Each says so on the card.
- Not metered yet: number rental (Phase 4 buys numbers), the outbound leg Twilio dials on a live transfer, and WhatsApp utility templates (nothing sends them today; the meter supports them). `costs.json` has no retention yet; at a few thousand calls a month it wants moving to Postgres with the rest of the store.

### Phase 2 — products, plans and entitlements per channel (14 September 2026)

| Item | State | Note |
|---|---|---|
| Catalogue | **Built, then simplified** | `src/lib/billing/plans.ts`: three plans — **Starter AED 299, Business AED 599, Pro AED 1,199** — each with every live channel (phone, website voice button, website chat; WhatsApp when it works), differing only in allowances. Prices as `Record<Market, minor units>` for AE, GB, AU, CA, US, SG, IE, NZ, CH. Annual is ten months for twelve. Nothing sellable is unlimited, and nothing is free. The strategy doc's single-channel modules and free chat were built first and removed the same day at your call ("too complicated"; "we can't have a free chat receptionist"). `src/lib/markets.ts` holds currency, formatting and a `live`/`not-yet` status per market (only AE is live). |
| Managed track | **Built, not public** | `professional` (AED 999) and `premium` (AED 1,999), plus white-glove setup (AED 750). All `not-yet` because they sell integrations, Arabic, multi-location and outbound calling. Not sellable, not rendered. |
| Grandfathering | **Built** | The old Starter/Business/Enterprise ladder is kept as `legacy` products. On the first boot of this code, every *active* venue on it is stamped `grandfatheredUntil` = that day + 90 (`billing/grandfather.ts`). It keeps exactly what it bought, including Enterprise's uncounted minutes. Afterwards it lapses as `legacy_plan_ended`, enforced only once Stripe is on. |
| Usage per channel | **Built** | `billing/usage.ts`: minutes for phone and the voice button (test console, demo lines and calls we broke excluded); conversations for chat and WhatsApp, meaning a thread with at least one Belline reply, 24 hours from that reply. Per-channel usage, projection and a `recommend()` that finds the cheapest move up. It never drops a channel they pay for, never shrinks one, never suggests the free chat, and never points downwards. The invoice is still the plan fee only. `MINUTE_DEFINITION` and `CONVERSATION_DEFINITION` are quoted verbatim on the site and the billing page. |
| Entitlements | **Built** | `serviceState(location, today, { channel })` gates the phone (Twilio route), the voice button (`checkEmbedGate` and `mayStreamTo`), chat (`chatGate`) and WhatsApp (`respondTo`, which the webhook calls). A missing channel is refused always; lapsing is enforced only with Stripe on; a paid allowance never stops service. |
| Trial | **Built** | 14 days, 60 phone minutes, every channel on, no card (decision confirmed). Signup no longer goes to Stripe. What was picked on `/checkout` is remembered on the trial. |
| Free chat | **Removed** | Built, then removed at your call: no free tier, no badge, no upsell. The 14-day card-free trial is the only way to use Belline without paying. |
| Stripe | **Built** | One price per product × market × cycle, found by a lookup key carrying the amount; a subscription is one line per product. Stripe Tax on (`STRIPE_TAX=off` for an account without tax settings); prices are tax-exclusive. The webhook maps `belline_products` back through `checkSelection` and ignores anything that is not a sellable plan; an old-ladder session paid after the switch is honoured and grandfathered. |
| Checkout and billing | **Built** | `/checkout`: the three plans as one choice, what the chosen plan includes, a live total in the venue's currency, and the choice mirrored into the URL. `/billing`: one usage bar per channel, the plan and price, both definitions, and a change-plan link. The website cards show each plan's allowances and "Everything in Starter" plus what it adds. |
| Website pricing | **Built** | `scripts/site-pricing.ts` renders the pricing section, the ROI plan list and the structured-data offers from `plans.ts` between markers in `public/landing.html` (`npm run pricing`; `npm run site` re-applies it). Every market renders and is pinned by `check:billing`; only live markets are published. A second live market gets a picker automatically. Terms updated for the new trial and allowances. |
| Belle's knowledge | **Built** | The price and trial FAQs are generated from the catalogue at boot (`billing/speak.ts`, in words). Only live channels are named. |
| `check:plans` | **Built** | 29 cases, covering doc prices and allowances per market, provisional marking, ladder ordering, annual maths, the managed track hidden, WhatsApp unsold, free-chat limits, selection rules and upgrade rules. Unit costs rebuilt from the rate card land within 7% of §1.3 on both bases. Prints the margin table and enforces 30% (bundle) / 45% (module) at typical use. |

**Margins at typical use (both enforced):**
- **Lean basis, every market:** see the table `npm run check:plans` prints; every plan clears 30%.
- **UAE-line basis, UAE only:** Starter, Business and Pro all land around 44–48%, against a 30% floor.

**UAE pricing decision (14 September 2026):** three all-in plans at AED 299 / 599 / 1,199. This replaced the modules and the free chat. The UAE-line margin leaves room for a launch offer or the annual discount. Other markets are priced but closed; they are planned for 2–3 months after the UAE launch.

**Still needs a figure or a decision from you**

- **Provisional prices for the later markets** (marked `provisional` in `plans.ts`, not public while those markets are closed). To be decided before each market opens:

  | | GB | AU | CA | US | SG | IE | NZ | CH |
  |---|---|---|---|---|---|---|---|---|
  | Starter / Business / Pro | £65/129/259 | A$119/239/479 | C$109/219/429 | $79/155/309 | S$109/219/429 | €69/139/289 | NZ$129/269/539 | CHF 299/599/1,099 |

- **The UAE-line margins still rest on three estimated rates:** `TWILIO_INBOUND_AE`, `TWILIO_NUMBER_AE` and `ELEVENLABS_CREDIT_PRO`. Set the real figures as `RATE_*` in Railway once there is a carrier quote. `check:plans` then re-checks the UAE prices against them. The biggest single cost is the $15 a month UAE number.
- **Stripe dashboard:**
  - Enter the head-office address and tax registrations before Stripe Tax can run.
  - Turn off plan switching in the customer portal: `customer.subscription.updated` is not mapped, so plan changes have to go through `/checkout`.
- **WhatsApp module** stays `not-yet` until the Meta account exists (the gap is recorded in `plans.ts`).
- **Belle quotes UAE prices** until Phase 4 gives her the caller's market.

### Demo link, sales Belle, AI onboarding, dashboard upgrade (14 September 2026)

Built from `docs/strategy/belline-next-prompt.md` phases A–C, plus the dashboard gaps found in an audit. Not deployed.

| Item | State | Note |
|---|---|---|
| Demo link (test) | **Built** | Every prospect demo now carries its own website widget (chat + voice, capped: 30 chats, 16 messages, 20 calls a day, on us). `/demo/<slug>` shows the chat beside the call, with "Start 14 days free" and "Talk to a person". Old demos get the widget on first view. Outreach still sends the recorded demo; switching the email CTA to this link is the next step. |
| Belle sells | **Built** | On Belline's own venue only: `record_lead` (into /sales/enquiries, source `belle:<channel>`), `quote` (plans from the catalogue; discounts, contracts and guarantees refused in code and flagged), `build_demo` (their own demo from their website, 2 per conversation), `start_trial` (address must be read back; one-time 24h sign-in link sent by email only, hello@ notified), `send_checkout` (link by email). New sales persona: demo → trial → checkout → call; discloses AI; sells on specifics, never names competitors; not-yet list generated from the catalogue. `check:belle-sales` (15). |
| Sign-in links | **Built** | `signLoginToken` / `consumeLoginToken`: single use, latest only, 24 hours; `/api/auth/magic`. |
| Setup with Belle | **Built** | `/setup/assistant`: the owner answers in their own words; tools set hours, add/remove services, add staff, address, transfer number, FAQs, rules — each through `validateVenue`, published as a version "Set up with Belle: …", warnings asked back. Linked from setup, the dashboard home and Go live. Needs `ANTHROPIC_API_KEY` (says so without it). |
| Forwarding (UAE) | **Built** | Go live shows du and e& mobile codes with the venue's number, landline instructions (du 155, e& 101) and a PBX note, from `src/lib/telephony/forwarding.ts`. |
| Widget install | **Built** | "Check my site" on Your website: detects Squarespace, Wix, WordPress, Shopify, Webflow, GoDaddy or custom from the page, shows that builder's steps, and confirms the venue's own key is live. `check:onboarding` (19). |
| Locations | **Built** | `/locations`: owners add a location (own trial, baseline version), managers edit name, address, phone, timezone, currency, opening hours and closure dates; owners archive (kept, hidden everywhere, restorable; never the last active one) and delete only an archived location with no bookings or calls, after typing its name. |
| Calendar | **Upgraded** | Click a booking to open a side panel: details, arrived / undo, no-show, edit (date, time, person, several services, guest name/phone/email, notes) and cancel with an in-panel confirmation. "+ New booking" from anywhere, and a date picker. The booking form: returning guests suggested as you type (with their usual and notes), several services with total length and price, email, "Anyone free", and free times as buttons when a slot is taken. `check:backend` (14). |

| Week view and staff filter | **Built** | Calendar Day / Week switch, "Everyone" or one person's diary, and a date picker, all in the address so a view can be bookmarked. The week grid shows every booking at its real time, coloured by person; click one to open it, click empty time to book, click a day to open it. |
| Customer profiles | **Built** | "Guests" is now Customers: search by name, number or email; each customer opens a profile with visits, last visit, spend, cancellations, no-shows, upcoming and past bookings, calls and chats from their number, and notes. Name and email can be corrected, and the change reaches every booking under that number. |
| Search (Ctrl+K) | **Built** | One box for bookings (by reference, name or number), customers, locations and pages, limited to the venues and pages that person may open. Enter opens the booking straight into its calendar panel. |
| Live updates | **Built** | The dashboard checks every 10 seconds (while the tab is visible) whether bookings or calls changed and re-renders in place. A booking Belle took shows a notice with an Open link. |
| Dashboard browser tests | **Built** | `npm run test:dashboard` starts the app against a throwaway data folder with no database, model or email keys, creates the owner through first-run setup, and clicks through overview, the booking form, the week view, locations, customers and Ctrl+K search, failing on any console error. 6 tests. `check:dashboard` (10) covers search permissions, profiles and live updates. |

| Restaurant floor plan | **Built** | `/floor` (restaurants only): every table on a plan, coloured by what is happening now — free, booked soon, due, running late, arrived, seated, blocked. Click a table for the party, notes and next booking, and mark arrived / seat / left / no-show in one tap; a Walk-in button opens the booking form. "Arrange tables" lets managers drag tables into place and save (positions live on `Table.layout`, kept through every save of the room). `src/lib/floor.ts`, `/api/floor/layout`. |
| Reports and CSV export | **Built** | `/reports` (managers and owners): any date range with 7/30/90-day shortcuts. Bookings split Belle vs desk, covers or booked value, no-show rate, calls and chats with minutes and how they ended, new vs returning customers, busiest days and hours, services and team. Bookings, calls and customers download as CSV (spreadsheet-formula cells neutralised). `src/lib/reports.ts`, `/api/reports/export`. |
| Staff rota | **Built** | `/rota` (salons and clinics): people × the week, showing what each actually works. Click a day to set different hours, a day off, back to usual, or add/remove time off. The booking engine uses it immediately; bookings a change leaves outside someone's hours are listed with links to move them — nothing is moved automatically. `src/lib/rota.ts`, `/api/rota`. `check:ops` (13) covers all three; the dashboard browser tests now include floor, reports and rota (9). |

**Still open on the dashboard:** Arabic / right-to-left support.

---

## Two things only you can do

**1. Google Calendar credentials.** The integration is written and tested; it
cannot go live without them.

- console.cloud.google.com → new project → OAuth consent screen
- Enable the Google Calendar API
- Credentials → OAuth client ID → Web application
- Authorised redirect URI: `https://app.belline.ai/api/integrations/google`
- Scope: `https://www.googleapis.com/auth/calendar.events`
- Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` into Railway

**2. The partner programmes.** Fresha, SevenRooms, OpenTable and Treatwell
issue API credentials only under a signed agreement — there is no self-serve
route, and no amount of engineering changes that. You have said you will apply
once the platform is properly built. The honest read is that the platform is
now well past the bar those applications are judged against, and the
applications themselves run on someone else's timeline, so starting them is
the thing that shortens the path. The Integrations page says plainly that they
are not available rather than "coming soon", which is the half-truth an
operator discovers at the worst possible moment.

---

## What I would do next, in order

1. **Warm handoff (6).** The one place the product currently drops the thing
   it is best at: it knows exactly what the caller wanted and hands a human a
   ringing phone and nothing else.
2. **Onboarding flow (36).** Everything is built; there is no path from
   "signed up" to "taking calls" that does not involve me.
3. **Observability (34).** The health panel is the first honest instrument in
   the product. It should not be the only one.
4. **Billing (61).** Nothing can be sold until this exists.
5. **Live microphone demo on the marketing homepage (40).** The plumbing is
   already there behind the personalised-demo token.
