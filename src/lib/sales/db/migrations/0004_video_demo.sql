-- Personalised video-demo links (src/lib/sales/video-demo).
--
-- One row per link a member of staff created for a lead. The token in the URL
-- is signed from the id and the expiry and never stored; revoking is this
-- row's revoked_at, which every use of the link reads.
--
-- `facts` is the prospect context snapshot taken from the research record at
-- creation, so what Belle says on the link is what staff previewed. `opening`
-- is the (possibly edited) opening line that passed the guards.
--
-- `stats` holds counters and topics only — never words from the conversation.
-- The call transcript stays on the call record under the transcript policy
-- that already applies to Belline's own line.

create table if not exists sales.video_demo (
  id          text primary key,
  lead_id     bigint not null references sales.lead(id) on delete cascade,
  company_id  bigint references sales.company(id) on delete cascade,
  facts       jsonb not null,
  opening     text not null,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  revoked_by  text,
  stats       jsonb not null default '{}'::jsonb,
  daily       jsonb not null default '{}'::jsonb
);

create index if not exists video_demo_lead_ix on sales.video_demo(lead_id, created_at desc);
create index if not exists video_demo_created_ix on sales.video_demo(created_at desc);
