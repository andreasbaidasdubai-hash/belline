# Belline Sales Engine — Pipeline

Thirteen stages. Each is a job type with one handler in
`src/lib/sales/queue/handlers/`, an idempotency key, and a defined failure mode.
Stages communicate only through the database — no handler calls another
directly, so any stage can be replayed, paused or rate-limited on its own.

```
 discover ─► enrich ─► research ─► decision_maker ─► score
                                                       │
                              ┌────────────────────────┘
                              ▼
                        personalise ─► approve ─► send ─► follow_up
                                                            │
                         ┌──────────────────────────────────┘
                         ▼
                  classify_reply ─► qualify ─► book_meeting ─► handoff
                                        │
                                        └─► crm (stage transitions, continuous)
```

---

## Stage 1 — `discover`

**Input** agent config (country, regions, vertical, ICP filters).
**Providers** modular, behind one interface:

```ts
export interface LeadSourceProvider {
  readonly slug: string;
  readonly costPerResultUsd: number;
  search(q: DiscoveryQuery): AsyncIterable<RawCompany>;
}

export interface DiscoveryQuery {
  countryCode: string; regions: string[]; vertical: string;
  keywords: string[]; limit: number; cursor?: string;
}
```

Phase 1 ships `csv` (manual import) and `google_places`. `apollo`, `linkedin`,
`directory` and `website_crawl` are the same interface later.

**Dedup**, before any write:

1. Normalise — domain lowercased with `www.` and trailing slash stripped; phone
   to E.164 using the country dial code; name lowercased, non-alphanumerics
   removed, legal suffixes (`llc`, `fz-llc`, `ag`, `gmbh`, `sarl`) dropped.
2. Match on domain → phone → (name + country + city) in that order.
3. On match: merge new non-null fields into the existing company, append a
   `source` entry, do **not** create a second row.
4. Claim a lead. If `lead_one_active_per_company` rejects it, write a
   `lead_claim_conflict` and stop — another agent already owns this company.

**Output** `company` rows, `lead` rows at stage `discovered`, `activity`.
**Cost** metered per provider result.
**Idempotency** `discover:{agent}:{provider}:{query_hash}:{page}`.

---

## Stage 2 — `enrich`

Fills what discovery could not: generic email, socials, booking provider,
WhatsApp presence, size, opening hours. Email verification runs here so we never
spend research tokens on a company we cannot reach.

Order matters and is cost-driven: free signals (website `mailto:`, schema.org
JSON-LD, WhatsApp `wa.me` links) before paid providers. A company failing
`qualification_rules.require_contactable` stops here at stage `discovered` and
never reaches the research agent — research is the expensive stage.

---

## Stage 3 — `research`

Reuses `src/lib/prospect.ts` for fetching: `assertPublicUrl()` (SSRF guard) then
`readSite()`. The crawler adds a shallow link-follower — home, plus up to five
of `/about`, `/services`, `/treatments`, `/team`, `/contact`, `/book`,
`/opening-hours` — matched by URL pattern and link text, same-origin only,
capped at 6 fetches and 60 s per company.

Then one LLM call (AGENTS.md §3.1) producing `summary`, typed `signals`,
`use_cases`, `evidence`.

Post-checks in code, not prompt:

- Drop any evidence URL not in `pages_read`.
- Coerce unevidenced signals to `null` (unknown ≠ false).
- Drop `use_cases` outside the agent's configured services.
- Persist as an immutable `research_record`; never overwrite an earlier one.

**Failure modes** site 403s or is JS-only → record a `research_record` with
`signals` all null and `summary` naming the gap; the lead can still be scored
from discovery data alone, at a lower ceiling. Never fabricate to fill the hole.

---

## Stage 4 — `decision_maker`

Candidates from: team/about pages read in stage 3, enrichment providers,
LinkedIn data provider. The LLM ranks against the configured priority list and
assigns confidence. Guessed email patterns only survive if verification says
`valid`. No individual found → fall back to the company-level address, and mark
the lead so the personaliser writes to a role rather than a name.

---

## Stage 5 — `score`

**Deterministic. No LLM.** The model extracted signals in stage 3; scoring is
arithmetic over those signals with the agent's configured weights.

```
raw   = Σ weight[signal] × value(signal)   +   Σ penalty[signal]
score = clamp(round(raw), 0, 100)
priority = score ≥ bands.hot ? 'hot' : score ≥ bands.warm ? 'warm' : 'low'
```

`value(signal)` is 1/0 for booleans, and a documented normalisation for counts
(e.g. `review_volume` = `min(review_count / 200, 1)`). `null` signals score
zero rather than a penalty.

`lead_score.breakdown` stores every term of that sum, so the dashboard can show
"85 — multi-location (+15), phone-first booking (+15), 340 reviews (+12),
demo used (+20)…" and a weight change can be re-run over history.

Only `score ≥ qualification_rules.min_score_to_contact` proceeds. Everything
else parks at `qualified`/`low` and stays in the database — a low score today is
a candidate after a config change, not a deletion.

**Rescoring** is a separate job. Changing weights re-runs scoring over stored
signals with no new LLM spend.

---

## Stage 6 — `personalise`

One LLM call producing the four-part message (AGENTS.md §3.3), then
`outreach/guards.ts` runs every check. A draft failing a guard is not discarded
— it is stored with `status='draft'` and the failure reason, and surfaces in the
approval queue flagged, because a pattern of failures is how we find out the
prompt has drifted.

Template selection: `templates.ts` resolves `(country, vertical, language,
channel)` with fallback `exact → country+language → language → default`. The
template supplies the frame — greeting form, sign-off, disclosure line,
unsubscribe footer — and the model supplies the four personalised parts. Never
the other way round.

Language choice: `contact.language` → advertised languages from research →
agent `default_language`.

---

## Stage 7 — `approve`

MODE 1's centre of gravity, and the page you will live in during Phase 1.

`/sales/approvals` shows, per draft: the message, the four personalisation
parts with their evidence links, the research summary, the score breakdown, the
company card, and any guard warnings. Actions: **Approve**, **Edit & approve**,
**Reject** (with reason), **Reject & suppress**.

Every edit is stored as a diff against the model's draft. That corpus is the
highest-value training signal in the system — after a hundred edits you know
exactly where the personaliser is wrong, and it feeds the prompt revision.

Bulk approve exists but shows the same guard warnings and refuses to bulk-approve
anything flagged.

In MODE 2/3 this stage auto-passes for unflagged drafts and still routes flagged
ones to a human. The stage is never skipped; only its decider changes.

---

## Stage 8 — `send`

Pre-send guards, re-checked at send time (approval may be hours old):

1. Suppression — email, domain, phone, company.
2. Frequency cap — per company and per contact, across **all** agents.
3. Country channel permission and consent requirement.
4. Send window in the prospect's timezone.
5. Mailbox daily cap and warmup ramp.
6. Agent budget remaining.
7. Provider rate limit.

Failing 1–3 cancels the message permanently. Failing 4–7 reschedules it.

Then the channel connector:

```ts
export interface OutreachChannel {
  readonly slug: 'email'|'linkedin'|'whatsapp'|'phone'|'sms';
  readonly requiresPriorConsent: boolean;
  send(m: OutboundMessage): Promise<SendResult>;   // { providerMessageId, threadKey, costUsd }
  supports(country: string): boolean;
}
```

Email is Phase 1. LinkedIn is **assisted** — `send()` creates a human task with
the drafted text and the profile URL rather than automating the platform.
WhatsApp requires an approved template and a consent record. Phone hands off to
the existing Belline voice stack in Phase 3.

**Idempotency** `send:{message_id}`. The provider message id is written before
the status flips to `sent`, so a crash between the API call and the DB write
cannot double-send on retry.

---

## Stage 9 — `follow_up`

Sequence steps from `sales.sequence`. Default `gulf-dental-v1`:

| Day | Channel | Purpose |
| --- | --- | --- |
| 1 | email | Personalised first contact |
| 3 | email | One concrete Belline use case for their situation |
| 7 | email | Offer the live demo — "call it yourself" |
| 14 | email | Short, polite close-out |

A worker sweeps `sequence_enrollment` where `next_due_at <= now()` and enqueues
`personalise` for the next step. Follow-ups are personalised too — same guards,
lower token budget, and each one must reference the previous message rather than
restating it.

**Stop conditions**, checked before every step: replied, opted out, meeting
booked, asked not to be contacted, bounced, company marked irrelevant, agent
paused, budget exhausted. Stops are recorded with a reason on the enrollment.

Send-window and cap rules apply to follow-ups identically — a follow-up is a
cold email too.

---

## Stage 10 — `classify_reply`

Ingestion by provider webhook where available, IMAP poll otherwise. Threading by
`References`/`In-Reply-To` into `conversation.thread_key`; unmatched replies are
matched by from-address against recent recipients and flagged if ambiguous.

**Opt-out detection runs before the classifier**, deterministically: unsubscribe
link click, `List-Unsubscribe` POST, and a phrase list per language
(`unsubscribe`, `remove me`, `stop`, `ألغِ الاشتراك`, `abmelden`, `désinscrire`).
A regex match is authoritative — we do not ask a model whether someone meant it.

Then the classifier (AGENTS.md §3.4) and the deterministic routing table.

---

## Stage 11 — `qualify`

Deterministic against `qualification_rules`, evaluated over the whole
conversation: is this a real decision-maker, is there a stated need matching a
configured service, is there no disqualifier (wrong country, competitor,
agency reseller, already a customer)?

Qualified → stage `interested`, notify the human, generate the briefing. Not
qualified → back into the sequence or to `lost` with a reason.

The AI does not negotiate. Pricing, contract terms and anything unusual go to a
human in every autonomy mode.

---

## Stage 12 — `book_meeting`

Send a booking link (Cal.com/Google) or offered slots. On booking, capture the
full context required by requirement §11 and generate the one-page briefing
(AGENTS.md §3.5) from stored records only. Reminder job at T-24h and T-1h;
no-show at T+30min moves the lead back into a nurture sequence rather than to
`lost`.

**Demo tracking** feeds this stage. A `sales.demo` row is issued when a prospect
is offered "call Belline yourself" — either a personalised link built by the
existing `createProspectDemo()` machinery, or a per-vertical demo number with a
script hint ("call and ask to book a cleaning"). First use writes
`activity: demo_used`, adds the configured `demo_used` weight to the score, and
notifies the human immediately — a prospect who just dialled the product is the
warmest they will ever be, and the follow-up should land within the hour.

---

## Stage 13 — `handoff`

Lead ownership passes to a person: `lead.owner_user_id` set, the AI stops
sending on that thread, the briefing is attached, and the timeline is presented
as one page. Everything before this point is automated; nothing after it is.

`crm` stage transitions run continuously alongside every stage, writing
`activity` rows. Stage changes are made by application code from observed
events, never by a model.

---

## Replay, retries and failure

- Every handler is idempotent by key; a retry after a partial write is safe.
- Retries use exponential backoff to `max_attempts`, then `dead` with the error
  retained. Dead jobs surface on `/sales/settings` — a silent dead-letter queue
  is how a pipeline stops working without anyone noticing.
- Provider outages fail the stage, not the lead: the lead keeps its position and
  resumes when the provider returns.
- Any stage can be re-run for one lead from its detail page, which is how you
  debug a bad draft — fix the config, re-run `personalise`, compare.
