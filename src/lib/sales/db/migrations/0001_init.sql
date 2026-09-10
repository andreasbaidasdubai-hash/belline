-- Belline sales engine — initial schema.
--
-- Lives in its own `sales` schema, entirely separate from the voice product's
-- JSON store. Nothing here touches data/*.json, and the voice product does not
-- know this exists.
--
-- Three conventions, explained in docs/sales-engine/DATABASE.md:
--   · config is versioned, evidence is immutable, state is derived
--   · money is numeric(14,4) and always carries a currency
--   · timestamps are timestamptz (unlike the booking engine's wall-clock minutes)

create schema if not exists sales;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table sales.country (
  code               char(2) primary key,
  name               text not null,
  default_languages  text[] not null default '{}',
  default_timezone   text not null,
  currency           char(3) not null,
  -- Channel permissions, consent requirements, send windows, holidays.
  -- A lawyer's answer becomes a config change rather than a code change.
  compliance_profile jsonb not null default '{}',
  created_at         timestamptz not null default now()
);

create table sales.region (
  id           bigserial primary key,
  country_code char(2) not null references sales.country(code),
  name         text not null,
  kind         text not null default 'city',
  unique (country_code, name)
);

create table sales.vertical (
  slug        text primary key,
  name        text not null,
  parent_slug text references sales.vertical(slug),
  terms       jsonb not null default '{}',
  default_icp jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- What Belline sells. `proof` is the ONLY source an outreach message may draw a
-- capability claim from — if it is not in here with a source, no agent may say it.
create table sales.service (
  slug        text primary key,
  name        text not null,
  description text not null,
  verticals   text[] not null default '{}',
  proof       jsonb not null default '[]',
  active      boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Agents — director, country manager and vertical agent share one table
-- ---------------------------------------------------------------------------

create type sales.agent_kind   as enum ('director', 'country_manager', 'vertical_agent');
create type sales.agent_status as enum ('draft', 'active', 'paused', 'archived');
create type sales.autonomy     as enum ('review', 'semi', 'autonomous');

create table sales.agent (
  id              bigserial primary key,
  kind            sales.agent_kind not null,
  parent_id       bigint references sales.agent(id),
  name            text not null,
  country_code    char(2) references sales.country(code),
  vertical_slug   text references sales.vertical(slug),
  regions         text[] not null default '{}',
  languages       text[] not null default '{}',
  status          sales.agent_status not null default 'draft',
  autonomy_mode   sales.autonomy not null default 'review',
  config          jsonb not null default '{}',
  daily_budget    numeric(14,4),
  monthly_budget  numeric(14,4),
  budget_currency char(3) not null default 'USD',
  -- The launch gate from COMPLIANCE.md §5. Activation is refused until every
  -- item is checked.
  launch_checklist jsonb not null default '{}',
  paused_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index agent_scope_uq on sales.agent (country_code, vertical_slug)
  where kind = 'vertical_agent' and status <> 'archived';
create index agent_parent_ix on sales.agent(parent_id);
create index agent_status_ix on sales.agent(status);

create table sales.agent_config_version (
  id         bigserial primary key,
  agent_id   bigint not null references sales.agent(id) on delete cascade,
  version    int not null,
  config     jsonb not null,
  changed_by text not null,
  note       text,
  created_at timestamptz not null default now(),
  unique (agent_id, version)
);

-- Manager and Director output: a proposal with a rationale, never a silent write.
create table sales.agent_directive (
  id           bigserial primary key,
  from_agent   bigint not null references sales.agent(id),
  target_agent bigint not null references sales.agent(id),
  kind         text not null,
  rationale    text not null,
  diff         jsonb not null default '{}',
  evidence     jsonb not null default '[]',
  status       text not null default 'proposed',
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index directive_open_ix on sales.agent_directive(status, created_at)
  where status = 'proposed';

create table sales.sequence (
  id         bigserial primary key,
  key        text not null unique,
  name       text not null,
  scope      jsonb not null default '{}',
  steps      jsonb not null,
  stop_on    text[] not null
               default '{replied,opted_out,meeting_booked,bounced,irrelevant}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table sales.campaign (
  id          bigserial primary key,
  agent_id    bigint not null references sales.agent(id) on delete cascade,
  name        text not null,
  sequence_id bigint references sales.sequence(id),
  status      text not null default 'active',
  starts_at   timestamptz,
  ends_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Companies and people
-- ---------------------------------------------------------------------------

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
  domain           text,
  phone            text,
  phone_e164       text,
  email            text,
  company_size     text,
  location_count   int,
  opening_hours    jsonb,
  rating           numeric(2,1),
  review_count     int,
  socials          jsonb not null default '{}',
  booking_url      text,
  booking_provider text,
  has_whatsapp     boolean,
  contact_workflow text,
  -- Every connector that has ever seen this company: [{slug, url, at}]
  sources          jsonb not null default '[]',
  status           text not null default 'active',
  discovered_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Dedup: three independent keys, any hit is a match. See discovery/dedup.ts.
create unique index company_domain_uq on sales.company(domain)     where domain is not null;
create unique index company_phone_uq  on sales.company(phone_e164) where phone_e164 is not null;
create index company_namecity_ix on sales.company
  (lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')), country_code, city);
create index company_vertical_ix on sales.company(country_code, vertical_slug, status);

create table sales.company_location (
  id            bigserial primary key,
  company_id    bigint not null references sales.company(id) on delete cascade,
  label         text,
  address       text,
  city          text,
  phone_e164    text,
  lat           numeric(9,6),
  lng           numeric(9,6),
  external_id   text,
  opening_hours jsonb,
  created_at    timestamptz not null default now()
);
create unique index company_location_ext_uq on sales.company_location(external_id)
  where external_id is not null;
create index company_location_company_ix on sales.company_location(company_id);

create table sales.contact (
  id           bigserial primary key,
  company_id   bigint not null references sales.company(id) on delete cascade,
  full_name    text,
  title        text,
  role_class   text,
  email        text,
  email_status text,
  phone_e164   text,
  linkedin_url text,
  language     text,
  source       text not null,
  source_url   text,
  confidence   numeric(3,2) not null default 0.5,
  is_primary   boolean not null default false,
  redacted_at  timestamptz,
  created_at   timestamptz not null default now()
);
create unique index contact_email_uq on sales.contact(lower(email)) where email is not null;
create index contact_company_ix on sales.contact(company_id);

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------

create type sales.lead_stage as enum (
  'discovered', 'researching', 'qualified', 'contacted', 'follow_up', 'replied',
  'interested', 'demo', 'meeting_booked', 'pilot', 'customer', 'lost', 'do_not_contact'
);
create type sales.priority as enum ('hot', 'warm', 'low');

create table sales.lead (
  id               bigserial primary key,
  company_id       bigint not null references sales.company(id) on delete cascade,
  agent_id         bigint not null references sales.agent(id),
  campaign_id      bigint references sales.campaign(id),
  contact_id       bigint references sales.contact(id),
  stage            sales.lead_stage not null default 'discovered',
  current_score    int,
  priority         sales.priority,
  language         text,
  owner_user_id    text,
  next_action_at   timestamptz,
  stage_changed_at timestamptz not null default now(),
  closed_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The most important line in this file. Requirement §1: "Do not contact the
-- same company twice through different agents." One live pursuit per company,
-- globally, across every agent and country. A rejected insert is not an error
-- to swallow — it files a lead_claim_conflict for the country manager.
create unique index lead_one_active_per_company on sales.lead(company_id)
  where stage not in ('lost', 'do_not_contact');

create index lead_agent_stage_ix on sales.lead(agent_id, stage);
create index lead_due_ix on sales.lead(next_action_at) where next_action_at is not null;

create table sales.lead_claim_conflict (
  id             bigserial primary key,
  company_id     bigint not null references sales.company(id) on delete cascade,
  holding_lead   bigint not null references sales.lead(id) on delete cascade,
  claiming_agent bigint not null references sales.agent(id),
  resolution     text,
  resolved_by    text,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index conflict_open_ix on sales.lead_claim_conflict(created_at)
  where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Research and scoring — append-only
-- ---------------------------------------------------------------------------

create table sales.research_record (
  id          bigserial primary key,
  company_id  bigint not null references sales.company(id) on delete cascade,
  agent_id    bigint not null references sales.agent(id),
  summary     text not null,
  -- Typed signals with a closed vocabulary. null means "could not tell",
  -- which the scoring model treats differently from false.
  signals     jsonb not null default '{}',
  use_cases   text[] not null default '{}',
  -- [{claim, url, quote}] — every url must be one of pages_read.
  evidence    jsonb not null default '[]',
  pages_read  text[] not null default '{}',
  model       text not null,
  prompt_hash text not null,
  cost_usd    numeric(14,6),
  created_at  timestamptz not null default now()
);
create index research_company_ix on sales.research_record(company_id, created_at desc);

create table sales.lead_score (
  id            bigserial primary key,
  lead_id       bigint not null references sales.lead(id) on delete cascade,
  score         int not null check (score between 0 and 100),
  priority      sales.priority not null,
  -- Full arithmetic trace: [{signal, weight, value, points}]. Makes the score
  -- explainable in the dashboard and re-runnable after a weight change.
  breakdown     jsonb not null default '[]',
  reason        text not null,
  model_version text not null,
  created_at    timestamptz not null default now()
);
create index lead_score_lead_ix on sales.lead_score(lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Outreach
-- ---------------------------------------------------------------------------

create type sales.channel    as enum ('email', 'linkedin', 'whatsapp', 'phone', 'sms');
create type sales.direction  as enum ('outbound', 'inbound');
create type sales.msg_status as enum (
  'draft', 'pending_approval', 'approved', 'rejected', 'queued', 'sending',
  'sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced', 'failed', 'cancelled'
);

create table sales.sequence_enrollment (
  id             bigserial primary key,
  lead_id        bigint not null references sales.lead(id) on delete cascade,
  sequence_id    bigint not null references sales.sequence(id),
  current_step   int not null default 0,
  next_due_at    timestamptz,
  status         text not null default 'active',
  stopped_reason text,
  created_at     timestamptz not null default now()
);
create unique index enrollment_active_uq on sales.sequence_enrollment(lead_id)
  where status = 'active';
create index enrollment_due_ix on sales.sequence_enrollment(next_due_at)
  where status = 'active';

create table sales.conversation (
  id         bigserial primary key,
  lead_id    bigint not null references sales.lead(id) on delete cascade,
  channel    sales.channel not null,
  thread_key text not null,
  subject    text,
  last_at    timestamptz,
  created_at timestamptz not null default now()
);
create unique index conversation_thread_uq on sales.conversation(channel, thread_key);
create index conversation_lead_ix on sales.conversation(lead_id);

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
  language        text not null default 'en',
  to_address      text,
  from_address    text,
  subject         text,
  body            text not null,
  -- {observation, problem, solution, cta, evidence:[{claim,url}]}
  personalisation jsonb not null default '{}',
  -- Guard failures that sent this draft to human review, if any.
  guard_flags     jsonb not null default '[]',
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
  redacted_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index message_approval_ix on sales.message(created_at)
  where status = 'pending_approval';
create index message_lead_ix on sales.message(lead_id, created_at);
create unique index message_provider_uq on sales.message(provider, provider_msg_id)
  where provider_msg_id is not null;

create table sales.reply_classification (
  id         bigserial primary key,
  message_id bigint not null references sales.message(id) on delete cascade,
  category   text not null,
  confidence numeric(3,2) not null,
  extracted  jsonb not null default '{}',
  action     text not null,
  model      text not null,
  created_at timestamptz not null default now()
);
create index reply_class_message_ix on sales.reply_classification(message_id);

-- ---------------------------------------------------------------------------
-- Calls, demos, meetings, revenue
-- ---------------------------------------------------------------------------

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
create index sales_call_lead_ix on sales.sales_call(lead_id);

-- Requirement §9. Bridges to the personalised-demo machinery that already
-- exists in src/lib/prospect.ts and src/lib/demo.ts.
create table sales.demo (
  id            bigserial primary key,
  lead_id       bigint not null references sales.lead(id) on delete cascade,
  kind          text not null,
  -- For a personalised link: the Location.prospect.slug in the voice product's
  -- JSON store. Deliberately a loose reference across the two stores.
  location_slug text,
  phone_number  text,
  script_hint   text not null,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  first_used_at timestamptz,
  use_count     int not null default 0,
  total_seconds int not null default 0,
  call_ids      text[] not null default '{}'
);
create index demo_lead_ix on sales.demo(lead_id);

create table sales.meeting (
  id                bigserial primary key,
  lead_id           bigint not null references sales.lead(id) on delete cascade,
  contact_id        bigint references sales.contact(id),
  provider          text,
  provider_event_id text,
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  timezone          text not null,
  status            text not null default 'scheduled',
  join_url          text,
  briefing_md       text,
  outcome_notes     text,
  created_at        timestamptz not null default now()
);
create index meeting_lead_ix on sales.meeting(lead_id);
create index meeting_upcoming_ix on sales.meeting(starts_at) where status = 'scheduled';

create table sales.opportunity (
  id             bigserial primary key,
  lead_id        bigint not null references sales.lead(id) on delete cascade,
  services       text[] not null default '{}',
  locations      int not null default 1,
  mrr_estimate   numeric(14,4),
  setup_fee      numeric(14,4),
  currency       char(3) not null,
  stage          text not null default 'open',
  expected_close date,
  closed_at      timestamptz,
  lost_reason    text,
  created_at     timestamptz not null default now()
);
create index opportunity_lead_ix on sales.opportunity(lead_id);

create table sales.customer (
  id             bigserial primary key,
  company_id     bigint not null references sales.company(id),
  opportunity_id bigint references sales.opportunity(id),
  mrr            numeric(14,4) not null,
  currency       char(3) not null,
  mrr_usd        numeric(14,4) not null,
  started_at     date not null,
  churned_at     date,
  -- Closes the loop into the voice product: which Location ids this became.
  -- Makes "UAE Dental Agent generated AED 42,000 MRR" a query.
  location_ids   text[] not null default '{}',
  created_at     timestamptz not null default now()
);
create index customer_company_ix on sales.customer(company_id);

-- ---------------------------------------------------------------------------
-- Governance
-- ---------------------------------------------------------------------------

-- Rows are NEVER deleted. An opt-out is permanent, and survives even a
-- data-deletion request — otherwise "delete me" becomes "contact me again".
create table sales.suppression (
  id         bigserial primary key,
  scope      text not null default 'global',
  scope_id   text,
  match_type text not null,
  value      text not null,
  reason     text not null,
  source     text,
  created_by text,
  created_at timestamptz not null default now()
);
create unique index suppression_uq on sales.suppression
  (scope, coalesce(scope_id, ''), match_type, lower(value));
create index suppression_lookup_ix on sales.suppression(match_type, lower(value));

create table sales.consent_record (
  id           bigserial primary key,
  company_id   bigint references sales.company(id) on delete cascade,
  contact_id   bigint references sales.contact(id) on delete cascade,
  country_code char(2) not null,
  basis        text not null,
  evidence     jsonb not null default '{}',
  channel      sales.channel not null,
  recorded_at  timestamptz not null default now()
);
create index consent_company_ix on sales.consent_record(company_id, channel);

-- The lead timeline. Append-only, forever.
create table sales.activity (
  id         bigserial primary key,
  lead_id    bigint references sales.lead(id) on delete cascade,
  company_id bigint references sales.company(id) on delete cascade,
  agent_id   bigint references sales.agent(id),
  actor      text not null,
  type       text not null,
  summary    text not null,
  data       jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index activity_lead_ix on sales.activity(lead_id, at desc);
create index activity_type_ix on sales.activity(type, at desc);
create index activity_agent_ix on sales.activity(agent_id, at desc);

create table sales.audit_log (
  id        bigserial primary key,
  actor     text not null,
  action    text not null,
  entity    text not null,
  entity_id text not null,
  before    jsonb,
  after     jsonb,
  ip        text,
  at        timestamptz not null default now()
);
create index audit_entity_ix on sales.audit_log(entity, entity_id, at desc);

create table sales.agent_run (
  id         bigserial primary key,
  agent_id   bigint not null references sales.agent(id) on delete cascade,
  stage      text not null,
  trigger    text not null,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  status     text not null default 'running',
  stats      jsonb not null default '{}',
  error      text
);
create index agent_run_agent_ix on sales.agent_run(agent_id, started_at desc);

create table sales.cost_event (
  id         bigserial primary key,
  agent_id   bigint references sales.agent(id) on delete cascade,
  lead_id    bigint references sales.lead(id) on delete set null,
  run_id     bigint references sales.agent_run(id) on delete set null,
  category   text not null,
  provider   text not null,
  units      numeric(14,4) not null default 1,
  unit_label text,
  amount_usd numeric(14,6) not null,
  at         timestamptz not null default now()
);
create index cost_agent_ix on sales.cost_event(agent_id, at desc);
create index cost_category_ix on sales.cost_event(category, at desc);

create table sales.integration (
  id         bigserial primary key,
  provider   text not null unique,
  kind       text not null,
  status     text not null default 'inactive',
  -- Never secrets: env var names and non-secret settings only.
  config     jsonb not null default '{}',
  last_ok_at timestamptz,
  last_error text
);

create table sales.source (
  id     bigserial primary key,
  slug   text not null unique,
  kind   text not null,
  config jsonb not null default '{}',
  active boolean not null default true
);

create table sales.rate_limit (
  key          text primary key,
  window_sec   int not null,
  max_units    int not null,
  used         int not null default 0,
  window_start timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------

create table sales.job (
  id              bigserial primary key,
  type            text not null,
  payload         jsonb not null default '{}',
  agent_id        bigint references sales.agent(id) on delete cascade,
  run_id          bigint references sales.agent_run(id) on delete set null,
  priority        int not null default 100,
  run_at          timestamptz not null default now(),
  attempts        int not null default 0,
  max_attempts    int not null default 5,
  status          text not null default 'pending',
  locked_by       text,
  locked_at       timestamptz,
  -- Derived per handler, e.g. research:{company_id}:{config_hash}. Stops a
  -- retry after a crash mid-write from double-sending or double-billing.
  idempotency_key text unique,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index job_claim_ix on sales.job(run_at, priority) where status = 'pending';
create index job_dead_ix on sales.job(updated_at desc) where status = 'dead';
