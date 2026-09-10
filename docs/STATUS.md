# Belline — status against the directives

Written 10 September 2026. Honest rather than flattering: the point of this
document is to be usable for planning, and a status report that overstates
progress is worse than none.

Three states are used throughout:

- **Live** — running in production, and I have verified it from outside.
- **Built** — written, tested, committed; not yet confirmed in production.
- **Not started** — nothing exists.

---

## The one-paragraph version

Belline today is a working voice agent with a real booking engine, a real
phone number, a four-page marketing site with four vertical pages, and a
personalised-demo generator. That is a credible product prototype and the
beginning of a sales motion. It is **not** the reception layer described in
the directives: there is no Business Brain as structured versioned data, no
Action Inbox, no integrations beyond the built-in diary, no billing, no CRM,
and no multi-tenancy worth the name. Roughly 15% of the two directives is
built. The 15% is the part that had to come first.

---

## Blocked right now

**Both deploy targets have stopped accepting deploys.** The code is fine — a
clean `git clone` followed by `npm ci && npm run site` produces all 8 pages
and 41 assets, and `next build` completes with every route present. But:

- **Railway** reports `Deploy failed` after 39 seconds, consistently, while
  continuing to serve the previous image. 39s is too fast to be a build.
- **Netlify** has not published since the vertical-pages commit; the audio
  files return 404 on belline.ai.

Both began failing at roughly the same time, which points at the accounts
rather than the code. The Railway trial showed *"30 days or $5.00 left"*
earlier in this project. **Two things to check in the dashboards:** Railway
billing, and the Netlify deploy log for the most recent commit. I cannot see
either from here.

Everything marked **Built** below is waiting on that.

---

## Directive 1 — website and design

| # | Item | State | Note |
|---|---|---|---|
| 1–4 | Brand system, creative direction, no AI slop | **Live** | Navy/gold, Manrope, single light world. The page is structured as one call from 19:47 to 19:49 — the timestamps encode the claim rather than decorate it. |
| 5 | Tooling: Playwright, axe-core, breakpoints | **Live** | `npm run audit` — 8 pages × 5 widths (390/768/1280/1440/1728) plus WCAG 2.2 AA. 48 checks. Found 6 real defects on first run. |
| 5 | Lighthouse | **Not started** | Not yet measured. |
| 5 | Figma MCP, Sentry | **Not started** | Design lives in code; no error monitoring. |
| 6 | Specialist agents | **Not started** | I have been doing these roles inline rather than as configured subagents. |
| 7 | Project design skill | **Not started** | |
| 8 | Audit before redesign | **Live** | Done, and the findings drove the fixes. |
| 9 | Competitive research | **Live** | Done earlier in the project (market.html). |
| 10 | Homepage: understand in 5s, then proof | **Live** | "Someone always answers." beside a call that plays out. |
| 11 | Narrative arc | **Live** | Problem → answer → decide → check → write to book. |
| 12 | Visual storytelling | **Live** | Your five illustrations, compressed 9.6 MB → 594 KB. |
| 13 | Motion | **Live** | The waveform moves only while Belline is actually speaking — it reports state. Respects `prefers-reduced-motion`. |
| 14 | Microinteractions | **Partial** | Hover/focus/pressed done. No skeletons, toasts or empty-state polish. |
| 15 | Copy | **Live** | No "revolutionary", no invented statistics. |
| 16 | Industry personalisation | **Live** | `/dental`, `/clinics`, `/salons`, `/restaurants`. Each has its own constraints and its own refusal, not a swapped photo. |
| 17 | Trust | **Partial** | The refusal is on the page. No security page, no data-handling statement. |
| 18 | Mobile designed independently | **Partial** | Verified at 390px, no overflow, real tap targets. Not separately *designed*. |
| 19 | Dashboard as product | **Not started** | Still generic panels. No call timeline, no Action Inbox. |
| 20 | Design system | **Live** | `site.css` + `site.js`, one source for the whole site. |
| 21 | Screenshot → critique → improve loop | **Partial** | The harness exists and I have used it. Not run as a scored adversarial loop. |
| 22 | Quality gates | **Partial** | Green: no console errors, no overflow, WCAG AA, OG/Twitter/canonical, favicon, share image. Missing: 404 page, analytics events, structured data. |
| 23 | Details | **Partial** | Favicon, titles, OG, tel: links done. No 404/500 page, no legal pages. |
| 24 | Don't rewrite good tech | **Live** | Architecture untouched. |
| **Voice on the site** | **Built** | Your request today: 28 clips rendered at build time, Bella answering, a second voice calling, playback driving the transcript so words cannot drift from the audio. Waiting on Netlify. |

---

## Directive 2 — product and business

### Live

| # | Item | Note |
|---|---|---|
| 4 | **ANSWER / ACT / ASK / ESCALATE** | Built today. ESCALATE is deterministic and runs *before* the model — a model never asked cannot be talked round. 26 tests, half of them false-positive cases on purpose. Every rule states its reason; the call records which rule decided it. **Built, not yet deployed.** |
| 5 | Call experience | Barge-in with generation fencing, phone-tuned endpointing, greeting cached so callers do not hear dead air, per-venue speaking pace. |
| 11 | Restaurant intelligence | Turn times by party size, tightest-fit tables, same-section combinations, kitchen pacing, last seating. |
| 12 | Clinic and dental intelligence | Practitioners, surgeries and rooms as separate constraints; first visit books as consultation. |
| 13 | Salon intelligence | Qualified staff, service chains, shared stations, cleanup buffer held not quoted. |
| 14 | Scheduling engine | Deterministic. The model interprets intent; it never invents availability. 28 tests. |
| 24 | Test lab | The test console: talk or type, with every tool call and its result on screen. |
| 41 | **Personalised demo generator** | Paste a URL, get a link that answers as their business. 6.2s measured end to end. 19 tests, mostly SSRF refusals. |
| 66 | Vertical starter packs | Three seeded fixtures acting as templates. |

### Partial

| # | Item | What is missing |
|---|---|---|
| 6 | Human handoff | Transfers work. No warm handoff — the human gets no context. |
| 10 | Customer recognition | Returning callers recognised by number. No profile depth. |
| 18 | Call inbox | Calls list with transcripts. No timeline, no outcome-first summary. |
| 30 | Roles and permissions | owner/manager/staff with venue scoping. No custom roles, no MFA, no SSO. |
| 31 | Security | scrypt, server sessions, signed stream tokens, login throttling, SSRF defence. No encryption at rest, no audit log, no retention policy. |
| 32 | Recording and consent | Transcript-only by default, demo disclosure in the greeting. No configurable policy. |
| 39 | Website | Done. Vertical pages done. |
| 40 | Live website demo | Recorded audio today. Not yet a live microphone call from the marketing site. |

### Not started

Business Brain as structured versioned data (8) · knowledge extraction workflow
(9) · SMS/messaging layer (17) · **Action Inbox (19)** · home dashboard (20) ·
value dashboard (21) · quality score (22) · continuous improvement loop (23) ·
regression testing per account (25) · versioning and rollback (26) ·
**integrations (27)** · API and webhooks (28) · multi-location (29) ·
reliability and failover (33) · observability (34) · internal ops console (35) ·
onboarding flow (36) · white-glove checklist (37) · first-7-days report (38) ·
scheduler for demos (44) · pre-demo brief (45) · sales CRM (47) · outbound
sequences (48–51) · speed to lead (52) · follow-up (53) · trials (54) · land and
expand (55) · referrals (56) · reviews (57) · case studies (58) · partners (59) ·
pricing (60) · billing (61) · customer success (62) · churn prevention (63) ·
data flywheel (65) · provider abstraction (67) · cost control (68) · feature
flags (69) · executive dashboard (74) · sales analytics (75) · website analytics
(76) · SEO (77)

---

## The integrations problem — needs your action, not mine

The site lists Fresha, SevenRooms, OpenTable, Treatwell and Google Calendar.

**Only Google Calendar can be built without a commercial agreement.** The other
four are partner-gated: they issue API credentials under a signed contract,
and there is no self-serve route. No amount of engineering changes that.

This runs on someone else's timeline, so it should start now:

1. Apply to each partner programme this week.
2. Meanwhile build **Google Calendar** — genuinely open, OAuth 2.0, and enough
   for a large share of clinics and salons.
3. Consider **Cal.com** (open source, straightforward API) as a second.

Until then the chips on the site should read "in development", which is what
they say — none is marked live except the built-in diary.

---

## What I would do next, in order

1. **Unblock the deploys.** Nothing else matters while production is frozen.
2. **Business Brain (8)** as structured, versioned, auditable data. Almost
   everything else in the directive depends on it — knowledge management,
   regression tests, versioning, multi-location, the ops console.
3. **Booking idempotency (15)**. A retried webhook double-booking a table is
   the failure that loses a customer permanently, and it is cheap to prevent
   now and expensive to retrofit.
4. **Action Inbox (19)**. The highest-value dashboard feature: "what needs a
   human" is the question an owner actually opens the app to answer.
5. **Google Calendar (27)**.
6. **Live microphone demo on the marketing site (40)**. The plumbing already
   exists — the prospect page does exactly this behind a signed token.
