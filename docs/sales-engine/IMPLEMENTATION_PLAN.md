# Belline Sales Engine — Implementation Plan

> Revised 2026-09-11 against the full directive: an AI-native sales workforce
> for a $49–99/month self-serve product. The previous version of this plan
> optimised for a different funnel and is superseded; see §1.

---

## 1. What changed, and why

The first version of this plan built a classic B2B outbound engine whose
terminal state was **meeting booked → human handoff**. That is the wrong shape
for this product.

At $49–99/month, a booked meeting is close to a loss. If a person spends forty
minutes selling and onboarding a customer worth ~$60/month in contribution, the
payback is measured in quarters and the model does not scale past the founder's
calendar. The directive is explicit about the alternative:

```
find business → understand business → create personalised demo → send email
→ prospect listens → prospect calls Belline → Belline sells itself
→ prospect pays → Belline onboards → number goes live
```

Human contact is the **exception**, reserved for high-value prospects, unusual
integrations, enterprise, or explicit request.

Three consequences reorder everything below:

1. **The personalised demo is the product of the funnel, not a late-stage CTA.**
   Every qualified lead gets one. The email exists to deliver it. It moves from
   "Phase 3, nice to have" to the centre of Phase 1.
2. **Payment and self-serve onboarding move up.** They are the terminal state,
   not a Phase 3 flourish. Without them the funnel has no end.
3. **Funnel instrumentation is the primary feedback loop, not reporting.** The
   headline KPI — *paid customers per 1,000 qualified personalised demos* —
   cannot be computed without the nine tracked events, so they ship early.

Meeting booking survives as an **escape hatch**, not a goal.

---

## 2. Where we actually are

Against the twelve points of the directive.

| # | Capability | State | Where |
| --- | --- | --- | --- |
| 1 | Lead sourcing | **Partial.** Dedup (3 keys, E.164 for AE/SA/CH), CSV import, agent config hierarchy, job queue, cost metering, budgets. 61 tests green. No Places connector. **Never run against a database.** | `src/lib/sales/` |
| 2 | Personalised demo | **~70% built, not wired together.** `createProspectDemo()` reads a website and builds a live, callable Belline configured as that business. `build-voices.ts` renders multi-voice conversational calls to content-addressed MP3s. Neither is driven per-prospect from the pipeline, and the 30–60s *recorded* demo does not exist yet. | `prospect.ts`, `build-voices.ts` |
| 3 | Demo link, not MP3 | Link mechanism exists (`/demo/[slug]`). **No tracking at all** — none of the nine events are recorded. | `src/app/demo/[slug]/` |
| 4 | Landing page sells | Exists: business name, live call, disclosure, expiry. Missing: the recorded demo, and an "Activate Belline" payment CTA. | `src/app/demo/[slug]/page.tsx` |
| 5 | **Belline sells Belline** | **Does not exist.** The largest gap and the most distinctive part of the vision. | — |
| 6 | Self-serve onboarding | **Business Brain exists** — versioned, immutable, auditable config with rollback. Website extraction exists. No onboarding agent, no payment. | `brain.ts`, `prospect.ts` |
| 7 | Integration layer | Seam defined (`BookingBackend`), no integrations built. Fallbacks (message, SMS, transfer) exist. | `booking/index.ts` |
| 8 | Voice experience | **The most advanced part.** Streaming STT→LLM→TTS, real barge-in with generation fencing, sentence chunking, and `spoken.ts` — the deterministic reasoning/speaking split with per-fragment delivery rate. | `voice/`, `agent/` |
| 9 | Outreach email | Designed, not built. No provider, no sending domain. | — |
| 10 | Follow-up automation | Schema designed, not built. | — |
| 11 | Agent architecture | Config-driven hierarchy covers Research / Qualification / Outreach / Follow-up. Missing as first-class: Demo Generation, AI Sales, Payment, Onboarding, Integration, Customer Success. | `sales/config/` |
| 12 | End-to-end funnel | Not yet. | — |

**The honest summary:** the voice product is strong, demo generation is most of
the way there without anyone having connected it, and the sales engine has solid
foundations that have never touched a database.

---

## 3. The number that decides everything

The headline KPI is **paid customers per 1,000 qualified personalised demos**.
Nothing else in this plan can be tuned until it is measured.

At a measured cost of ~$0.31 per lead through a full sequence on Opus 5:

| Conversion per 1,000 demos | CAC | Payback at ~$60/mo contribution |
| --- | --- | --- |
| 1 | ~$310 | ~5 months — thin |
| 3 | ~$103 | ~7 weeks — workable |
| 10 | ~$31 | ~2 weeks — excellent |

Two things follow:

- **Model choice is downstream of this number, not upstream.** At 1/1000, the
  Opus-everywhere default is wrong and research should drop to a cheaper model.
  At 10/1000 the cost of the model is irrelevant and demo quality is worth
  paying for. Do not tune models before the funnel has run.
- **Demo quality is the highest-leverage variable in the business.** A 3×
  improvement there beats every cost optimisation in this document combined.

Therefore: **build the thinnest complete funnel that produces this number**,
rather than building each stage to depth. That is what Phase 1 below is.

---

## 4. Phase 1 — one complete funnel, 20 clinics

Target: twenty Dubai dental clinics go end to end, and we learn the conversion
rate. Depth is deliberately sacrificed everywhere it is not load-bearing.

### 4.0 — Unblock (yours, ~5 minutes)

Postgres on Railway, `DATABASE_URL` into `.env`, then:

```bash
npm run sales:db -- migrate && npm run sales:db -- seed && npm run check:queue
```

Everything below is blocked on this. ~1,400 lines of repository and query code
have been written against a schema no database has ever parsed.

### 4.1 — Import and research, 20 real clinics

CSV import UI over the existing dedup; research agent over the existing
`readSite()`/`assertPublicUrl()` crawler; deterministic scoring. Read twenty
research summaries by hand against their cited URLs — this is the hour that
catches fabrication before a prospect sees it.

### 4.2 — Demo Generation Agent ← *the centre of this phase*

Two artefacts per prospect, both from public website data:

- **The recorded demo (new).** A 30–60s simulated call, written by a model from
  the prospect's own services/hours/FAQs, rendered to MP3 by the existing
  content-addressed pipeline. Two voices. Realistic pacing via `spoken.ts`.
  Labelled a simulation, on the page and in the audio.
- **The live demo (exists).** `createProspectDemo()` already builds it. Wire it
  to the pipeline instead of a paste box.

Cost per demo is a handful of TTS seconds plus one model call; the clips are
content-addressed so re-rendering is free.

### 4.3 — Landing page and tracking

Upgrade `/demo/[slug]`: recorded demo above the fold, "Call Belline now",
"Activate Belline for my business". Instrument all nine events — delivered,
opened, clicked, played, **% listened**, live demo initiated, signup started,
paid, onboarded. `% listened` and *called the live line* are the two strongest
intent signals in the funnel and drive every follow-up rule.

### 4.4 — Outreach email

The short demo-delivery email from the directive, not a pitch. One provider
adapter. Approval queue in MODE 1.

**Start sending-domain warmup on day one** — 4–6 weeks, calendar-bound, and it
gates everything else. See COMPLIANCE.md §4.

### 4.5 — Measure

Twenty demos, one funnel table, one number. Then decide what Phase 2 is.

---

## 5. Phase 2 — Belline sells Belline

Only worth building once §3's number says the funnel converts at all.

1. **AI Sales Agent (voice + chat).** Reuses the entire voice stack. Knows the
   prospect's public business data, explains Belline, compares plans, handles
   objections, qualifies, recommends a plan, sends the payment link. Escalates
   on: unusual integrations, enterprise, explicit request for a human, anything
   commercial that is not the standard price list. **It may not negotiate.**
2. **Payment.** Stripe, `signup_started` → `payment_completed`.
3. **Onboarding Agent.** Pre-fills the Business Brain from the website and asks
   the owner only to *verify or correct* — the Brain's versioning already gives
   this an audit trail and rollback.
4. **Follow-up automation** driven by the tracked events.
5. **Number goes live.**

### 6. Phase 3 — scale and widen

Google Places discovery · integration layer (booking/calendar/PMS) · Saudi and
Swiss localisation with counsel-reviewed profiles · Arabic and German outreach ·
Customer Success agent · MODE 2 then MODE 3 autonomy per agent.

---

## 7. Standing constraints

These do not relax as volume grows.

- **The demo is always labelled a simulation**, in the audio and on the page,
  and expires. It carries a real business's name by design — see COMPLIANCE.md.
- **No fabrication.** Every claim about a prospect traces to a fetched evidence
  URL; every claim about Belline traces to `service.proof`.
- **No AI-generated pricing or commercial terms**, in any autonomy mode.
- **Switzerland is consent-first** (UWG Art. 3(1)(o)); Saudi is company-level
  first (PDPL). UAE ships first for that reason.
- **Never send cold outbound from `belline.ai`.**
- **LLMs propose; code disposes.** No model writes to the database.
