# Belline Sales Engine — Compliance

> **This is an engineering specification, not legal advice.** It describes the
> controls the system enforces and why. The country rules below reflect the
> position as understood when this was written and each jurisdiction's rules
> change; **have local counsel confirm the profile for each country before that
> country's agent sends its first message**, and re-confirm annually. The
> `compliance_profile` on `sales.country` exists precisely so a lawyer's answer
> becomes a configuration change rather than a code change.

The uncomfortable summary: **cold outbound is legally easiest in the UAE,
harder in Saudi Arabia, and hardest in Switzerland** — which is the inverse of
what most people assume, and it should shape which agent you launch first.

---

## 1. Country profiles

### Switzerland — the strictest of the three

- **UWG Art. 3(1)(o)** makes mass advertising by telecommunications unfair
  competition unless there is **prior consent**, the sender is correctly
  identified, and a free, easy refusal option is offered. Breach is prosecutable
  on complaint. There is an existing-customer-relationship exception, which does
  not help with cold prospects.
- The **revised FADP** (in force since September 2023) governs personal data:
  transparency, purpose limitation, and a right to object. A named person's work
  email is personal data.
- The **star entry (`*`) in the phone directory** — calling a starred number for
  advertising is likewise unfair competition. Any Swiss calling must screen
  against it.

**What this means in practice:** the Swiss agent should default to
**LinkedIn-assisted outreach and phone (star-screened)**, not cold email. Where
email is used, the defensible position is an address the business publishes for
unsolicited business enquiries, a single message rather than a four-step
sequence, correct sender identification, and one-click opt-out. Confirm this
with Swiss counsel — Art. 3(1)(o) turns on "mass advertising", and how a
personalised B2B sequence is characterised is exactly the question worth paying
for an answer to.

Default profile: `email_requires_prior_consent: true`, `whatsapp: disabled`,
`max_sequence_steps: 2`, `phone_requires_dnc_screen: true`.

### United Arab Emirates

- **Federal Decree-Law No. 45 of 2021 (PDPL)** governs personal data; direct
  marketing to a data subject generally requires consent or a permitted basis,
  and the subject may object. Confirm the current status and detail of the
  Executive Regulations before relying on any specific reading.
- **TDRA** rules on unsolicited electronic communications require sender
  identification and a working opt-out.
- **Free zones matter**: businesses in DIFC and ADGM fall under their own
  GDPR-like data-protection laws (DIFC DP Law 2020, ADGM Data Protection
  Regulations 2021), which are stricter than the federal position. Many Dubai
  clinics and restaurants are free-zone entities — the country profile carries a
  `free_zone_stricter: true` flag, and where a company's address resolves to a
  free zone the stricter rules apply.

Default profile: `email_requires_prior_consent: false`,
`basis: 'legitimate_interest_business_contact'`, `whatsapp: consent_only`,
`max_sequence_steps: 4`.

### Saudi Arabia

- **PDPL (Royal Decree M/19 of 2021, amended 2023)**, enforced by SDAIA, is
  consent-forward: processing personal data for direct marketing generally
  requires consent, and there are restrictions on using personal data for
  marketing without it. Penalties are real.
- The **E-Commerce Law** and CITC rules constrain direct marketing separately.
- Data-transfer rules can require assessments for moving personal data out of
  the Kingdom — relevant because enrichment providers and email infrastructure
  are typically outside it. Worth a specific question to counsel: it may
  constrain which enrichment vendors the Saudi agent may use at all.

**Practical stance:** target the **company**, not the person. A message to
`info@clinic.sa` addressed to "the practice manager" is a materially different
risk from one to a named individual's personal work address sourced from a data
vendor. The Saudi agent defaults to company-level contacts and Arabic-first
communication.

Default profile: `prefer_company_level_contact: true`,
`person_level_requires_review: true`, `whatsapp: consent_only`,
`max_sequence_steps: 3`.

---

## 2. Controls the system enforces

### Suppression — permanent, global, checked twice

`sales.suppression` rows are **never deleted**. Matching is on email, domain,
phone and company id, and the check runs both at `personalise` time (so we do
not spend tokens) and again at `send` time (because approval may be hours old).

A suppression on a domain suppresses every contact at that company. An opt-out
from one agent suppresses the company for **all** agents in every country — the
prospect asked Belline to stop, not the UAE Dental Agent.

Sources: opt-out click, `List-Unsubscribe` POST, reply phrase match, hard
bounce, spam complaint, manual entry, legal request.

### Opt-out detection is deterministic, never a model judgement

Before the reply classifier sees anything, `replies/ingest.ts` checks for
unsubscribe-link clicks, `List-Unsubscribe-Post`, and a per-language phrase list
(`unsubscribe`, `remove me`, `take me off`, `stop`, `ألغ الاشتراك`, `توقف`,
`abmelden`, `keine weiteren`, `désinscrire`). A match is authoritative and
final. Asking an LLM whether someone *really* meant to opt out is not a question
this system asks.

**No opt-out confirmation email is ever sent.** Confirming an unsubscribe is one
more message to someone who just asked for none.

### Frequency caps

Enforced across all agents, all channels, all campaigns:

| Cap | Default |
| --- | --- |
| Messages per contact per sequence | 4 |
| Messages per company per 90 days | 6 |
| Days between touches to one contact | ≥ 2 |
| Re-approach a `lost`/`not now` company | ≥ 90 days, new campaign required |
| Concurrent agents per company | **1** (DB-enforced) |

The last is the `lead_one_active_per_company` partial unique index — a database
constraint rather than a policy, because two Belline emails in one week from two
"different" agents is the single most brand-damaging failure available to us.

### Channel gating per country

`channels` merges with `intersect` semantics down the hierarchy (AGENTS.md §2).
Disabling WhatsApp on the Switzerland Manager disables it for every Swiss
vertical agent, permanently, with no way for a child agent to re-enable it. A
channel can be killed globally from the Director in one edit — the control you
want on the day a regulator writes to you.

### Send windows

Local business hours in the *prospect's* timezone, weekday-aware per country
(the UAE and Saudi working week is Monday–Friday with Friday a partial day;
Saudi observes Ramadan hours). Configured per country, never inferred.
No sending on public holidays — a holiday calendar per country, seeded and
editable.

### Consent tracking

`sales.consent_record` stores the basis relied on for each company/contact and
channel: `legitimate_interest`, `published_business_address`, `opt_in`, or
`referral`, with evidence (the URL where the address was published, the
timestamp, the form submission). For Switzerland this record is a precondition
of sending, not an artefact of it — no record, no send.

### Data deletion

`deleteContactData()` (DATABASE.md, final section): suppress first, then redact
name, email, phone, LinkedIn, message bodies and any research text naming the
individual — keeping row shells, statuses and timestamps for audit. The
suppression row survives deletion, which is the only way "delete me" does not
become "contact me again next quarter".

Company-level business facts are retained as business data unless the company
itself requests suppression.

### Audit

`sales.audit_log` records every configuration change with before/after; every
approval, rejection and edit with the actor; every send with the resolved config
version; every suppression with source. `sales.activity` is the append-only lead
timeline. Between them, "why did this company receive this message on this date"
is answerable in one query — which is what a regulator, or a annoyed prospect's
lawyer, will ask.

---

## 3. No fabrication

The rule that protects the brand rather than the licence.

**About the prospect:** every factual claim in an outbound message must resolve
to an `evidence` entry in a `research_record`, with a URL that was actually
fetched. `outreach/guards.ts` extracts claims from the draft and checks them;
unverifiable claims fail the draft into human review. Signals the research agent
could not determine are stored as `null`, never `false` — "we could not tell
whether they have multiple branches" and "they do not have multiple branches"
lead to very different emails.

**About Belline:** every capability, integration, customer, result or comparison
must map to an entry in `sales.service.proof`. No case study that did not
happen, no client list, no "trusted by 200 clinics", no invented uptime figure.

**Pricing:** the agent never generates a price, discount, contract length, SLA
or commercial term, in any autonomy mode. `WANTS_PRICING` always escalates to a
human. This is not a prompt instruction — it is a guard that rejects drafts
containing currency amounts or contract vocabulary.

**Impersonation:** the personalised demo builds a Belline agent that answers as
the prospect's own business. It carries an on-page disclosure, a spoken
disclosure in the first breath, a hard daily call cap, and a 14-day expiry after
which the page is deleted rather than hidden. These are already implemented in
`src/lib/prospect.ts` and `src/lib/demo.ts` and must not be relaxed as demo
volume grows.

---

## 4. Deliverability as a compliance surface

Not law, but the same category of risk: a domain burned by complaints is as
disabling as a regulator's letter, and the remedy is slower.

- Cold outbound never leaves `belline.ai`. Separate sending domains only.
- SPF, DKIM and DMARC on every sending domain; DMARC `p=none` → `quarantine`.
- 4–6 week warmup per mailbox before real sending; ramp enforced in code by the
  mailbox daily cap, not by discipline.
- `List-Unsubscribe` and `List-Unsubscribe-Post` headers on every message.
- Physical sender address and correct legal identification in the footer.
- Automatic pause of a sending domain when bounce rate > 3% or complaint rate >
  0.1% over a rolling 500 sends — measured in `message`, enforced by the send
  guard.

---

## 5. Launch gate

An agent may not move from `draft` to `active` until:

- [ ] Country `compliance_profile` reviewed and signed off by local counsel
- [ ] Sending domain authenticated (SPF/DKIM/DMARC verified) and warmed
- [ ] Suppression list imported (existing contacts, competitors, customers,
      personal contacts, anyone who has ever said no)
- [ ] Opt-out path tested end to end, in every language the agent uses
- [ ] `service.proof` populated — the agent has claims it is allowed to make
- [ ] Send window and holiday calendar set for the country
- [ ] Budget caps set, with automatic pause verified
- [ ] A dry run of 20 leads reviewed by a human, message by message

The gate is enforced in code: `/sales/agents/[id]` refuses activation with an
unchecked list, and the checklist state is stored on the agent.
