# Belline Sales Engine — Implementation Plan

Incremental. Every step ends with something runnable and verifiable, and no step
requires the next one to be useful.

The Phase 1 target is one sentence working end to end:

> **"Run UAE Dental Agent"** → import/discover prospects → research them → score
> them → draft personalised outreach → queue for approval → send what I approve
> → track the reply → move the lead through the CRM.

---

## Sequencing note: start the slow things now

Two Phase-1 dependencies are calendar-bound, not engineering-bound, and both
should start on day one in parallel with the build:

1. **Register sending domains and begin mailbox warmup** (4–6 weeks). If this
   starts when the code is finished, the first email goes out six weeks late.
2. **Get the UAE compliance profile reviewed** (COMPLIANCE.md §5). Cheap, and it
   determines whether the first agent is UAE or somewhere else.

Postgres and the Google Places key are same-day tasks and can wait.

---

## Phase 1 — MVP

### Step 1 — Foundations (no behaviour yet)

- `src/lib/sales/db/client.ts` — `pg` pool, `tx()` helper, graceful "not
  configured" when `DATABASE_URL` is unset.
- `db/migrate.ts` + `migrations/0001_init.sql` — the full schema from
  DATABASE.md. One migration; iterating on an unshipped schema by editing
  `0001` is cheaper than a chain of alters.
- `npm run sales:migrate`, `npm run sales:seed` (countries, verticals, services,
  one director, three country managers).
- `src/lib/sales/config/schema.ts` — zod schemas for `AgentConfig`, `ICP`,
  `ScoringModel`, `Sequence`.
- `config/agents.ts` — `resolveAgentConfig()` with the four merge modes.

**Verify:** `npm run sales:migrate && npm run sales:seed`, then a unit test
asserting that a Swiss vertical agent requesting `["email","whatsapp"]` under a
manager allowing `["linkedin","email"]` resolves to `["email"]`.
New deps: `pg`, `zod`.

### Step 2 — Queue and worker

- `queue/jobs.ts` — enqueue, claim (`FOR UPDATE SKIP LOCKED`), complete, fail
  with backoff, dead-letter.
- `queue/worker.ts` + `scripts/worker.ts` (`npm run worker`).
- `cost/meter.ts` + `cost/budget.ts` — record `cost_event`, refuse past cap,
  auto-pause the agent.
- `llm/call.ts` — forced tool choice, zod validation, one repair retry, cost
  metering, prompt hashing. Modelled on `src/lib/prospect.ts:extractBusiness()`.

**Verify:** a `noop` job type; enqueue 100, run two workers, assert each ran
exactly once and none twice.

### Step 3 — Companies, leads, import

- `db/repo/{company,lead,contact,activity}.ts`.
- `discovery/dedup.ts` — domain/phone/name normalisation and the three-key match.
- `discovery/provider.ts` + `discovery/csv.ts`.
- `/sales/leads` list with filters; `/sales/leads/[id]` with the timeline.
- Import UI with column mapping.

**Verify:** import a CSV of ~50 Dubai dental clinics, import it a second time,
and confirm zero duplicates and one merged `source` history per company.
**This is the first genuinely useful milestone** — real data in the system.

### Step 4 — Research agent

- `research/crawl.ts` — wraps `assertPublicUrl()` + `readSite()` from
  `src/lib/prospect.ts`, adds the shallow same-origin link follower (≤6 pages,
  60 s, pattern-matched paths).
- `research/agent.ts` — the structured call, plus the post-checks: drop
  uncited evidence, coerce unevidenced signals to `null`, drop out-of-config use
  cases.
- `queue/handlers/research.ts` → immutable `research_record`.

**Verify:** run over the 50 imported clinics; read twenty summaries by hand and
check every claim against the cited URL. This manual pass is the most valuable
hour in Phase 1 — it is where prompt problems surface before a prospect sees
them.

### Step 5 — Scoring

- `scoring/model.ts` — deterministic, config-weighted, full `breakdown` trace.
- `queue/handlers/score.ts`; rescore-without-LLM job.
- Score breakdown displayed on the lead page.

**Verify:** hand-rank ten companies best-to-worst, run scoring, compare. If the
orders disagree, the weights are wrong — tune and rescore for free.

### Step 6 — Personalisation and templates

- `outreach/templates.ts` — `(country, vertical, language, channel)` with
  fallback chain. English + Arabic frames for UAE dental.
- `outreach/personalise.ts` — the four-part structure.
- `outreach/guards.ts` — length, evidence, capability, vocabulary, anti-template
  similarity, banned phrases, no-pricing.

**Verify:** generate 30 drafts. Read all 30. Count how many you would actually
send unedited — below ~60% means iterate on the prompt before building the
approval UI, not after.

### Step 7 — Approval queue

- `/sales/approvals` — draft, four parts with evidence links, research summary,
  score breakdown, company card, guard warnings.
- Approve · Edit & approve · Reject (reason) · Reject & suppress.
- Edits stored as diffs against the model draft.

**Verify:** approve ten, edit five, reject five; confirm every action lands in
`activity` and `audit_log`, and that the diffs are readable.

### Step 8 — Compliance core

Before the first send, not after.

- `compliance/suppression.ts` — checks at personalise *and* send.
- `compliance/rules.ts` — country channel gating, send windows, holidays.
- Frequency caps; the `lead_one_active_per_company` conflict path.
- Unsubscribe endpoint + `List-Unsubscribe` headers.
- `deleteContactData()`.

**Verify:** suppress an address, attempt to send, confirm permanent cancellation
and an `activity` row. Attempt a send at 03:00 Dubai time, confirm reschedule.

### Step 9 — Email send

- `outreach/channels/channel.ts` interface + `email.ts` (Instantly/Smartlead
  adapter first).
- Mailbox rotation, daily caps, warmup ramp.
- Send guards re-checked at send time; `send:{message_id}` idempotency with the
  provider id written before the status flip.
- Bounce/complaint auto-pause thresholds.

**Verify:** send to your own addresses across providers. Check SPF/DKIM/DMARC
pass, that it lands in the inbox rather than Promotions, that unsubscribe works,
and that a forced crash between API call and DB write does not double-send on
retry.

### Step 10 — Replies and CRM

- `replies/ingest.ts` — webhook + IMAP fallback, threading, deterministic
  opt-out detection first.
- `replies/classify.ts` — eleven categories, deterministic routing table.
- `crm/pipeline.ts` — stage machine; `/sales/leads` board view.
- `/sales/replies` inbox with escalations.

**Verify:** reply to your own test sends with one message per category and
confirm each routes correctly — especially that `OPT_OUT` suppresses globally
and sends no confirmation.

### Step 11 — Agent dashboard and run control

- `/sales/agents` list, `/sales/agents/[id]` editor, `/sales/agents/new`.
- Launch-gate checklist enforced on activation.
- **"Run UAE Dental Agent"** — a button and `npm run agent -- "UAE Dental"`,
  both enqueueing a full pipeline pass.
- Per-agent KPIs: leads found, qualified, sent, reply rate, positive reply rate,
  spend, cost per lead, cost per qualified lead.
- Dead-letter queue visible on `/sales/settings`.

**Phase 1 done** when the target sentence runs unattended except for approval.

**Estimated effort:** 8–11 focused working days for steps 1–11, assuming the
domains are warming in parallel. Step 4 and step 6 will each absorb a day of
prompt iteration that looks like nothing from the outside and determines whether
any of this works.

---

## Phase 2 — Scale across countries and channels

1. **Sequences** — `sequences/` state machine, `sequence_enrollment`, the
   day 1/3/7/14 default, stop conditions, personalised follow-ups.
2. **Decision-maker enrichment** — provider interface, Apollo/Cognism/Dropcontact
   adapters, verification, confidence, company-level fallback.
3. **LinkedIn assisted** — the channel connector creates human tasks with drafted
   text and profile URL. No automation of the platform.
4. **Meetings** — Cal.com/Google, booking links, webhooks, reminders, no-show
   handling, and the one-page briefing generated from stored records only.
5. **Multilingual** — Arabic outreach for UAE and Saudi, German for
   German-speaking Switzerland, French Switzerland after. Native review of every
   template before use; machine-translated cold outreach is worse than none.
6. **Saudi and Switzerland localisation** — country profiles from counsel, KSA
   company-level default, Swiss consent-first with LinkedIn/phone primary.
7. **Country managers and Director doing real work** — KPI rollup materialised
   view, budget reallocation, `agent_directive` proposals with human approval,
   dedup arbitration.
8. **Reporting** — the full six-dimension breakdown, cost-per-X, and
   "UAE Dental Agent generated AED 42,000 MRR" as a query joining `customer`
   back to the voice product's `location_ids`.
9. **MODE 2** — auto-send for pre-approved campaign styles with unflagged
   drafts; everything commercial still escalates.

---

## Phase 3 — Belline sells itself

1. **Vertical demo lines** — one Twilio number per vertical with a script hint;
   the webhook already routes by dialled number. `sales.demo` tracking, usage
   feeding the score, immediate human notification on first use.
2. **Outbound voice prospecting** — a dialler over the existing `VoiceSession`
   and `runtime.ts`, an outbound-specific prompt, local numbers per country,
   strict DNC screening and country gating. The strongest asset in the whole
   plan: the product demonstrates itself in the first thirty seconds of the
   call it is making.
3. **WhatsApp** — Cloud API, approved templates, consent-gated, per-country off
   by default.
4. **Autonomous replies** — auto-answer questions that map to `service.proof`;
   pricing and negotiation still always human.
5. **Autonomous qualification** and **automatic pilot onboarding** — a won deal
   provisions a real `Location` in the voice product, closing the loop from
   discovery to live customer.
6. **MODE 3** — per agent, only after that agent has a track record in MODE 2
   with acceptable complaint and edit rates.

---

## Testing

| Layer | How |
| --- | --- |
| Dedup, scoring, config merge, sequence state | Pure unit tests — all deterministic by design |
| Guards | A corpus of drafts, half deliberately bad (invented facts, prices, banned phrases); every one must be caught |
| LLM agents | A fixed set of ~20 real company pages with hand-written expected signals; run on prompt changes and diff |
| Queue | Concurrent workers, forced crashes mid-handler, assert idempotency |
| Compliance | Suppressed-address send attempt, out-of-window send, frequency cap, opt-out in each language |
| UI | Playwright, extending the existing `audit/` harness |

The compliance tests run in CI and block deploy. A regression there is not a bug
report, it is a letter.

---

## Open decisions

Blocking Phase 1 step 1:

1. **Postgres host** — Railway (already in this repo's deploy history), Neon,
   or Supabase. Recommendation: Railway, alongside the worker, one platform.
2. **First agent** — UAE Dental is the recommendation: legally the most
   straightforward of the three countries, English-first so no translation
   dependency, phone-first booking culture so the Belline pitch is strongest,
   and dense enough in Dubai to fill a pipeline from one city.
3. **Email provider** — Instantly or Smartlead for speed, SES for economics.
   Recommendation: Instantly first; it includes warmup, which you need anyway.

Blocking Phase 1 step 3:

4. **Discovery source** — Google Places key now, or CSV-only for the first
   month? CSV-only is a legitimate answer: it costs nothing and the first 200
   leads can be hand-built while the rest of the pipeline is proven.
