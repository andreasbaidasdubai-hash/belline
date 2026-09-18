/**
 * Who is eligible, read from the pipeline.
 *
 * The queries live behind the `CandidateSource` port so that everything that
 * decides — screening, allocation, scheduling — can be tested against a list
 * of plain objects. This file is the only part of the batching path that
 * touches the database, and with no `DATABASE_URL` it returns nothing rather
 * than throwing, so the console still renders and says the pipeline is
 * unreadable.
 *
 * The first-touch query's one non-obvious clause is the join to
 * `sales.video_demo`: a lead with no live personalised demo is not a candidate
 * at all. The email's only job is to earn one click on that recording, and a
 * message that promises one and links to a homepage is the worst first
 * impression this company can make.
 */

import { isConfigured, query } from "../db/client";
import { sendingStore, type SendingStore } from "./store";
import type { Candidate, CandidateSource } from "./batch";

interface Row {
  lead_id: string;
  company_id: string | null;
  name: string;
  country_code: string | null;
  domain: string | null;
  to_address: string | null;
  message_id: string | null;
  subject: string | null;
  body: string | null;
  guard_flags: string[] | null;
  video_demo_id: string | null;
  has_research: boolean;
  touches_90d: string;
  last_touch_at: string | null;
}

const SELECT = `
  select l.id            as lead_id,
         c.id            as company_id,
         c.name          as name,
         c.country_code  as country_code,
         c.domain        as domain,
         coalesce(ct.email, c.email) as to_address,
         m.id            as message_id,
         m.subject       as subject,
         m.body          as body,
         m.guard_flags   as guard_flags,
         vd.id           as video_demo_id,
         exists (select 1 from sales.research_record rr where rr.company_id = c.id) as has_research,
         (select count(*) from sales.message mm
           where mm.lead_id = l.id and mm.direction = 'outbound'
             and mm.status in ('sent','delivered','opened','clicked','replied')
             and mm.created_at > now() - interval '90 days')::text as touches_90d,
         (select max(mm.sent_at) from sales.message mm
           where mm.lead_id = l.id and mm.direction = 'outbound')::text as last_touch_at
    from sales.lead l
    join sales.company c on c.id = l.company_id
    left join sales.contact ct on ct.id = l.contact_id
    left join lateral (
      select id from sales.video_demo v
       where v.lead_id = l.id and v.revoked_at is null and v.expires_at > now()
       order by created_at desc limit 1
    ) vd on true
    left join lateral (
      select id, subject, body, guard_flags from sales.message mm
       where mm.lead_id = l.id and mm.direction = 'outbound' and mm.status = 'approved'
       order by created_at desc limit 1
    ) m on true`;

async function hydrate(rows: Row[], store: SendingStore, origin: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const row of rows) {
    const leadId = Number(row.lead_id);
    const companyId = row.company_id === null ? null : Number(row.company_id);
    const sequence = await store.getSequence(leadId);
    const suppressed = await store.suppressed({
      email: row.to_address,
      domain: row.domain,
      companyId,
    });
    const guardFlags = Array.isArray(row.guard_flags)
      ? row.guard_flags.filter((f) => typeof f === "string" && !f.startsWith("warning:"))
      : [];
    out.push({
      leadId,
      companyId,
      companyName: row.name,
      toAddress: row.to_address,
      countryCode: row.country_code,
      messageId: row.message_id === null ? null : Number(row.message_id),
      subject: row.subject ?? "",
      body: row.body ?? "",
      videoDemoId: row.video_demo_id,
      demoUrl: row.video_demo_id ? `${origin.replace(/\/+$/, "")}/demo/v/${row.video_demo_id}` : null,
      hasResearch: row.has_research,
      guardProblems: guardFlags,
      suppressed,
      touches90d: Number(row.touches_90d ?? 0),
      lastTouchAt: row.last_touch_at,
      sequenceStopped: sequence && sequence.status === "stopped" ? (sequence.stopReason ?? "stopped") : null,
    });
  }
  return out;
}

export function pipelineSource(input: { origin: string; store?: SendingStore }): CandidateSource {
  const store = input.store ?? sendingStore();

  return {
    async firstTouch(limit: number): Promise<Candidate[]> {
      if (!isConfigured()) return [];
      const rows = await query<Row>(
        `${SELECT}
          where l.stage in ('qualified', 'contacted')
            and vd.id is not null
            and m.id is not null
            and not exists (
              select 1 from sales.send_item si
               where si.lead_id = l.id and si.step = 1 and si.status <> 'cancelled')
          order by l.current_score desc nulls last
          limit $1`,
        [limit],
      );
      return hydrate(rows, store, input.origin);
    },

    async dueFollowUps(limit: number, now: Date) {
      if (!isConfigured()) return [];
      const states = await store.listSequences({ status: "active", limit: 500 });
      const due = states.filter(
        (s) => s.step > 0 && s.nextDueAt !== null && s.nextDueAt <= now.toISOString(),
      );
      if (due.length === 0) return [];
      const rows = await query<Row>(`${SELECT} where l.id = any($1::bigint[]) limit $2`, [
        due.map((s) => s.leadId),
        limit,
      ]);
      const hydrated = await hydrate(rows, store, input.origin);
      return hydrated
        .map((candidate) => {
          const state = due.find((s) => s.leadId === candidate.leadId)!;
          return { ...candidate, step: state.step + 1 };
        })
        .filter((c) => c.step > 1);
    },
  };
}

/**
 * A source backed by a list, for the checks and for a local run with no
 * pipeline. It is never reachable from the console — the routes construct
 * `pipelineSource` — so a stub cannot become production by accident.
 */
export function fixedSource(candidates: Candidate[]): CandidateSource {
  return {
    async firstTouch(limit) {
      return candidates.slice(0, limit);
    },
    async dueFollowUps() {
      return [];
    },
  };
}
