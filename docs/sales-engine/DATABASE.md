# Belline Sales Engine — Database

Postgres. Own schema (`sales`), additive to the existing JSON-file store. Plain
SQL through one repository module per entity; numbered migrations in
`src/lib/sales/db/migrations/`.

Three conventions run through everything below:

1. **Config is versioned, evidence is immutable, state is derived.**
   `research_record`, `lead_score`, `message` and `activity` are append-only.
   `lead.stage` and `lead.current_score` are caches of the latest row, updated
   by application code in the same transaction. You can always answer "why did
   we say that to them in March" — which matters when a prospect asks.

2. **Money is `numeric(14,4)` and always carries a currency.** Three countries,
   three currencies, and MRR reported in one. Never floats.

3. **Timestamps are `timestamptz`.** Unlike the booking engine — which
   deliberately stores wall-clock minutes because a 19:30 reservation is 19:30
   locally — sales events are instants across four timezones and compare
   globally.

---

## Reference and configuration

```sql
create schema if not exists sales;

create table sales.country (
  code               char(2) primary key,           -- AE, SA, CH
  name               text not null,
  default_languages  text[] not null,               -- ['en','ar']
  default_timezone   text not null,
  currency           char(3) not null,
  compliance_profile jsonb not null default '{}',   -- see COMPLIANCE.md
  created_at         timestamptz not null default now()
);

create table sales.region (                          -- cities / emirates / cantons
  id           bigserial primary key,
  country_code char(2) not null references sales.country(code),
  name         text not null,
  kind         text not null default 'city',
  unique (country_code, name)
);

create table sales.vertical (
  slug        text primary key,                     -- dentists, clinics, salons, restaurants
  name        text not null,
  parent_slug text references sales.vertical(slug), -- sub-verticals: orthodontists -> dentists
  terms       jsonb not null default '{}',          -- patient/client/guest, mirrors src/lib/verticals.ts
  default_icp jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- What Belline sells. Configurable, never hardcoded into agent logic.
create table sales.service (
  slug        text primary key,                     -- missed_call_recovery, after_hours, booking…
  name        text not null,
  description text not null,
  verticals   text[] not null default '{}',         -- empty = applies everywhere
  proof       jsonb not null default '[]',          -- claims we are allowed to make, with sources
  active      boolean not null default true
);
```

`service.proof` is deliberate: it is the only place an outreach message may draw
a capability claim from. If it is not in here with a source, the agent may not
say it. See COMPLIANCE.md §"No fabrication".

---

## Agents

One table for all three levels of the hierarchy.

```sql
create type sales.agent_kind   as enum ('director','country_manager','vertical_agent');
create type sales.agent_status as enum ('draft','active','paused','archived');
create type sales.autonomy     as enum ('review','semi','autonomous');   -- MODE 1/2/3

create table sales.agent (
  id             bigserial primary key,
  kind           sales.agent_kind not null,
  parent_id      bigint references sales.agent(id),
  name           text not null,                     -- "UAE Dental Agent"
  country_code   char(2) references sales.country(code),   -- null only for director
  vertical_slug  text    references sales.vertical(slug),  -- null above vertical level
  regions        text[] not null default '{}',      -- ['Dubai','Abu Dhabi']
  languages      text[] not null default '{}',      -- ['en','ar']
  status         sales.agent_status not null default 'draft',
  autonomy_mode  sales.autonomy not null default 'review',
  config         jsonb not null default '{}',       -- ICP, qualification, research prompt,
                                                    -- outreach strategy, scoring weights
  daily_budget   numeric(14,4),
  monthly_budget numeric(14,4),
  budget_currency char(3) not null default 'USD',
  paused_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index agent_scope_uq
  on sales.agent (country_code, vertical_slug)
  where kind = 'vertical_agent' and status <> 'archived';

create index agent_parent_ix on sales.agent(parent_id);

-- Every config change is recoverable and attributable.
create table sales.agent_config_version (
  id         bigserial primary key,
  agent_id   bigint not null references sales.agent(id),
  version    int not null,
  config     jsonb not null,
  changed_by text not null,                          -- user id, or 'system'
  note       text,
  created_at timestamptz not null default now(),
  unique (agent_id, version)
);

-- Manager/Director output: a proposal, never a silent write.
create table sales.agent_directive (
  id           bigserial primary key,
  from_agent   bigint not null references sales.agent(id),
  target_agent bigint not null references sales.agent(id),
  kind         text not null,        -- pause, resume, reallocate_budget, change_channel…
  rationale    text not null,
  diff         jsonb not null,
  evidence     jsonb not null default '[]',
  status       text not null default 'proposed',     -- proposed|approved|rejected|applied
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table sales.campaign (
  id          bigserial primary key,
  agent_id    bigint not null references sales.agent(id),
  name        text not null,
  sequence_id bigint,                                 -- fk added after sequence table
  status      text not null default 'active',
  starts_at   timestamptz,
  ends_at     timestamptz,
  created_at  timestamptz not null default now()
);
```

---

## Companies, contacts, leads

The distinction that keeps the model honest: a **company** is a fact about the
world and exists once. A **lead** is one agent's pursuit of that company. Two
agents cannot both be pursuing the same company at once.

```sql
create table sales.company (
  id               bigserial primary key,
  name             text not null,
  legal_name       text,
  vertical_slug    text references sales.vertical(slug),
  sub_vertical     text,
  country_code     char(2) references sales.country(code),
  city             text,
  address          text,
  website          text,
  domain           text,                       -- normalised: lowercase, no www
  phone            text,
  phone_e164       text,                       -- normalised
  email            text,                       -- generic/company-level
  company_size     text,
  location_count   int,
  opening_hours    jsonb,
  rating           numeric(2,1),
  review_count     int,
  socials          jsonb not null default '{}',
  booking_url      text,
  booking_provider text,
  has_whatsapp     boolean,
  contact_workflow text,                       -- 'phone_only','online_booking','whatsapp',…
  source           text,                       -- connector slug
  source_url       text,
  status           text not null default 'active',   -- active|closed|irrelevant|do_not_contact
  discovered_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Dedup. Aggressive by design: three independent keys, any hit is a match.
create unique index company_domain_uq on sales.company(domain)     where domain is not null;
create unique index company_phone_uq  on sales.company(phone_e164) where phone_e164 is not null;
create index company_namecity_ix on sales.company
  (lower(regexp_replace(name,'[^a-z0-9]','','gi')), country_code, city);
create index company_vertical_ix on sales.company(country_code, vertical_slug, status);

create table sales.company_location (
  id              bigserial primary key,
  company_id      bigint not null references sales.company(id) on delete cascade,
  label           text,
  address         text,
  city            text,
  phone_e164      text,
  lat             numeric(9,6),
  lng             numeric(9,6),
  external_id     text,                        -- google place_id etc.
  opening_hours   jsonb,
  created_at      timestamptz not null default now()
);
create unique index company_location_ext_uq
  on sales.company_location(external_id) where external_id is not null;

create table sales.contact (
  id            bigserial primary key,
  company_id    bigint not null references sales.company(id) on delete cascade,
  full_name     text,
  title         text,
  role_class    text,                          -- owner|founder|md|gm|ops|practice_mgr|marketing
  email         text,
  email_status  text,                          -- unverified|valid|risky|invalid|catch_all
  phone_e164    text,
  linkedin_url  text,
  language      text,
  source        text not null,
  source_url    text,
  confidence    numeric(3,2) not null default 0.5,   -- 0–1
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now()
);
create unique index contact_email_uq on sales.contact(lower(email)) where email is not null;
create index contact_company_ix on sales.contact(company_id);
```

### Lead — the join, and the dedup guarantee

```sql
create type sales.lead_stage as enum (
  'discovered','researching','qualified','contacted','follow_up','replied',
  'interested','demo','meeting_booked','pilot','customer','lost','do_not_contact'
);
create type sales.priority as enum ('hot','warm','low');

create table sales.lead (
  id             bigserial primary key,
  company_id     bigint not null references sales.company(id),
  agent_id       bigint not null references sales.agent(id),
  campaign_id    bigint references sales.campaign(id),
  contact_id     bigint references sales.contact(id),
  stage          sales.lead_stage not null default 'discovered',
  current_score  int,                                 -- cache of latest lead_score
  priority       sales.priority,
  language       text,
  owner_user_id  text,                                -- set on human handoff
  next_action_at timestamptz,
  stage_changed_at timestamptz not null default now(),
  closed_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- §1: "Do not contact the same company twice through different agents."
-- One live pursuit per company, globally, across every agent and country.
create unique index lead_one_active_per_company
  on sales.lead(company_id)
  where stage not in ('lost','do_not_contact');

create index lead_agent_stage_ix on sales.lead(agent_id, stage);
create index lead_due_ix on sales.lead(next_action_at) where next_action_at is not null;
```

That partial index is the single most important line in this file. Collisions
surface as an insert failure, which the discovery handler resolves by writing a
`lead_claim_conflict` row for the country manager to arbitrate rather than by
silently dropping the lead.

```sql
create table sales.lead_claim_conflict (
  id            bigserial primary key,
  company_id    bigint not null references sales.company(id),
  holding_lead  bigint not null references sales.lead(id),
  claiming_agent bigint not null references sales.agent(id),
  resolution    text,                                 -- keep|transfer|allow_both
  resolved_by   text,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);
```

---

## Research and scoring — append-only

```sql
create table sales.research_record (
  id            bigserial primary key,
  company_id    bigint not null references sales.company(id),
  agent_id      bigint not null references sales.agent(id),
  summary       text not null,                        -- "Why a good prospect" 3–5 sentences
  signals       jsonb not null default '{}',          -- typed signal → value
  use_cases     text[] not null default '{}',         -- references sales.service.slug
  evidence      jsonb not null default '[]',          -- [{claim, url, quote, fetched_at}]
  pages_read    text[] not null default '{}',
  model         text not null,
  prompt_hash   text not null,
  cost_usd      numeric(14,6),
  created_at    timestamptz not null default now()
);
create index research_company_ix on sales.research_record(company_id, created_at desc);

create table sales.lead_score (
  id           bigserial primary key,
  lead_id      bigint not null references sales.lead(id) on delete cascade,
  score        int not null check (score between 0 and 100),
  priority     sales.priority not null,
  breakdown    jsonb not null,       -- [{signal, weight, value, points}] — fully explainable
  reason       text not null,
  model_version text not null,       -- hash of the scoring config used
  created_at   timestamptz not null default now()
);
create index lead_score_lead_ix on sales.lead_score(lead_id, created_at desc);
```

`breakdown` being a full arithmetic trace is what makes scoring debuggable and
tunable. Scoring itself is **deterministic code over stored signals** — the LLM
extracts signals, it does not assign points.

---

## Outreach

```sql
create type sales.channel   as enum ('email','linkedin','whatsapp','phone','sms');
create type sales.direction as enum ('outbound','inbound');
create type sales.msg_status as enum (
  'draft','pending_approval','approved','rejected','queued','sending','sent',
  'delivered','opened','clicked','replied','bounced','failed','cancelled'
);

create table sales.sequence (
  id          bigserial primary key,
  name        text not null,
  scope       jsonb not null default '{}',    -- {country, vertical, language} — any may be null
  steps       jsonb not null,                 -- [{day, channel, template_key, purpose}]
  stop_on     text[] not null default '{replied,opted_out,meeting_booked,bounced,irrelevant}',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table sales.campaign
  add constraint campaign_sequence_fk foreign key (sequence_id) references sales.sequence(id);

create table sales.sequence_enrollment (
  id            bigserial primary key,
  lead_id       bigint not null references sales.lead(id) on delete cascade,
  sequence_id   bigint not null references sales.sequence(id),
  current_step  int not null default 0,
  next_due_at   timestamptz,
  status        text not null default 'active',   -- active|stopped|completed
  stopped_reason text,
  created_at    timestamptz not null default now()
);
create unique index enrollment_active_uq
  on sales.sequence_enrollment(lead_id) where status = 'active';
create index enrollment_due_ix
  on sales.sequence_enrollment(next_due_at) where status = 'active';

create table sales.conversation (
  id          bigserial primary key,
  lead_id     bigint not null references sales.lead(id) on delete cascade,
  channel     sales.channel not null,
  thread_key  text not null,                    -- RFC5322 References root, or provider thread id
  subject     text,
  last_at     timestamptz,
  created_at  timestamptz not null default now()
);
create unique index conversation_thread_uq on sales.conversation(channel, thread_key);

create table sales.message (
  id              bigserial primary key,
  lead_id         bigint not null references sales.lead(id) on delete cascade,
  conversation_id bigint references sales.conversation(id),
  contact_id      bigint references sales.contact(id),
  agent_id        bigint not null references sales.agent(id),
  sequence_step   int,
  channel         sales.channel not null,
  direction       sales.direction not null,
  status          sales.msg_status not null,
  language        text not null,
  to_address      text,
  from_address    text,
  subject         text,
  body            text not null,
  personalisation jsonb not null default '{}',  -- {observation, problem, solution, cta, evidence[]}
  template_key    text,
  provider        text,
  provider_msg_id text,
  approved_by     text,
  approved_at     timestamptz,
  rejected_reason text,
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  opened_at       timestamptz,
  replied_at      timestamptz,
  bounce_type     text,
  error           text,
  cost_usd        numeric(14,6),
  created_at      timestamptz not null default now()
);
create index message_approval_ix on sales.message(status, created_at)
  where status = 'pending_approval';
create index message_lead_ix on sales.message(lead_id, created_at);
create unique index message_provider_uq
  on sales.message(provider, provider_msg_id) where provider_msg_id is not null;

create table sales.reply_classification (
  id          bigserial primary key,
  message_id  bigint not null references sales.message(id) on delete cascade,
  category    text not null,      -- INTERESTED|WANTS_DEMO|WANTS_PRICING|HAS_QUESTION|
                                  -- NOT_NOW|NOT_INTERESTED|OPT_OUT|REFERRAL|
                                  -- WRONG_PERSON|OOO|BOUNCE
  confidence  numeric(3,2) not null,
  extracted   jsonb not null default '{}',   -- {questions[], objections[], referral_to, revisit_at}
  action      text not null,                 -- auto_reply|escalate|stop|reschedule
  model       text not null,
  created_at  timestamptz not null default now()
);
```

---

## Calls, demos, meetings, revenue

```sql
create table sales.sales_call (
  id           bigserial primary key,
  lead_id      bigint not null references sales.lead(id) on delete cascade,
  contact_id   bigint references sales.contact(id),
  direction    sales.direction not null,
  provider     text,
  provider_sid text,
  from_number  text,
  to_number    text,
  started_at   timestamptz,
  ended_at     timestamptz,
  duration_sec int,
  outcome      text,
  transcript   jsonb,
  summary      text,
  cost_usd     numeric(14,6)
);

-- Requirement §9. Bridges to the existing prospect-demo machinery.
create table sales.demo (
  id            bigserial primary key,
  lead_id       bigint not null references sales.lead(id) on delete cascade,
  kind          text not null,          -- personalised_link | vertical_number
  -- For personalised_link: the Location.prospect.slug in the existing JSON store.
  location_slug text,
  phone_number  text,
  script_hint   text not null,          -- "Call and ask to book a cleaning."
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  first_used_at timestamptz,
  use_count     int not null default 0,
  total_seconds int not null default 0,
  call_ids      text[] not null default '{}'    -- ids in the voice product's calls.json
);
create index demo_lead_ix on sales.demo(lead_id);

create table sales.meeting (
  id            bigserial primary key,
  lead_id       bigint not null references sales.lead(id) on delete cascade,
  contact_id    bigint references sales.contact(id),
  provider      text,
  provider_event_id text,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  timezone      text not null,
  status        text not null default 'scheduled',   -- scheduled|held|no_show|cancelled
  join_url      text,
  briefing_md   text,                                 -- the one-page pre-meeting brief
  outcome_notes text,
  created_at    timestamptz not null default now()
);

create table sales.opportunity (
  id            bigserial primary key,
  lead_id       bigint not null references sales.lead(id),
  services      text[] not null default '{}',
  locations     int not null default 1,
  mrr_estimate  numeric(14,4),
  setup_fee     numeric(14,4),
  currency      char(3) not null,
  stage         text not null default 'open',     -- open|pilot|won|lost
  expected_close date,
  closed_at     timestamptz,
  lost_reason   text,
  created_at    timestamptz not null default now()
);

create table sales.customer (
  id             bigserial primary key,
  company_id     bigint not null references sales.company(id),
  opportunity_id bigint references sales.opportunity(id),
  mrr            numeric(14,4) not null,
  currency       char(3) not null,
  mrr_usd        numeric(14,4) not null,          -- normalised for cross-country reporting
  started_at     date not null,
  churned_at     date,
  -- Closes the loop into the voice product: which Location ids this became.
  location_ids   text[] not null default '{}',
  created_at     timestamptz not null default now()
);
```

`customer.location_ids` is the join back to the existing product's
`data/locations.json`. It is what makes "UAE Dental Agent generated AED 42,000
MRR" a query rather than a spreadsheet.

---

## Governance, cost, operations

```sql
create table sales.suppression (
  id          bigserial primary key,
  scope       text not null default 'global',   -- global|country|agent
  scope_id    text,
  match_type  text not null,                    -- email|domain|phone|company_id
  value       text not null,
  reason      text not null,                    -- opt_out|bounce|complaint|manual|legal
  source      text,
  created_by  text,
  created_at  timestamptz not null default now()
);
create unique index suppression_uq on sales.suppression(scope, coalesce(scope_id,''), match_type, lower(value));
create index suppression_lookup_ix on sales.suppression(match_type, lower(value));
-- Rows are never deleted. An opt-out is permanent.

create table sales.consent_record (
  id          bigserial primary key,
  company_id  bigint references sales.company(id),
  contact_id  bigint references sales.contact(id),
  country_code char(2) not null,
  basis       text not null,          -- legitimate_interest|published_business_address|opt_in|referral
  evidence    jsonb not null default '{}',
  channel     sales.channel not null,
  recorded_at timestamptz not null default now()
);

-- The lead timeline. Every action, forever.
create table sales.activity (
  id         bigserial primary key,
  lead_id    bigint references sales.lead(id) on delete cascade,
  company_id bigint references sales.company(id),
  agent_id   bigint references sales.agent(id),
  actor      text not null,           -- agent:12 | user:usr_abc | system
  type       text not null,           -- discovered|researched|scored|drafted|approved|sent|
                                      -- opened|replied|classified|demo_used|meeting_booked|
                                      -- stage_changed|suppressed|error
  summary    text not null,
  data       jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index activity_lead_ix on sales.activity(lead_id, at desc);
create index activity_type_ix on sales.activity(type, at desc);

create table sales.audit_log (
  id         bigserial primary key,
  actor      text not null,
  action     text not null,
  entity     text not null,
  entity_id  text not null,
  before     jsonb,
  after      jsonb,
  ip         text,
  at         timestamptz not null default now()
);

create table sales.agent_run (
  id          bigserial primary key,
  agent_id    bigint not null references sales.agent(id),
  stage       text not null,
  trigger     text not null,            -- manual|schedule|cascade
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  status      text not null default 'running',
  stats       jsonb not null default '{}',
  error       text
);

create table sales.cost_event (
  id         bigserial primary key,
  agent_id   bigint references sales.agent(id),
  lead_id    bigint references sales.lead(id) on delete set null,
  run_id     bigint references sales.agent_run(id),
  category   text not null,     -- discovery|enrichment|llm|email_verify|email_send|
                                -- voice|whatsapp|calendar|other
  provider   text not null,
  units      numeric(14,4) not null default 1,
  unit_label text,              -- tokens|requests|minutes|messages
  amount_usd numeric(14,6) not null,
  at         timestamptz not null default now()
);
create index cost_agent_ix on sales.cost_event(agent_id, at desc);
create index cost_category_ix on sales.cost_event(category, at desc);

create table sales.integration (
  id          bigserial primary key,
  provider    text not null unique,
  kind        text not null,           -- discovery|enrichment|email|calendar|voice|whatsapp
  status      text not null default 'inactive',
  config      jsonb not null default '{}',   -- never secrets: env var names only
  last_ok_at  timestamptz,
  last_error  text
);

create table sales.source (
  id          bigserial primary key,
  slug        text not null unique,
  kind        text not null,
  config      jsonb not null default '{}',
  active      boolean not null default true
);

create table sales.rate_limit (
  key         text primary key,        -- provider:google_places | mailbox:sales@getbelline.com
  window_sec  int not null,
  max_units   int not null,
  used        int not null default 0,
  window_start timestamptz not null default now()
);

create table sales.job (
  id              bigserial primary key,
  type            text not null,
  payload         jsonb not null default '{}',
  agent_id        bigint references sales.agent(id),
  priority        int not null default 100,
  run_at          timestamptz not null default now(),
  attempts        int not null default 0,
  max_attempts    int not null default 5,
  status          text not null default 'pending',   -- pending|running|done|failed|dead
  locked_by       text,
  locked_at       timestamptz,
  idempotency_key text unique,
  last_error      text,
  created_at      timestamptz not null default now()
);
create index job_claim_ix on sales.job(status, run_at, priority)
  where status = 'pending';
```

---

## Reporting

KPI queries run against a materialised view refreshed every few minutes rather
than against the raw tables, because the dashboard slices by six dimensions.

```sql
create materialized view sales.kpi_daily as
select
  date_trunc('day', a.at)                          as day,
  ag.id            as agent_id,
  ag.country_code, ag.vertical_slug,
  c.city,
  m.channel, m.language,
  l.campaign_id,
  count(*) filter (where a.type = 'discovered')     as leads_found,
  count(*) filter (where a.type = 'scored'
                     and (a.data->>'priority') in ('hot','warm')) as qualified,
  count(*) filter (where a.type = 'sent')           as messages_sent,
  count(*) filter (where a.type = 'replied')        as replies,
  count(*) filter (where a.type = 'replied'
                     and (a.data->>'category') in
                         ('INTERESTED','WANTS_DEMO','WANTS_PRICING')) as positive_replies,
  count(*) filter (where a.type = 'demo_used')      as demos_used,
  count(*) filter (where a.type = 'meeting_booked') as meetings
from sales.activity a
join sales.agent ag  on ag.id = a.agent_id
left join sales.lead l on l.id = a.lead_id
left join sales.company c on c.id = a.company_id
left join sales.message m on m.id = (a.data->>'message_id')::bigint
group by 1,2,3,4,5,6,7,8;

create unique index kpi_daily_uq on sales.kpi_daily
  (day, agent_id, coalesce(city,''), coalesce(channel::text,''),
   coalesce(language,''), coalesce(campaign_id,0));
```

Revenue and cost-per-X come from `customer`, `opportunity` and `cost_event`
joined on `agent_id`, computed on demand — low cardinality, no view needed.

Derived metrics:

```
cost_per_lead            = sum(cost_event) / count(lead)
cost_per_qualified_lead  = sum(cost_event) / count(lead where priority in hot,warm)
cost_per_meeting         = sum(cost_event) / count(meeting)
cost_per_customer        = sum(cost_event) / count(customer)
```

Each is scoped by the same six dimensions, so "what does a Swiss dental meeting
cost us versus a UAE one" is one query.

---

## Data-deletion controls

A deletion request (GDPR/FADP Art. 32, PDPL) must remove personal data while
preserving the suppression record — otherwise deleting someone means we contact
them again next month.

`deleteContactData(contact_id)` in one transaction:

1. Insert `suppression` rows for the email and phone (`reason = 'legal'`) — this
   survives everything.
2. Null out `contact.full_name`, `email`, `phone_e164`, `linkedin_url`.
3. Redact `message.body`, `subject`, `to_address` for that contact; keep row,
   status and timestamps for audit.
4. Redact `research_record.summary`/`evidence` entries naming the individual;
   company-level facts stay.
5. Write an `audit_log` row.

Company-level records are business data, not personal data, and are retained
unless the company itself is suppressed.
