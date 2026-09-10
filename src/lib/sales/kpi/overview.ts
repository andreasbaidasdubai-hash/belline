import { isConfigured, query } from "../db/client";

/**
 * Everything the sales dashboard reads.
 *
 * One module rather than queries scattered through page components, for the
 * same reason `src/lib/store.ts` is one module: when this moves off a single
 * Postgres or grows a caching layer, there is one file to change.
 *
 * Every function here returns an empty result rather than throwing when
 * `DATABASE_URL` is unset or the schema has not been migrated. The dashboard's
 * job in that state is to tell you how to fix it, not to show a stack trace —
 * the same contract the speech providers already follow when their key is
 * missing.
 */

export type SetupState = "no_database" | "not_migrated" | "not_seeded" | "ready";

export async function setupState(): Promise<SetupState> {
  if (!isConfigured()) return "no_database";
  try {
    const agents = await query<{ n: number }>(`select count(*)::int as n from sales.agent`);
    return (agents[0]?.n ?? 0) > 0 ? "ready" : "not_seeded";
  } catch {
    // Relation does not exist — migrations have not run. Any other connection
    // problem lands here too, and "run the migration" is still the first thing
    // to try, so the two do not need separating on screen.
    return "not_migrated";
  }
}

export interface AgentSummary {
  id: number;
  name: string;
  kind: "director" | "country_manager" | "vertical_agent";
  parent_id: number | null;
  country_code: string | null;
  vertical_slug: string | null;
  status: string;
  autonomy_mode: string;
  paused_reason: string | null;
  daily_budget: number | null;
  monthly_budget: number | null;
  leads: number;
  qualified: number;
  contacted: number;
  replied: number;
  meetings: number;
  pending_approval: number;
  spent_today: number;
  spent_month: number;
}

/**
 * Every agent with its own numbers.
 *
 * Counts are per-agent rather than per-subtree: a country manager owns no
 * leads of its own, and rolling its children's numbers up into it would
 * double-count them in the same table. The hierarchy is shown by indentation
 * instead, and spend *is* rolled up because a budget genuinely is a subtree
 * property.
 */
export async function agentSummaries(): Promise<AgentSummary[]> {
  if (!isConfigured()) return [];
  try {
    return await query<AgentSummary>(
      `with recursive descendants as (
         select id as root, id as node from sales.agent
         union all
         select d.root, a.id from sales.agent a join descendants d on a.parent_id = d.node
       )
       select
         a.id, a.name, a.kind, a.parent_id, a.country_code, a.vertical_slug,
         a.status::text, a.autonomy_mode::text, a.paused_reason,
         a.daily_budget, a.monthly_budget,
         (select count(*)::int from sales.lead l where l.agent_id = a.id)            as leads,
         (select count(*)::int from sales.lead l where l.agent_id = a.id
            and l.priority in ('hot','warm'))                                        as qualified,
         (select count(*)::int from sales.lead l where l.agent_id = a.id
            and l.stage in ('contacted','follow_up','replied','interested','demo',
                            'meeting_booked','pilot','customer'))                    as contacted,
         (select count(*)::int from sales.lead l where l.agent_id = a.id
            and l.stage in ('replied','interested','demo','meeting_booked',
                            'pilot','customer'))                                     as replied,
         (select count(*)::int from sales.meeting m join sales.lead l on l.id = m.lead_id
           where l.agent_id = a.id)                                                  as meetings,
         (select count(*)::int from sales.message m
           where m.agent_id = a.id and m.status = 'pending_approval')                as pending_approval,
         coalesce((select sum(ce.amount_usd) from sales.cost_event ce
                    where ce.agent_id in (select node from descendants d where d.root = a.id)
                      and ce.at >= date_trunc('day', now())), 0)                     as spent_today,
         coalesce((select sum(ce.amount_usd) from sales.cost_event ce
                    where ce.agent_id in (select node from descendants d where d.root = a.id)
                      and ce.at >= date_trunc('month', now())), 0)                   as spent_month
       from sales.agent a
       where a.status <> 'archived'
       order by a.kind, a.name`,
    );
  } catch {
    return [];
  }
}

/** Order agents director → country → vertical, children under their parent. */
export function asTree(agents: AgentSummary[]): { agent: AgentSummary; depth: number }[] {
  const byParent = new Map<number | null, AgentSummary[]>();
  for (const a of agents) {
    const list = byParent.get(a.parent_id) ?? [];
    list.push(a);
    byParent.set(a.parent_id, list);
  }
  const out: { agent: AgentSummary; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const agent of byParent.get(parent) ?? []) {
      out.push({ agent, depth });
      walk(agent.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything orphaned by a missing parent still has to appear, or an agent
  // vanishes from the dashboard with no indication why.
  for (const a of agents) {
    if (!out.some((o) => o.agent.id === a.id)) out.push({ agent: a, depth: 0 });
  }
  return out;
}

export interface ActivityRow {
  id: number;
  at: Date;
  actor: string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
  lead_id: number | null;
  agent_name: string | null;
  company_name: string | null;
  company_city: string | null;
}

export async function recentActivity(limit = 50, filter?: { agentId?: number; type?: string }): Promise<ActivityRow[]> {
  if (!isConfigured()) return [];
  try {
    return await query<ActivityRow>(
      `select ac.id, ac.at, ac.actor, ac.type, ac.summary, ac.data, ac.lead_id,
              ag.name as agent_name, c.name as company_name, c.city as company_city
         from sales.activity ac
         left join sales.agent ag on ag.id = ac.agent_id
         left join sales.company c on c.id = ac.company_id
        where ($2::bigint is null or ac.agent_id = $2)
          and ($3::text is null or ac.type = $3)
        order by ac.at desc
        limit $1`,
      [limit, filter?.agentId ?? null, filter?.type ?? null],
    );
  } catch {
    return [];
  }
}

export interface QueueHealth {
  pending: number;
  running: number;
  dead: number;
  dueNow: number;
  oldestPendingMinutes: number | null;
}

export async function queueHealth(): Promise<QueueHealth> {
  const empty = { pending: 0, running: 0, dead: 0, dueNow: 0, oldestPendingMinutes: null };
  if (!isConfigured()) return empty;
  try {
    const rows = await query<QueueHealth>(
      `select
         count(*) filter (where status = 'pending')::int                          as pending,
         count(*) filter (where status = 'running')::int                          as running,
         count(*) filter (where status = 'dead')::int                             as dead,
         count(*) filter (where status = 'pending' and run_at <= now())::int      as "dueNow",
         extract(epoch from (now() - min(run_at) filter (
           where status = 'pending' and run_at <= now())))::int / 60              as "oldestPendingMinutes"
       from sales.job`,
    );
    return rows[0] ?? empty;
  } catch {
    return empty;
  }
}

export interface PipelineCounts {
  stage: string;
  n: number;
}

export async function pipelineCounts(agentId?: number): Promise<PipelineCounts[]> {
  if (!isConfigured()) return [];
  try {
    return await query<PipelineCounts>(
      `select stage::text, count(*)::int as n from sales.lead
        where ($1::bigint is null or agent_id = $1)
        group by stage`,
      [agentId ?? null],
    );
  } catch {
    return [];
  }
}

/** The CRM pipeline, in the order requirement §12 lists it. */
export const STAGE_ORDER = [
  "discovered",
  "researching",
  "qualified",
  "contacted",
  "follow_up",
  "replied",
  "interested",
  "demo",
  "meeting_booked",
  "pilot",
  "customer",
  "lost",
  "do_not_contact",
] as const;

export interface SpendRow {
  category: string;
  amount_usd: number;
  events: number;
}

export async function spendByCategory(sinceDays = 30): Promise<SpendRow[]> {
  if (!isConfigured()) return [];
  try {
    return await query<SpendRow>(
      `select category, sum(amount_usd) as amount_usd, count(*)::int as events
         from sales.cost_event
        where at >= now() - ($1 || ' days')::interval
        group by category order by sum(amount_usd) desc`,
      [String(sinceDays)],
    );
  } catch {
    return [];
  }
}
