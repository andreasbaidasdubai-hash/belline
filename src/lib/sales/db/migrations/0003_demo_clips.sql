-- Demo audio, stored in the database rather than on a disk.
--
-- The clips were written to DATA_DIR, which works perfectly on one machine and
-- not at all across two: they were generated on a laptop and the production
-- container reads a mounted volume that has never seen them. The demo page
-- rendered its transcript and every clip 404'd — a personalised demo with no
-- audio, which is the one thing it exists to have.
--
-- Object storage would be the answer at scale. At this scale it is not: a clip
-- is ~60 KB, a demo is a dozen of them, and a thousand demos is under a
-- gigabyte. Putting them beside the record they belong to means a demo is one
-- row and its audio, portable to any environment, surviving every redeploy,
-- with no second service to configure and nothing to keep in sync.
--
-- Content-addressed: the id is a hash of voice + model + words, so re-rendering
-- an unchanged line writes nothing and re-wording one is a different row.

create table if not exists sales.demo_clip (
  id         text primary key,
  role       text not null,
  text       text not null,
  mime       text not null default 'audio/mpeg',
  bytes      bytea not null,
  size_bytes int generated always as (length(bytes)) stored,
  created_at timestamptz not null default now()
);

-- Housekeeping: which clips are no longer referenced by any live demo. Not
-- deleted automatically — a stale clip is a few kilobytes and a missing one is
-- a silent demo.
create index if not exists demo_clip_created_ix on sales.demo_clip(created_at desc);
