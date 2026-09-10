# Belline Sales Engine — Agents

Twelve agents, one codebase, zero per-agent code. An agent is a row in
`sales.agent` plus a JSON config. Creating "Saudi Salon Agent" is filling in a
form, not a deploy.

---

## 1. The hierarchy

```
Sales Director
 ├── UAE Manager ────── Dental · Clinics · Salons · Restaurants
 ├── Saudi Manager ──── Dental · Clinics · Salons
 └── Switzerland Mgr ── Dental · Clinics · Restaurants
```

All three levels share the `sales.agent` table and differ by `kind`. What
differs is scope, cadence and authority.

| | Vertical agent | Country manager | Sales Director |
| --- | --- | --- | --- |
| Owns | One country × vertical × language set | One country | All countries |
| Runs | The 13-stage pipeline, continuously | A daily review | A daily review |
| Writes | Leads, research, drafts, messages | `agent_directive` proposals | `agent_directive` proposals |
| Can it change another agent? | No | Only via approved directive | Only via approved directive |
| Deterministic vs LLM | Both | Mostly deterministic; LLM for the narrative | Mostly deterministic; LLM for the narrative |

### Why managers exist

Not decoration. Three concrete jobs no vertical agent can do:

1. **Compliance is a country property.** "Swiss cold email requires prior
   consent" belongs on the Switzerland Manager, and every vertical agent beneath
   it inherits the restriction and *cannot* override it (`intersect` merge, see
   below). One field, six agents corrected.
2. **Budget is zero-sum within a country.** If the UAE has $600/month, the
   manager splits it and rebalances toward whichever vertical is converting.
3. **Dedup arbitration.** A multi-speciality clinic matches both the Dental and
   the Clinic agent. The `lead_one_active_per_company` index rejects the second
   claim and files a `lead_claim_conflict`; the country manager resolves it by
   rule (highest score wins, ties to the more specific vertical).

The Director does the same one level up: compares countries, proposes pausing an
agent whose cost-per-meeting is three times its siblings', and holds the global
suppression list.

---

## 2. Configuration

```jsonc
{
  "country": "AE",
  "regions": ["Dubai", "Abu Dhabi"],
  "vertical": "dentists",
  "languages": ["en", "ar"],
  "default_language": "en",

  "ideal_customer_profile": {
    "must": {
      "has_phone": true,
      "appointment_based": true,
      "status_not": ["closed", "irrelevant"]
    },
    "prefer": {
      "location_count_min": 2,
      "review_count_min": 40,
      "rating_min": 3.8,
      "open_weekends": true,
      "practitioner_count_min": 3
    },
    "exclude": {
      "location_count_max_solo": true,        // single-practitioner, no staff
      "chains_above": 40,                     // enterprise; different sale
      "keywords_in_name": ["mobile", "home visit"]
    }
  },

  "belline_services": [
    "missed_call_recovery", "after_hours_answering",
    "appointment_booking", "faq_handling", "multilingual_support"
  ],

  "qualification_rules": {
    "min_score_to_contact": 55,
    "require_contactable": ["email", "phone"],   // at least one
    "require_evidence_for_claims": true
  },

  "research_prompt": "Focus on how patients currently book, whether the practice runs multiple branches, and whether reviews mention unanswered calls or long hold times. Note languages advertised.",

  "scoring": {
    "weights": {
      "multi_location": 15, "review_volume": 12, "long_hours": 10,
      "appointment_based": 12, "high_ticket": 8, "practitioner_count": 8,
      "phone_first_booking": 15, "whatsapp_active": 6,
      "no_automated_answering": 10, "premium_positioning": 6, "expansion": 8,
      "demo_used": 20
    },
    "penalties": {
      "permanently_closed": -100, "solo_operation": -25, "no_phone": -40,
      "no_appointments": -30, "outside_region": -50, "wrong_vertical": -60
    },
    "bands": { "hot": 75, "warm": 55 }
  },

  "outreach_strategy": {
    "channels": ["email"],
    "sequence": "gulf-dental-v1",
    "tone": "polished, premium, direct; no US-style hype",
    "cta": "demo_call",
    "max_words_first_touch": 90,
    "send_window": { "days": [0,1,2,3,4], "start": "08:30", "end": "17:00", "tz": "Asia/Dubai" },
    "daily_send_cap": 40
  },

  "budget": { "daily_usd": 12, "monthly_usd": 250 },
  "autonomy_mode": "review"
}
```

Validated by a zod schema in `src/lib/sales/config/schema.ts`. Invalid config
means the agent will not start — not that it starts and behaves oddly.

### Inheritance

`resolveAgentConfig(agentId)` walks Director → Country → Vertical. Every field
declares its merge mode:

| Mode | Behaviour | Fields |
| --- | --- | --- |
| `override` | Child wins | `research_prompt`, `tone`, `cta`, ICP |
| `intersect` | Child may only narrow the parent's set | `channels`, `languages`, `regions` |
| `sum_capped` | Child total may not exceed parent's remaining | `budget.*`, `daily_send_cap` |
| `strictest` | Most restrictive wins regardless of level | `send_window`, `frequency_cap`, consent requirements |

A Swiss vertical agent that lists `["email","whatsapp"]` while its manager
allows `["linkedin","email"]` resolves to `["email"]`. There is no syntax for
escalating privilege upward.

---

## 3. The LLM agents

Six model-driven agents. **Every one uses forced tool choice with a JSON Schema**
— the pattern already proven in `src/lib/prospect.ts:extractBusiness()` — and
returns a structured proposal that application code validates before anything is
written.

All calls go through `src/lib/sales/llm/call.ts`, which handles: schema
validation, one repair retry on invalid output, cost metering into
`cost_event`, prompt hashing for reproducibility, and a hard refusal if the
agent's budget is exhausted.

### 3.1 Research agent

Input: company row, up to 6 fetched pages (home, about, services, contact,
team, booking), Google reviews excerpt, opening hours.
Output:

```ts
{
  summary: string,                 // 3–5 sentences, why a good prospect
  signals: {                       // typed, closed vocabulary
    multi_location: boolean, location_count: number|null,
    long_hours: boolean, weekend_open: boolean, appointment_based: boolean,
    online_booking: boolean, booking_provider: string|null,
    whatsapp_booking: boolean, phone_first: boolean,
    has_front_desk: boolean|null, practitioner_count: number|null,
    languages_advertised: string[], premium_positioning: boolean,
    recent_expansion: boolean, review_complaints_about_calls: boolean,
    after_hours_gap: boolean
  },
  use_cases: string[],             // must be slugs from sales.service
  evidence: [{ claim, url, quote, }]   // one per non-obvious signal
}
```

Rules baked into the prompt and enforced in code afterwards:

- **Never invent.** A signal with no evidence entry is coerced to `null`, not
  `false` — "we could not tell" and "no" are different, and the scoring model
  treats them differently.
- `use_cases` outside the configured `belline_services` are dropped.
- Every `evidence.url` must be one of `pages_read`. Anything else is discarded
  and logged, because a model citing a page it never saw is the failure mode
  that produces a confidently wrong first email.

### 3.2 Decision-maker agent

Ranks candidate people found by enrichment providers and page-reading against a
configurable priority list (owner → founder → MD → GM → ops → practice manager →
front-office → marketing), assigns a confidence, and **falls back to
company-level contact** rather than guessing a name. Guessed email patterns
(`firstname@domain`) are permitted only when verification returns `valid`, and
are stored with `confidence <= 0.5`.

### 3.3 Personalisation agent

The most important one, and the one most likely to embarrass us.

Fixed four-part structure:

```
OBSERVATION      something specific and verifiable about *this* business
BUSINESS PROBLEM the cost of that, in their terms
BELLINE SOLUTION one or two services, outcome-first
LOW-FRICTION CTA a question, not a calendar demand
```

Constraints, enforced after generation by `outreach/guards.ts`:

| Guard | Rule |
| --- | --- |
| Length | ≤ `max_words_first_touch` (default 90) |
| Evidence | Every factual claim about the prospect maps to a `research_record` evidence URL |
| Capability | Every claim about Belline maps to a `sales.service.proof` entry |
| Vocabulary | Uses the vertical's own words (`patient`, not `guest`) — from `src/lib/verticals.ts` |
| Anti-template | Cosine similarity against the last 50 sent messages for that agent < 0.85; too similar and it goes to human review |
| Banned | "I hope this email finds you well", "revolutionary", "AI-powered", "cutting-edge", "leverage", em-dash-heavy openings, more than one exclamation mark |
| No pricing | Prices, contract terms and discounts are never generated. Ever. |

The message sells outcomes — fewer missed calls, more bookings, less front-desk
load, 24/7 cover, multilingual service — and does not explain the technology.
A dentist does not need to hear "cascaded speech pipeline".

### 3.4 Reply classifier

Input: inbound message + conversation history. Output: one of the eleven
categories, confidence, extracted questions/objections/referral target/revisit
date, and a recommended `action`.

Routing is deterministic from the category, not from the model's opinion:

| Category | Action |
| --- | --- |
| `OPT_OUT` | Write suppression, stop sequence, stage → `do_not_contact`. **Never** send a confirmation email — it is another message to someone who asked for none. |
| `BOUNCE` | Suppress address, mark contact invalid, requeue decision-maker discovery |
| `NOT_INTERESTED` | Stop sequence, stage → `lost` |
| `NOT_NOW` | Stop sequence, schedule revisit at extracted date or +90 days |
| `OOO` | Pause sequence until the extracted return date; no reply |
| `WRONG_PERSON` / `REFERRAL` | Create/queue new contact, restart at step 1 with a referral-aware opener |
| `HAS_QUESTION` | MODE 1/2: draft answer → human. MODE 3: auto-answer if the question maps to a `service.proof` entry, else escalate |
| `WANTS_PRICING` | **Always human.** No mode auto-answers pricing. |
| `INTERESTED` / `WANTS_DEMO` | Send demo access, stage → `interested`/`demo`, notify human |

### 3.5 Briefing agent

Before a meeting, produces the one-pager from stored data only:
**Who they are · Why they are a good lead · What they probably need · What has
been discussed · What to pitch.** No new research, no new claims — it is a
summary of `research_record`, `activity`, `message` and `lead_score`, so it
cannot introduce a fact the prospect has not already been told.

### 3.6 Manager / Director narrative agent

Reads the KPI rollup and cost table, writes the rationale on an
`agent_directive`. The *decision arithmetic* (is cost-per-meeting > 3× the
median?) is deterministic code; the model writes the explanation and ranks
options. This keeps "pause the Swiss restaurant agent" auditable.

---

## 4. What no agent may do

Hard boundaries, enforced in code rather than prompts:

- Write to the database directly. Every model output is a proposal.
- Quote a price, discount, contract length or SLA.
- Claim a customer, case study, integration or capability not in `service.proof`.
- Contact anyone matching a suppression row.
- Send outside the resolved `send_window` or above the frequency cap.
- Exceed the agent's remaining daily budget.
- Contact a company already held by another agent's active lead.
- Negotiate. Anything commercial goes to a human, in every mode.

---

## 5. Creating a new agent

No code. In `/sales/agents/new`:

1. Pick country (creates/uses the country manager) and vertical.
2. Pick languages, regions, Belline services.
3. Edit the ICP, scoring weights and research prompt — pre-filled from
   `vertical.default_icp` and the country's defaults.
4. Choose sequence and channels (limited to what the country manager permits).
5. Set budget (must fit inside the country's remaining allocation).
6. Save as `draft` → "Dry run 20 leads" → review the output → `active`.

Duplicating an existing agent into a new country copies everything except
country, language and compliance-derived channel restrictions, which are
re-resolved from the target country manager.
