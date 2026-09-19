-- ---------------------------------------------------------------------------
-- Inbound mail: replies that stop sequences by themselves
-- ---------------------------------------------------------------------------
--
-- Until now a reply was only a reply when a person noticed it and pasted it
-- into the console. Everything here exists so that a message arriving in a
-- sending mailbox reaches the lead's timeline without anybody being awake.
--
-- Three ideas, and each of them is a column:
--
--  1. **A message we sent has a name.** `rfc_message_id` is the `Message-ID`
--     header the recipient's mail client will quote back in `In-Reply-To`.
--     Without storing it, a reply is an address and a guess.
--
--  2. **A reply we cannot thread still has an address to come back to.**
--     `reply_token` is the plus-address suffix on the Reply-To we sent, so
--     `andreas+b12.ab34cd@try-belline.com` identifies the send even when the
--     mail client drops every threading header.
--
--  3. **An out-of-office is not a reply.** `paused_until` lets a sequence
--     stand still until somebody is back at their desk, which is a different
--     thing from stopping and has to be a different column — a stop that an
--     auto-reply caused is a lead silently lost.

alter table sales.send_item add column if not exists rfc_message_id text;
alter table sales.send_item add column if not exists reply_token    text;

-- Threading is a lookup on every inbound message, so it is indexed; unique
-- because two sends sharing a Message-ID would make threading ambiguous in the
-- one direction that matters.
create unique index if not exists send_item_rfc_message_id_uq
  on sales.send_item(rfc_message_id) where rfc_message_id is not null;
create unique index if not exists send_item_reply_token_uq
  on sales.send_item(reply_token) where reply_token is not null;

-- ---------------------------------------------------------------------------
-- Pausing, as distinct from stopping
-- ---------------------------------------------------------------------------

alter table sales.sequence_state add column if not exists paused_until timestamptz;
alter table sales.sequence_state add column if not exists pause_reason text;

-- The due index has to know about the pause, or the planner picks up a lead
-- whose contact is on holiday until Monday.
drop index if exists sales.sequence_state_due_ix;
create index if not exists sequence_state_due_ix on sales.sequence_state(next_due_at)
  where status = 'active' and paused_until is null;
create index if not exists sequence_state_paused_ix on sales.sequence_state(paused_until)
  where paused_until is not null;

-- ---------------------------------------------------------------------------
-- Everything that arrives, not only the things that are replies
-- ---------------------------------------------------------------------------
--
-- `inbound_reply` was already the table staff read. It becomes the record of
-- every inbound message instead of a second table beside it, because the
-- question a person asks is "what came back from this lead" and the answer
-- should not be split across two places by a classifier's opinion.

alter table sales.inbound_reply add column if not exists kind text not null default 'reply';
alter table sales.inbound_reply add column if not exists provider text;
alter table sales.inbound_reply add column if not exists provider_message_id text;
alter table sales.inbound_reply add column if not exists rfc_message_id text;
alter table sales.inbound_reply add column if not exists in_reply_to text;
alter table sales.inbound_reply add column if not exists to_address text;
-- thread | plus_address | address | none — recorded so a matching rule that
-- starts guessing wrong is visible in the data rather than inferred from
-- complaints.
alter table sales.inbound_reply add column if not exists matched_by text;
-- none | likely | certain. `is_opt_out` stays as the boolean the engine acts
-- on, and is only ever true for `certain`.
alter table sales.inbound_reply add column if not exists opt_out_confidence text not null default 'none';
alter table sales.inbound_reply add column if not exists needs_review boolean not null default false;
alter table sales.inbound_reply add column if not exists paused_until timestamptz;

-- Idempotency. The provider will redeliver; SNS says so in its own
-- documentation. Two deliveries of one message must be one row, and the
-- database is the only place that can promise it under concurrency.
create unique index if not exists inbound_reply_provider_msg_uq
  on sales.inbound_reply(provider, provider_message_id)
  where provider_message_id is not null;
create index if not exists inbound_reply_kind_ix on sales.inbound_reply(kind, received_at desc);
create index if not exists inbound_reply_review_ix on sales.inbound_reply(received_at desc)
  where needs_review = true;
