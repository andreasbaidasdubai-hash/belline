import { query, one } from "../db/client";

/**
 * Spending limits.
 *
 * Checked before anything that costs money, and enforced at every level of the
 * hierarchy at once: a vertical agent's call must fit inside its own daily
 * budget *and* its country manager's *and* the Director's. Checking only the
 * leaf is how four agents each stay inside $12 while the company spends $48.
 *
 * An agent that hits its cap pauses itself rather than erroring on every job
 * for the rest of the day — a paused agent is visible in the dashboard, and a
 * hundred identical failures in the dead-letter queue is not.
 */

export class BudgetExceeded extends Error {
  constructor(
    readonly agentId: number,
    readonly agentName: string,
    readonly window: "daily" | "monthly",
    readonly spent: number,
    readonly limit: number,
  ) {
    super(
      `"${agentName}" has spent $${spent.toFixed(2)} of its $${limit.toFixed(2)} ${window} budget.`,
    );
    this.name = "BudgetExceeded";
  }
}

interface LevelSpend {
  id: number;
  name: string;
  daily_budget: number | null;
  monthly_budget: number | null;
  spent_today: number;
  spent_month: number;
}

/**
 * For the agent and every ancestor: their budget, and what their whole subtree
 * has spent today and this month.
 *
 * Note the two directions. Budgets are read *up* the chain from the agent to
 * the Director; spend is summed *down* from each of those levels over
 * everything beneath it. That is what makes a country budget mean the country.
 */
async function levels(agentId: number): Promise<LevelSpend[]> {
  return query<LevelSpend>(
    `with recursive ancestors as (
       select id, parent_id, name, daily_budget, monthly_budget
         from sales.agent where id = $1
       union all
       select a.id, a.parent_id, a.name, a.daily_budget, a.monthly_budget
         from sales.agent a join ancestors an on a.id = an.parent_id
     ),
     descendants as (
       select an.id as root, an.id as node from ancestors an
       union all
       select d.root, a.id
         from sales.agent a join descendants d on a.parent_id = d.node
     )
     select an.id, an.name, an.daily_budget, an.monthly_budget,
            coalesce((select sum(ce.amount_usd) from sales.cost_event ce
                       where ce.agent_id in (select node from descendants d where d.root = an.id)
                         and ce.at >= date_trunc('day', now())), 0)   as spent_today,
            coalesce((select sum(ce.amount_usd) from sales.cost_event ce
                       where ce.agent_id in (select node from descendants d where d.root = an.id)
                         and ce.at >= date_trunc('month', now())), 0) as spent_month
       from ancestors an`,
    [agentId],
  );
}

export interface BudgetState {
  ok: boolean;
  /** The level that is out of budget, if any. */
  blockedBy?: { id: number; name: string; window: "daily" | "monthly"; spent: number; limit: number };
  spentTodayUsd: number;
  spentMonthUsd: number;
  dailyLimitUsd: number | null;
  monthlyLimitUsd: number | null;
}

export async function check(agentId: number, headroomUsd = 0): Promise<BudgetState> {
  const rows = await levels(agentId);
  const self = rows.find((r) => r.id === agentId);

  for (const level of rows) {
    if (level.daily_budget !== null && level.spent_today + headroomUsd > level.daily_budget) {
      return {
        ok: false,
        blockedBy: {
          id: level.id,
          name: level.name,
          window: "daily",
          spent: level.spent_today,
          limit: level.daily_budget,
        },
        spentTodayUsd: self?.spent_today ?? 0,
        spentMonthUsd: self?.spent_month ?? 0,
        dailyLimitUsd: self?.daily_budget ?? null,
        monthlyLimitUsd: self?.monthly_budget ?? null,
      };
    }
    if (level.monthly_budget !== null && level.spent_month + headroomUsd > level.monthly_budget) {
      return {
        ok: false,
        blockedBy: {
          id: level.id,
          name: level.name,
          window: "monthly",
          spent: level.spent_month,
          limit: level.monthly_budget,
        },
        spentTodayUsd: self?.spent_today ?? 0,
        spentMonthUsd: self?.spent_month ?? 0,
        dailyLimitUsd: self?.daily_budget ?? null,
        monthlyLimitUsd: self?.monthly_budget ?? null,
      };
    }
  }

  return {
    ok: true,
    spentTodayUsd: self?.spent_today ?? 0,
    spentMonthUsd: self?.spent_month ?? 0,
    dailyLimitUsd: self?.daily_budget ?? null,
    monthlyLimitUsd: self?.monthly_budget ?? null,
  };
}

/**
 * Gate before a paid operation. `headroomUsd` is the estimated cost of the
 * thing about to happen, so the last call of the day cannot push an agent
 * past its cap and only be noticed afterwards.
 *
 * Pauses the offending agent as a side effect: the alternative is every
 * subsequent job failing identically until midnight.
 */
export async function assertWithinBudget(agentId: number, headroomUsd = 0): Promise<void> {
  const state = await check(agentId, headroomUsd);
  if (state.ok || !state.blockedBy) return;

  const { id, name, window, spent, limit } = state.blockedBy;
  await pause(id, `Reached its ${window} budget: $${spent.toFixed(2)} of $${limit.toFixed(2)}.`);
  throw new BudgetExceeded(id, name, window, spent, limit);
}

export async function pause(agentId: number, reason: string): Promise<void> {
  const changed = await one<{ id: number }>(
    `update sales.agent
        set status = 'paused', paused_reason = $2, updated_at = now()
      where id = $1 and status = 'active'
      returning id`,
    [agentId, reason],
  );
  if (!changed) return;

  await query(
    `insert into sales.activity (agent_id, actor, type, summary, data)
     values ($1, 'system', 'agent_paused', $2, $3)`,
    [agentId, reason, JSON.stringify({ reason })],
  );
  await query(
    `insert into sales.audit_log (actor, action, entity, entity_id, after)
     values ('system', 'pause', 'agent', $1, $2)`,
    [String(agentId), JSON.stringify({ status: "paused", paused_reason: reason })],
  );
}

export async function resume(agentId: number, actor: string): Promise<void> {
  await query(
    `update sales.agent
        set status = 'active', paused_reason = null, updated_at = now()
      where id = $1 and status = 'paused'`,
    [agentId],
  );
  await query(
    `insert into sales.audit_log (actor, action, entity, entity_id, after)
     values ($1, 'resume', 'agent', $2, $3)`,
    [actor, String(agentId), JSON.stringify({ status: "active" })],
  );
}
