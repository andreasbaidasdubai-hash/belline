-- The outreach engine: what sends, from where, to whom, and under which rule.
--
-- Until now `sales.message` held drafts and nothing carried them anywhere.
-- These tables are the sender: the domains and mailboxes cold mail leaves
-- from, the batches a person approved, the individual sends with the country
-- rule and sender identity each went out under, the state of each lead's
-- sequence, and the events that come back.
--
-- The one row-level rule worth stating up front: `send_item` records
-- `country_rule` and `identity_fingerprint` at send time and never updates
-- them. If a complaint arrives eighteen months later, "what did we send and on
-- what basis" has to be answerable from the row, not reconstructed from
-- whatever the code says today.

-- ---------------------------------------------------------------------------
-- Sending domains and mailboxes
-- ---------------------------------------------------------------------------

create table if not exists sales.sending_domain (
  id             bigserial primary key,
  domain         text not null unique,
  -- 'ses'. 'resend' is refused in code — see sending/provider.ts — because it
  -- carries belline.ai's transactional mail and must not share a reputation.
  provider       text not null default 'ses',
  -- 'cold' or 'transactional'. belline.ai itself is never 'cold'.
  purpose        text not null default 'cold',
  status         text not null default 'warming',   -- warming | active | paused | retired
  paused_reason  text,
  paused_at      timestamptz,
  paused_by      text,
  -- A ceiling across every mailbox on the domain, under the sum of their caps.
  daily_cap      int not null default 120,
  -- What staff recorded as verified: {spf, dkim, dmarc, mx, verified_at}.
  dns            jsonb not null default '{}'::jsonb,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists sending_domain_status_ix on sales.sending_domain(status);

create table if not exists sales.sending_mailbox (
  id             bigserial primary key,
  domain_id      bigint not null references sales.sending_domain(id) on delete cascade,
  address        text not null unique,
  display_name   text not null,
  reply_to       text,
  -- The ceiling once warm. The warm-up schedule decides today's number.
  daily_cap      int not null default 30,
  warmup_started_on date,
  status         text not null default 'warming',   -- warming | active | paused
  paused_reason  text,
  paused_at      timestamptz,
  paused_by      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists sending_mailbox_domain_ix on sales.sending_mailbox(domain_id, status);

-- ---------------------------------------------------------------------------
-- Batches: nothing sends without one, and no batch sends without a person
-- ---------------------------------------------------------------------------

create table if not exists sales.send_batch (
  id           bigserial primary key,
  status       text not null default 'draft',   -- draft | approved | cancelled
  created_by   text not null,
  created_at   timestamptz not null default now(),
  -- Null until a human being pressed the button. The engine reads this, not a
  -- flag: an unapproved batch is not schedulable at all.
  approved_by  text,
  approved_at  timestamptz,
  cancelled_by text,
  cancelled_at timestamptz,
  -- {leads, demoMinutes, perMailbox:{...}, perCountry:{...}} as shown on the
  -- approval screen, frozen so the record says what the approver was told.
  planned      jsonb not null default '{}'::jsonb,
  notes        text
);
create index if not exists send_batch_status_ix on sales.send_batch(status, created_at desc);

create table if not exists sales.send_item (
  id                   bigserial primary key,
  batch_id             bigint references sales.send_batch(id) on delete set null,
  lead_id              bigint not null references sales.lead(id) on delete cascade,
  company_id           bigint references sales.company(id) on delete cascade,
  message_id           bigint references sales.message(id) on delete set null,
  video_demo_id        text,
  step                 int not null default 1,        -- 1 = first demo email, 2..4 follow-ups
  mailbox_id           bigint references sales.sending_mailbox(id) on delete set null,
  to_address           text not null,
  subject              text not null,
  body                 text not null,
  language             text not null default 'en',
  scheduled_for        timestamptz,
  status               text not null default 'planned',
  -- planned | queued | sending | sent | failed | cancelled | blocked
  -- Frozen at the moment of the decision. Never rewritten.
  country_code         char(2),
  country_rule         text,
  identity_fingerprint text,
  identity_snapshot    jsonb,
  unsubscribe_token    text,
  provider             text,
  provider_msg_id      text,
  blocked_reason       text,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists send_item_lead_ix on sales.send_item(lead_id, step);
create index if not exists send_item_due_ix on sales.send_item(scheduled_for)
  where status in ('planned', 'queued');
create index if not exists send_item_batch_ix on sales.send_item(batch_id);
-- One send per lead per step, ever. The queue is at-least-once; this is what
-- stops a retry after a crash from putting the same email in the same inbox
-- a second time.
create unique index if not exists send_item_step_uq on sales.send_item(lead_id, step)
  where status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- Sequence state: one row per lead, the thing that stops
-- ---------------------------------------------------------------------------

create table if not exists sales.sequence_state (
  lead_id       bigint primary key references sales.lead(id) on delete cascade,
  company_id    bigint references sales.company(id) on delete cascade,
  step          int not null default 0,
  status        text not null default 'active',   -- active | stopped | completed
  -- 'replied' | 'demo_clicked' | 'unsubscribed' | 'bounced' | 'complaint' |
  -- 'suppressed' | 'cap' | 'staff'
  stop_reason   text,
  stopped_at    timestamptz,
  next_due_at   timestamptz,
  last_sent_at  timestamptz,
  country_code  char(2),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists sequence_state_due_ix on sales.sequence_state(next_due_at)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- Events: what came back
-- ---------------------------------------------------------------------------

create table if not exists sales.send_event (
  id         bigserial primary key,
  mailbox_id bigint references sales.sending_mailbox(id) on delete cascade,
  domain_id  bigint references sales.sending_domain(id) on delete cascade,
  lead_id    bigint,
  item_id    bigint,
  -- sent | delivered | bounce | complaint | reply | unsubscribe | demo_view | failed
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index if not exists send_event_mailbox_ix on sales.send_event(mailbox_id, at desc);
create index if not exists send_event_domain_ix on sales.send_event(domain_id, kind, at desc);

create table if not exists sales.inbound_reply (
  id           bigserial primary key,
  lead_id      bigint references sales.lead(id) on delete cascade,
  item_id      bigint,
  mailbox_id   bigint references sales.sending_mailbox(id) on delete set null,
  from_address text not null,
  subject      text,
  body         text not null,
  is_opt_out   boolean not null default false,
  received_at  timestamptz not null default now(),
  handled_at   timestamptz,
  handled_by   text
);
create index if not exists inbound_reply_lead_ix on sales.inbound_reply(lead_id, received_at desc);
create index if not exists inbound_reply_open_ix on sales.inbound_reply(received_at desc)
  where handled_at is null;

-- ---------------------------------------------------------------------------
-- Per-country switch
-- ---------------------------------------------------------------------------
--
-- Staff may turn a country on, or turn its daily number down. They may not
-- widen spacing, step caps or the identity requirement: those come from the
-- rule table in code, because they are the parts that carry the liability and
-- the parts a busy person is most tempted to loosen.

create table if not exists sales.outreach_country (
  code       char(2) primary key,
  enabled    boolean not null,
  daily_cap  int,
  updated_by text,
  updated_at timestamptz not null default now()
);
