-- Web chat: the third channel, and the first one whose transport is our own page.
--
-- Almost nothing is needed here, which was the bet the reception schema was
-- built on. `channel` already admitted 'webchat'; a conversation, a message and
-- a handoff do not care what wire they arrived on. Two things do.

-- ---------------------------------------------------------------------------
-- A provider whose network is us
-- ---------------------------------------------------------------------------

-- Meta and Twilio deliver a message to somebody else's network. Web chat
-- delivers it to a row this table already has: the visitor's page asks for
-- anything newer than what it has shown, and the reply is already there. So
-- "sending" is recording, and the polling is the delivery.
--
-- A separate provider rather than reusing 'internal' because the two differ in
-- the one way that matters — 'internal' is a demonstration with no recipient,
-- 'webchat' has a real person waiting on the other end of it. Conflating them
-- would mean a live conversation and a scripted one were indistinguishable in
-- the table that decides what gets sent.
alter table channel_account drop constraint if exists channel_account_provider_check;
alter table channel_account add constraint channel_account_provider_check
  check (provider in ('meta', 'twilio', 'internal', 'webchat'));

-- One web chat account per venue.
--
-- The existing unique index is on (channel, phone_e164) and partial, because a
-- number is what identifies a messaging account. Web chat has no number, so
-- nothing stopped two concurrent first-ever visitors creating two accounts for
-- the same venue — and a venue with two accounts is a venue whose second
-- visitor is invisible to the switch that turns the agent off.
create unique index if not exists channel_account_webchat
  on channel_account (tenant_id, location_id)
  where channel = 'webchat';

-- ---------------------------------------------------------------------------
-- A customer who has not given us a telephone number
-- ---------------------------------------------------------------------------

-- `customer.phone_e164` was named for the only channel that existed. A website
-- visitor has no number until they choose to give one, and a schema that
-- demands one cannot represent the first message they send.
--
-- So the column holds a *contact handle*: E.164 for the channels that are a
-- phone number, and `web:<opaque id>` for a browser session. The two shapes can
-- never collide — E.164 begins with '+' — and the constraint below says so out
-- loud, because the alternative is a column whose meaning lives in a comment
-- somewhere and in nobody's head.
--
-- NOT VALID deliberately: it holds every row written from now on without
-- reading the ones already there. A migration that can fail on production data
-- during a deploy is a migration that takes the site down to enforce a comment.
alter table customer drop constraint if exists customer_handle_shape;
alter table customer add constraint customer_handle_shape
  check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$' or phone_e164 ~ '^web:[A-Za-z0-9_-]{8,64}$')
  not valid;

comment on column customer.phone_e164 is
  'Contact handle. E.164 for phone channels; web:<id> for a website visitor who has not given a number.';
