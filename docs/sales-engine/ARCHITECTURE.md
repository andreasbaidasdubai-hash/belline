# Belline Sales Engine — Architecture

> Status: proposal. Nothing in `src/lib/sales/` exists yet.
> Written after reading the existing repository at commit `5472f24`.

---

## 1. What already exists

Belline today is a **single Next.js 15 process** (`server.ts`) that runs the App
Router inside a plain Node HTTP server so it can also hold WebSockets open for
live voice calls. It has no ORM, no queue, no Redis and four runtime
dependencies (`@anthropic-ai/sdk`, `next`, `react`, `ws`). Data is JSON files
written atomically through one narrow module.

```
server.ts ── http ──► Next App Router ──► src/app/(app)/*     dashboard, guarded
          └─ ws ────► /ws/voice   browser test console
                      /ws/demo    public prospect demo  (signed token, no session)
                      /ws/twilio  real phone calls      (signed token + signature)
                                        │
                                        ▼
                        src/lib/voice/session.ts   barge-in, turn-taking
                        src/lib/agent/runtime.ts   streaming model loop + tools
                        src/lib/booking/*          availability, per vertical
                        src/lib/store.ts           JSON persistence
```

### What the sales engine reuses, unchanged

| Existing asset | Why it matters here |
| --- | --- |
| `src/lib/prospect.ts` → `assertPublicUrl()` | A hardened SSRF guard that resolves DNS and rejects private ranges. The research agent fetches attacker-influenced URLs all day; this is exactly the check it needs. |
| `src/lib/prospect.ts` → `readSite()` | HTML → text, honest User-Agent, 403/429 handling with a useful message. The website-research connector is this function plus a link-follower. |
| `src/lib/prospect.ts` → `extractBusiness()` | The **structured-output pattern** for the whole platform: `tool_choice: {type:"tool"}` with a JSON Schema, so the model returns typed data instead of prose. Every sales agent copies this shape. |
| `buildProspectLocation()` + `/demo/[slug]` + `/ws/demo` + `signStreamToken()` | Requirement §9 (live Belline demo) is **already built**. A prospect gets a page that dials a Belline agent configured from their own website, capped, disclosed and expiring in 14 days. The sales engine adds tracking and per-vertical scripts, not the mechanism. |
| `src/lib/auth.ts` | scrypt passwords, server-side revocable sessions, roles, and — importantly — no `next/*` imports, so a background worker can authenticate too. |
| `src/app/(app)/layout.tsx` | One guard covering every dashboard route. Sales pages inherit it by living under it. |
| `src/lib/verticals.ts` | Per-vertical vocabulary (`patient` vs `client` vs `guest`). Outreach copy needs the same words. |
| `src/lib/providers/{tts,stt,sms}.ts` | The provider-abstraction convention already used here: an interface, a real implementation, a mock when the key is absent. |
| `scripts/doctor.ts` | "Why isn't it working" — checks every key against its provider. Extended with the sales integrations. |
| `playwright.config.ts` + `audit/` | Accessibility/regression harness the new dashboard pages plug into. |

### What is deliberately **not** reused

`src/lib/store.ts`. It is the right design for one venue group's diary — a few
hundred bookings held in memory, five JSON files. The sales engine holds tens of
thousands of companies, an append-only activity timeline, a job queue with
concurrent workers, and reporting queries that group by five dimensions at once.
That is a database. See §4.

The existing store stays exactly as it is; nothing about the voice product
changes.

---

## 2. Shape of the new module

One engine, configuration-generated agents. No per-vertical code.

```
                       ┌──────────────────────────────────────┐
                       │  Admin dashboard  /sales/*            │
                       │  agents · approvals · leads · replies │
                       │  meetings · reports · settings        │
                       └───────────────┬──────────────────────┘
                                       │ reads/writes
┌──────────────────────────────────────▼───────────────────────────────────┐
│                          Deterministic core                              │
│  agent config resolution · scoring maths · sequence state machine ·      │
│  suppression · dedup · rate limits · cost meter · CRM stage transitions  │
└───────┬──────────────────────────────────────────────────┬───────────────┘
        │ calls, with validated inputs                     │ enqueues
        ▼                                                  ▼
┌───────────────────────────┐                  ┌───────────────────────────┐
│  LLM agents (judgement)   │                  │  Job queue (Postgres)     │
│  research · decision-maker│                  │  SKIP LOCKED, retries,    │
│  personalise · classify   │                  │  idempotency keys         │
│  reply-draft · briefing   │                  └───────────┬───────────────┘
│                           │                              │
│  Every one returns a      │                              ▼
│  *structured proposal*.   │                  ┌───────────────────────────┐
│  None writes to the DB.   │                  │  Provider connectors      │
└───────────────────────────┘                  │  discovery · enrichment · │
                                               │  email · calendar · voice │
                                               └───────────────────────────┘
```

**The load-bearing rule:** an LLM never issues a write. It returns a structured
object; application code validates it against a schema, checks it against
suppression/consent/budget/rate limits, and only then persists. This is why
`research_record`, `lead_score` and `message` are separate tables from `company`
and `lead` — model output lands in append-only evidence tables, and derived
state is computed from it by code.

---

## 3. The agent hierarchy

Three levels, matching the org chart. Each level is a row in the same `agent`
table, distinguished by `kind`, linked by `parent_id`.

```
Sales Director  (kind = director, global)
 │   owns: global budget split, global suppression, cross-country comparison,
 │         pause/scale recommendations
 │
 ├── UAE Manager        (kind = country_manager, country = AE)
 │    │   owns: country compliance profile, permitted channels, language
 │    │         defaults, budget split across its verticals, dedup arbitration
 │    ├── UAE Dental Agent      (kind = vertical_agent, vertical = dentists,   langs = [en, ar])
 │    ├── UAE Clinic Agent      (…)
 │    ├── UAE Salon Agent       (…)
 │    └── UAE Restaurant Agent  (…)
 │
 ├── Saudi Manager      (country = SA)   └── Dental · Clinics · Salons · …
 └── Switzerland Manager (country = CH)  └── Dental · Clinics · Restaurants · …
```

### Configuration inheritance

`resolveAgentConfig(agentId)` walks Director → Country → Vertical and merges.
Three merge modes per field, declared in the config schema:

| Mode | Meaning | Example |
| --- | --- | --- |
| `override` | Child wins if set | `outreach_strategy.tone` |
| `intersect` | Child may only narrow | `channels` — a country manager disabling WhatsApp in Switzerland cannot be re-enabled by a vertical agent |
| `sum_capped` | Child budget must fit inside parent's remaining | `daily_budget_usd` |

This is what makes the hierarchy real rather than decorative: **compliance and
spend flow downward and cannot be overridden upward.** A single field on the
Switzerland Manager (`email_requires_prior_consent: true`) changes the behaviour
of every Swiss vertical agent at once.

### What each level actually *runs*

| Level | Runs | Cadence | Autonomy |
| --- | --- | --- | --- |
| Vertical agent | The 13-stage pipeline (PIPELINE.md) over its own lead set | Continuous, queue-driven | MODE 1 → 3 per agent |
| Country manager | Budget reallocation across children, compliance gate audits, dedup arbitration when two children discover one company | Daily | Proposals only in MODE 1/2 |
| Director | KPI rollup, country comparison, "pause the Swiss restaurant agent" recommendations | Daily | Proposals only, always human-approved in Phase 1–2 |

Manager and Director output is written as `agent_directive` rows — a proposal
with a rationale and a diff, shown in the dashboard for approval. Nothing at
these levels silently changes another agent's configuration.

---

## 4. Persistence

**Postgres, in its own schema, additive to the existing app.**

- Existing voice product keeps `data/*.json`. Zero migration, zero risk.
- Sales engine uses `DATABASE_URL`. If unset, `/sales/*` renders a "not
  configured" page and every other route behaves exactly as today — the same
  graceful-degradation contract the vendor providers already follow.
- Access through one thin repository module per entity. Plain SQL via `pg`,
  numbered `.sql` migrations. **No ORM** — consistent with a four-dependency
  codebase, and the reporting queries here are the kind ORMs make worse.

Why not extend the JSON store: aggressive dedup needs indexed lookups on
normalised domain and phone; the job queue needs `SELECT … FOR UPDATE SKIP
LOCKED`; the KPI dashboard groups by country × city × vertical × agent ×
channel × campaign × language; and the activity timeline is append-only and
unbounded. Each of those is a paragraph of code against Postgres and a
rewrite against JSON files.

Why not SQLite: one writer, and the worker plus the web process plus the CLI all
write. Fine for a prototype, a known future rewrite.

New runtime dependencies: `pg` and `zod`. `zod` earns its place because every
LLM boundary and every agent config needs runtime validation — hand-rolled
validators for twenty-odd schemas would be worse code, not less code.

---

## 5. Background work

A **Postgres-backed job queue**, not Redis/BullMQ. One less service to run, and
transactional enqueue-with-write is worth more here than throughput we will
never need (this system does thousands of jobs a day, not millions).

```
job(id, type, payload jsonb, run_at, attempts, max_attempts,
    status, locked_by, locked_at, idempotency_key unique, last_error)
```

- Claim: `UPDATE job SET status='running', locked_by=$1 WHERE id = (SELECT id FROM job WHERE status='pending' AND run_at <= now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`
- Retry: exponential backoff, `max_attempts` then `status='dead'` with the error kept.
- Idempotency: every handler derives a key (`research:{company_id}:{config_hash}`)
  so a retry after a crash mid-write cannot double-send an email or double-bill
  an enrichment call.
- Rate limits: per-provider token buckets held in a `rate_limit` table, checked
  at claim time; a job that would exceed its bucket is re-scheduled, not failed.

The worker runs as `npm run worker` — a separate process, same codebase. In
development it can run inside `server.ts` behind a flag. It cannot go on Vercel
for the same reason the voice bridge cannot: it is a long-lived process.

---

## 6. Autonomy modes

One field on the agent, `autonomy_mode`, gates exactly one thing: **who
approves an outbound side effect.**

| Mode | Discovery / research / scoring | Outbound message | Reply handling |
| --- | --- | --- | --- |
| 1 REVIEW | Automatic | Queued for human approval | Escalated to human |
| 2 SEMI | Automatic | Auto-sent if the campaign style is pre-approved *and* the personalisation passes the guard checks | Simple categories auto-answered; anything commercial escalated |
| 3 AUTONOMOUS | Automatic | Auto-sent | Auto-answered up to a qualification threshold, then escalated |

The architecture is identical in all three; the difference is whether
`message.status` starts at `pending_approval` or `queued`. Building MODE 1 first
therefore costs nothing later — the approval queue is a table and a page, and
MODE 3 is that table auto-approving. There is no MODE-3 rewrite waiting.

Guard checks that run **regardless of mode**, before any send:
suppression list, per-company frequency cap, per-country channel permission,
consent requirement for that country, agent budget remaining, a
no-fabrication check that every factual claim in the message traces to a stored
`research_record` evidence URL, and a template/personalisation ratio floor.

---

## 7. Folder structure

```
src/lib/sales/
├── config/
│   ├── agents.ts            resolveAgentConfig(), hierarchy walk, merge modes
│   ├── schema.ts            zod schemas for AgentConfig, ICP, ScoringModel, Sequence
│   └── defaults.ts          seed configs for AE/SA/CH × verticals
├── db/
│   ├── client.ts            pg Pool, tx helper
│   ├── migrate.ts           runner for migrations/*.sql
│   ├── migrations/          0001_init.sql, 0002_…
│   └── repo/                company.ts lead.ts contact.ts message.ts … one per entity
├── queue/
│   ├── jobs.ts              enqueue / claim / complete / fail
│   ├── worker.ts            the loop
│   └── handlers/            discover.ts research.ts score.ts personalise.ts send.ts …
├── llm/
│   ├── call.ts              forced tool_choice, zod validation, retry, cost metering
│   └── models.ts            which model per task, with cost table
├── discovery/
│   ├── provider.ts          LeadSourceProvider interface
│   ├── google-places.ts     · csv.ts · website.ts
│   └── dedup.ts             normalisation + match keys
├── enrich/                  email verification, decision-maker providers
├── research/                crawl.ts (wraps ../prospect readSite) · agent.ts
├── scoring/                 model.ts — deterministic, config-weighted
├── outreach/
│   ├── personalise.ts       observation → problem → solution → CTA
│   ├── templates.ts         country × vertical × language × channel
│   ├── guards.ts            the pre-send checks from §6
│   └── channels/            channel.ts (interface) · email.ts linkedin.ts whatsapp.ts voice.ts
├── sequences/               state machine, stop conditions, scheduling
├── replies/                 ingest.ts (webhook/IMAP) · classify.ts · autoreply.ts
├── demos/                   bridges to the existing prospect demo + usage tracking
├── meetings/                provider.ts · briefing.ts
├── crm/                     pipeline.ts (stage machine) · timeline.ts
├── compliance/              suppression.ts · rules.ts (per country) · consent.ts
├── cost/                    meter.ts · budget.ts (pause on limit)
└── kpi/                     rollup.ts

src/app/(app)/sales/
├── page.tsx                 director view: all agents, KPIs, spend
├── agents/                  list · [id] editor · new
├── leads/                   list with filters · [id] full timeline
├── approvals/               the MODE 1 queue — the most-used page in Phase 1
├── replies/ · meetings/ · reports/ · settings/
└── api/… (route handlers)   webhooks: email events, replies, calendar

scripts/
├── worker.ts                npm run worker
├── sales-doctor.ts          key/integration checks, extending scripts/doctor.ts
└── run-agent.ts             npm run agent -- "UAE Dental" --stage=discover
```

---

## 8. Risks

Ordered by how much damage each does if ignored.

1. **Cold email deliverability is the real product risk, not the AI.** Sending
   cold outbound from `belline.ai` will eventually damage the domain that also
   carries your customer and investor email. Mitigation is non-negotiable and
   goes in Phase 1: separate sending domains (`getbelline.com`, `belline-hq.com`),
   SPF/DKIM/DMARC on each, 4–6 week warmup, per-mailbox daily caps (~30–50),
   and a provider whose terms *permit* cold outreach — Resend, Postmark and
   SendGrid all prohibit it and will terminate the account.

2. **Switzerland is the strictest of the three markets, not the easiest.**
   UWG Art. 3(1)(o) requires **prior consent** for mass advertising email, with
   criminal-law exposure. Swiss outbound should default to LinkedIn, phone and
   physical channels, with email only to addresses published for that purpose
   and a documented basis. The country-manager config exists largely for this.
   See COMPLIANCE.md.

3. **Saudi PDPL is consent-forward** and treats personal data (including
   business-person names and direct emails) more strictly than UAE practice.
   Company-level addresses are the safer default; person-level requires care.

4. **LinkedIn automation gets accounts banned.** Automating connection requests
   and DMs at volume risks permanent restriction of a founder's own account.
   The design treats LinkedIn as **assisted**: the agent researches and drafts,
   a human clicks. Nothing in the architecture depends on this changing.

5. **Fabrication is an existential risk in outbound.** A message telling a
   clinic owner they "have four locations" when they have one destroys the
   conversation. Every factual claim in a draft must resolve to an evidence URL
   in a `research_record`; the pre-send guard enforces it, and drafts that fail
   go to a human rather than out.

6. **Cross-agent collision.** The same clinic can match a UAE Clinic Agent and a
   UAE Dental Agent. Enforced by a partial unique index giving one active lead
   per company globally, with the country manager arbitrating. Without it, a
   prospect gets two different Belline emails in a week and the brand is done.

7. **Google Maps scraping violates Google's terms.** Use the Places API and pay
   for it; the cost model assumes this.

8. **LLM cost drift.** Twelve agents × research on every discovered company is
   the line item that surprises people. Every LLM call is metered against an
   agent budget, and an agent that hits its daily cap pauses itself.

9. **Deployment.** The worker needs a persistent process, same constraint as the
   voice bridge — Railway/Fly/Render, not Vercel. Postgres alongside it.

10. **The personalised demo impersonates a real business by design.** The
    existing 14-day TTL and on-page disclosure are the mitigation and must not
    be relaxed as demo volume grows.

---

## 9. Phase boundaries

- **Phase 1** proves one sentence works end to end: *"Run UAE Dental Agent"* →
  import/discover → research → score → draft → approve → send → track reply →
  CRM stage. Single country, single vertical, single channel, MODE 1.
- **Phase 2** widens: sequences, decision-maker enrichment, meetings, Arabic and
  German, KPI breakdowns, the country/director levels doing real work.
- **Phase 3** deepens: Belline voice prospecting (the strongest asset — the
  product demos itself over the phone), WhatsApp, autonomous replies, MODE 3.

Detail in IMPLEMENTATION_PLAN.md.
