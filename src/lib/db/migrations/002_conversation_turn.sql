-- What a conversation needs to answer, rather than only to be stored.

-- The model's own history, verbatim.
--
-- Not the `message` rows. Those are the operational record — what was sent,
-- what was delivered, what staff see — and they are missing the two things a
-- turn cannot resume without: the tool calls with their results, and the
-- thinking blocks, which the API rejects a history for dropping.
--
-- A phone call keeps this in memory because it lives and dies inside one
-- process. A message thread cannot: the reply comes twenty minutes later,
-- possibly to a different container.
alter table conversation
  add column if not exists agent_history jsonb not null default '[]'::jsonb;

-- The episode record in the venue's own book.
--
-- Belline's dashboard has always called these "calls", and one is created for
-- a WhatsApp conversation too — deliberately, because "what did Belline do for
-- me this week" should not have two answers depending on which channel
-- somebody used. The call carries the transcript, the tool traces, the
-- outcome and the summary; these Postgres rows carry delivery state, dedup and
-- the inbox. Different jobs, and the call is the one the venue reads.
alter table conversation
  add column if not exists call_id text;
