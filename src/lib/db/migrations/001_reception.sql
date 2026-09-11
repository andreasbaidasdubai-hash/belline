-- Reception: conversations, messages, customers, channel accounts, events.
--
-- What is here and what is deliberately not.
--
-- Venues, bookings and calls stay in the JSON book. A WhatsApp booking is
-- created by the same createBooking() as a voice booking and lands in the same
-- diary, which is the entire point of the exercise and also the reason not to
-- move the book in the same change.
--
-- What is here is what the book cannot do: message volume, a unique index
-- doing duplicate-webhook defence, and two writers on one row while a customer
-- and a member of staff both type.
--
-- Tenancy is a column on every table and the first argument of every query in
-- the repositories above. The mistake being designed against is not an
-- attacker but a query written next year that forgets.

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

-- The person, once, per tenant — not once per channel.
--
-- Voice already recognises a caller by number (see guests.ts), but derives
-- them from bookings rather than storing them, which is why they cannot carry
-- an email, a language or a preference. This is the record that can, and the
-- phone number in E.164 is the key that lets WhatsApp and the telephone agree
-- they are talking to the same person.
create table if not exists customer (
  id            bigserial primary key,
  tenant_id     text        not null,
  -- Normalised, always. A number stored twice in two formats is two customers.
  phone_e164    text        not null,
  first_name    text,
  last_name     text,
  email         text,
  -- BCP-47, detected from what they wrote. Belline keeps answering in it.
  language      text,
  -- Staff-written, never shown to the customer and never given to the model
  -- as customer-safe knowledge.
  notes         text,
  preferences   jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists customer_tenant_phone
  on customer (tenant_id, phone_e164);

-- ---------------------------------------------------------------------------
-- Channel accounts
-- ---------------------------------------------------------------------------

-- One connected number, for one business, on one provider.
--
-- The provider is a column rather than a table because Meta and Twilio differ
-- only in credentials and wire format; both are reached through the same
-- ChannelAdapter. Moving a business from the Twilio sandbox to its own Meta
-- number is an update to this row and nothing else.
create table if not exists channel_account (
  id                  bigserial primary key,
  tenant_id           text        not null,
  business_id         text        not null,
  -- The venue whose diary this number books into. Null for a business whose
  -- single number serves several branches — the agent asks which.
  location_id         text,
  channel             text        not null check (channel in ('whatsapp', 'sms', 'webchat')),
  provider            text        not null check (provider in ('meta', 'twilio', 'internal')),
  -- The number as customers see it, E.164. Unique per channel: two businesses
  -- cannot both claim the same WhatsApp number.
  phone_e164          text,
  -- Provider handles. WhatsApp Business Account id and Phone Number id for
  -- Meta; the messaging service sid for Twilio.
  external_account_id text,
  external_number_id  text,
  -- Encrypted at rest with CREDENTIALS_KEY, and selected by nothing that
  -- serves a browser. See credentials.ts — the plaintext never leaves the
  -- process that sends a message.
  credentials_enc     text,
  status              text        not null default 'active'
                      check (status in ('active', 'paused', 'revoked')),
  -- Whether Belline answers on this number at all. A business that wants the
  -- inbox but not the agent sets this false and every message waits for a
  -- person.
  ai_enabled          boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists channel_account_number
  on channel_account (channel, phone_e164) where phone_e164 is not null;
create index if not exists channel_account_tenant
  on channel_account (tenant_id, business_id);

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

-- A thread with one person on one channel.
--
-- `business_id` rather than only `location_id`, and `location_id` nullable:
-- "anything in Marina?" is a question that arrives before a branch has been
-- chosen, and a schema that demands one up front cannot represent the
-- conversation where the customer picks. It is also what keeps the door open
-- for a conversation that is not with a pre-selected business at all.
create table if not exists conversation (
  id            bigserial primary key,
  tenant_id     text        not null,
  business_id   text        not null,
  location_id   text,
  channel       text        not null,
  channel_account_id bigint references channel_account (id),
  customer_id   bigint      not null references customer (id),

  -- AI_ACTIVE | HANDOFF_REQUESTED | HUMAN_ACTIVE | CLOSED
  --
  -- Checked inside the same transaction that writes an outbound message, which
  -- is the only way to guarantee a human and the model never reply at once. A
  -- status check before generating is not enough: generation takes seconds and
  -- staff take over during them.
  status        text        not null default 'AI_ACTIVE'
                check (status in ('AI_ACTIVE', 'HANDOFF_REQUESTED', 'HUMAN_ACTIVE', 'CLOSED')),

  -- Why it was escalated, and the summary written at that moment. Stored
  -- rather than regenerated when the inbox is opened: it should describe the
  -- conversation as it was when it was handed over.
  handoff_reason  text,
  handoff_summary text,
  handoff_at      timestamptz,
  handoff_user_id text,

  -- What the conversation is about, structured.
  --
  -- Service, date, time window, staff, the last availability result, the
  -- selected slot. "The later one" resolves against this deterministically
  -- before the model is asked anything, which is both cheaper and more
  -- reliable than replaying a transcript and hoping.
  state         jsonb       not null default '{}'::jsonb,

  language      text,
  booking_id    text,
  last_message_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz
);

-- The inbox's query: everything needing a person, newest first.
create index if not exists conversation_inbox
  on conversation (tenant_id, status, last_message_at desc);
-- Finding the open thread for a number that just messaged.
create index if not exists conversation_customer
  on conversation (tenant_id, customer_id, channel, last_message_at desc);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

create table if not exists message (
  id              bigserial primary key,
  tenant_id       text        not null,
  conversation_id bigint      not null references conversation (id) on delete cascade,

  -- customer | ai | human — three kinds, always distinguishable in the inbox.
  -- 'system' is for the notes a state change leaves behind ("Anna took over").
  sender          text        not null check (sender in ('customer', 'ai', 'human', 'system')),
  direction       text        not null check (direction in ('in', 'out')),

  content_type    text        not null default 'text'
                  check (content_type in ('text', 'audio', 'image', 'document', 'location', 'unsupported')),
  body            text,
  -- Media handle, transcript, provider status — anything that is not the text.
  meta            jsonb       not null default '{}'::jsonb,

  -- The provider's own id. This column plus the unique index below is the
  -- entire duplicate-webhook defence: Meta retries anything slow, and a retry
  -- handled twice is a duplicate booking.
  provider_message_id text,
  -- queued | sent | delivered | read | failed. Outbound only.
  delivery_status text,
  error           text,

  created_at      timestamptz not null default now()
);

-- The index that makes a retried webhook a no-op. Partial, because outbound
-- messages get their provider id only after the send returns.
create unique index if not exists message_provider_id
  on message (conversation_id, provider_message_id)
  where provider_message_id is not null;

create index if not exists message_thread
  on message (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

-- Append-only product analytics, from the first commit rather than retrofitted.
--
-- One row per thing that happened, with the payload as jsonb so a new event
-- does not need a migration. `trace_id` threads a webhook through the model
-- call, the tool call and the reply, which is what makes "why did it answer
-- that?" answerable three weeks later.
create table if not exists event (
  id              bigserial primary key,
  tenant_id       text        not null,
  business_id     text,
  location_id     text,
  channel         text,
  conversation_id bigint,
  trace_id        text,
  name            text        not null,
  payload         jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists event_report
  on event (tenant_id, name, created_at desc);
create index if not exists event_trace
  on event (trace_id) where trace_id is not null;
