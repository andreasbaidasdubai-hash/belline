-- The demo recording's own transcript.
--
-- 0001 stored only the clip ids, which is enough to play a demo and not enough
-- to do anything else with it: the landing page shows the words beside the
-- audio (a transcript is what makes a 40-second clip skimmable), and auditing
-- "what exactly did we say in this business's name" needs the text, not a list
-- of hashes.
--
-- Kept as jsonb rather than a child table because a recording is one immutable
-- artefact — it is never edited, only superseded by a new one.

alter table sales.demo
  add column if not exists script jsonb not null default '{}'::jsonb;

-- The line shown on the landing page under the player, e.g.
-- "A patient calls at 9pm to book a cleaning."
alter table sales.demo
  add column if not exists scenario text;

-- Estimated speech length, so a page can show "40 seconds" before loading any
-- audio and a run can be checked against the 30-60s target without decoding.
alter table sales.demo
  add column if not exists seconds int;

-- Every demo issued for a lead, newest first — the query the landing page and
-- the lead detail page both make.
create index if not exists demo_lead_issued_ix on sales.demo(lead_id, issued_at desc);

-- The public slug is how a prospect reaches their demo, so it has to resolve
-- in one indexed lookup rather than a scan.
create index if not exists demo_slug_ix on sales.demo(location_slug)
  where location_slug is not null;
