import type pg from "pg";
import { query } from "../db/client";

/**
 * Cost metering.
 *
 * Every external operation that spends money writes a row here, tagged with the
 * agent that caused it. That is what turns "the AI is expensive" into "the UAE
 * Dental Agent spent $4.10 yesterday, 71% of it on research" — and it is the
 * only way cost-per-meeting is a number rather than a feeling.
 *
 * Written on the same connection as the work it paid for wherever possible, so
 * a rolled-back transaction does not leave a charge for work that never
 * happened.
 */

export type CostCategory =
  | "discovery"
  | "enrichment"
  | "llm"
  | "email_verify"
  | "email_send"
  | "voice"
  | "whatsapp"
  | "calendar"
  | "other";

export interface CostInput {
  agentId?: number | null;
  leadId?: number | null;
  runId?: number | null;
  category: CostCategory;
  provider: string;
  units?: number;
  unitLabel?: string;
  amountUsd: number;
  client?: pg.PoolClient;
}

export async function record(input: CostInput): Promise<void> {
  const sql = `
    insert into sales.cost_event
      (agent_id, lead_id, run_id, category, provider, units, unit_label, amount_usd)
    values ($1, $2, $3, $4, $5, $6, $7, $8)`;
  const params = [
    input.agentId ?? null,
    input.leadId ?? null,
    input.runId ?? null,
    input.category,
    input.provider,
    input.units ?? 1,
    input.unitLabel ?? null,
    // Round to the microdollar. Token pricing produces long floats and the
    // column is numeric(14,6); rounding here keeps what is stored equal to
    // what was computed.
    Math.round(input.amountUsd * 1e6) / 1e6,
  ];

  if (input.client) {
    await input.client.query(sql, params);
    return;
  }
  await query(sql, params);
}

export interface SpendBreakdown {
  category: CostCategory;
  amount_usd: number;
  events: number;
}

/** What one agent (and everything beneath it) has spent, by category. */
export async function breakdown(
  agentId: number,
  since: Date,
): Promise<SpendBreakdown[]> {
  return query<SpendBreakdown>(
    `with recursive subtree as (
       select id from sales.agent where id = $1
       union all
       select a.id from sales.agent a join subtree s on a.parent_id = s.id
     )
     select category, sum(amount_usd) as amount_usd, count(*)::int as events
       from sales.cost_event
      where agent_id in (select id from subtree) and at >= $2
      group by category
      order by sum(amount_usd) desc`,
    [agentId, since],
  );
}

export interface UnitEconomics {
  leads: number;
  qualified: number;
  meetings: number;
  customers: number;
  spendUsd: number;
  costPerLead: number | null;
  costPerQualifiedLead: number | null;
  costPerMeeting: number | null;
  costPerCustomer: number | null;
}

/**
 * The four numbers from requirement §17, for one agent and its subtree.
 *
 * Each divisor can legitimately be zero — a new agent has no meetings — so the
 * ratios are null rather than Infinity or 0. A dashboard showing "$0.00 per
 * meeting" for an agent that has booked none is worse than showing a dash.
 */
export async function unitEconomics(agentId: number, since: Date): Promise<UnitEconomics> {
  const rows = await query<{
    leads: number;
    qualified: number;
    meetings: number;
    customers: number;
    spend: number;
  }>(
    `with recursive subtree as (
       select id from sales.agent where id = $1
       union all
       select a.id from sales.agent a join subtree s on a.parent_id = s.id
     ),
     ids as (select id from subtree)
     select
       (select count(*)::int from sales.lead
          where agent_id in (select id from ids) and created_at >= $2)              as leads,
       (select count(*)::int from sales.lead
          where agent_id in (select id from ids) and created_at >= $2
            and priority in ('hot','warm'))                                          as qualified,
       (select count(*)::int from sales.meeting m
          join sales.lead l on l.id = m.lead_id
         where l.agent_id in (select id from ids) and m.created_at >= $2)             as meetings,
       (select count(*)::int from sales.customer c
          join sales.opportunity o on o.id = c.opportunity_id
          join sales.lead l on l.id = o.lead_id
         where l.agent_id in (select id from ids) and c.created_at >= $2)             as customers,
       (select coalesce(sum(amount_usd), 0) from sales.cost_event
         where agent_id in (select id from ids) and at >= $2)                         as spend`,
    [agentId, since],
  );

  const r = rows[0] ?? { leads: 0, qualified: 0, meetings: 0, customers: 0, spend: 0 };
  const per = (n: number) => (n > 0 ? Math.round((r.spend / n) * 100) / 100 : null);

  return {
    leads: r.leads,
    qualified: r.qualified,
    meetings: r.meetings,
    customers: r.customers,
    spendUsd: Math.round(r.spend * 100) / 100,
    costPerLead: per(r.leads),
    costPerQualifiedLead: per(r.qualified),
    costPerMeeting: per(r.meetings),
    costPerCustomer: per(r.customers),
  };
}
