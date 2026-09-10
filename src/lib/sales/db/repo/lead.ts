import type pg from "pg";
import { isUniqueViolation } from "../client";
import { log } from "./activity";

/**
 * Leads, and the one-agent-per-company guarantee.
 *
 * A company is a fact about the world and exists once; a lead is one agent's
 * pursuit of it. `lead_one_active_per_company` — a partial unique index over
 * every stage except `lost` and `do_not_contact` — makes it impossible for two
 * agents to be pursuing the same business at the same time.
 *
 * The important design decision is what happens when that index fires. It is
 * *not* swallowed and it is *not* raised: it becomes a `lead_claim_conflict`
 * row for the country manager to arbitrate. A dropped claim loses a prospect
 * silently; a raised error puts a routine, expected event in the dead-letter
 * queue. Neither is what you want when a multi-speciality clinic matches both
 * the Dental and the Clinic agent — which it will, constantly.
 */

export type LeadStage =
  | "discovered"
  | "researching"
  | "qualified"
  | "contacted"
  | "follow_up"
  | "replied"
  | "interested"
  | "demo"
  | "meeting_booked"
  | "pilot"
  | "customer"
  | "lost"
  | "do_not_contact";

export interface LeadRow {
  id: number;
  company_id: number;
  agent_id: number;
  campaign_id: number | null;
  contact_id: number | null;
  stage: LeadStage;
  current_score: number | null;
  priority: "hot" | "warm" | "low" | null;
  language: string | null;
  owner_user_id: string | null;
}

export type ClaimResult =
  | { ok: true; lead: LeadRow; created: boolean }
  | {
      ok: false;
      reason: "held_by_another_agent";
      holder: { leadId: number; agentId: number; agentName: string; stage: LeadStage };
    };

export async function claim(
  c: pg.PoolClient,
  input: { companyId: number; agentId: number; campaignId?: number | null; language?: string | null },
): Promise<ClaimResult> {
  // An existing lead for *this* agent is not a conflict — re-running an agent
  // over companies it already holds is the normal case, not a collision.
  const mine = await c.query<LeadRow>(
    `select * from sales.lead where company_id = $1 and agent_id = $2 limit 1`,
    [input.companyId, input.agentId],
  );
  if (mine.rows[0]) return { ok: true, lead: mine.rows[0], created: false };

  try {
    const inserted = await c.query<LeadRow>(
      `insert into sales.lead (company_id, agent_id, campaign_id, language, stage)
       values ($1, $2, $3, $4, 'discovered')
       returning *`,
      [input.companyId, input.agentId, input.campaignId ?? null, input.language ?? null],
    );
    return { ok: true, lead: inserted.rows[0], created: true };
  } catch (err) {
    if (!isUniqueViolation(err, "lead_one_active_per_company")) throw err;

    const holder = await c.query<{
      id: number;
      agent_id: number;
      stage: LeadStage;
      agent_name: string;
    }>(
      `select l.id, l.agent_id, l.stage, a.name as agent_name
         from sales.lead l join sales.agent a on a.id = l.agent_id
        where l.company_id = $1 and l.stage not in ('lost','do_not_contact')
        limit 1`,
      [input.companyId],
    );
    const held = holder.rows[0];
    if (!held) throw err; // The index fired but nothing holds it — genuinely wrong.

    await c.query(
      `insert into sales.lead_claim_conflict (company_id, holding_lead, claiming_agent)
       values ($1, $2, $3)`,
      [input.companyId, held.id, input.agentId],
    );
    await log({
      client: c,
      companyId: input.companyId,
      agentId: input.agentId,
      actor: `agent:${input.agentId}`,
      type: "claim_conflict",
      summary: `Already held by ${held.agent_name} at stage ${held.stage}`,
      data: { holdingLead: held.id, holdingAgent: held.agent_id },
    });

    return {
      ok: false,
      reason: "held_by_another_agent",
      holder: {
        leadId: held.id,
        agentId: held.agent_id,
        agentName: held.agent_name,
        stage: held.stage,
      },
    };
  }
}

/**
 * Move a lead through the pipeline.
 *
 * Stage changes are made by application code from observed events, never by a
 * model — an LLM proposing "this lead is now interested" is a suggestion, and
 * the code that acts on the classification is what writes it.
 */
export async function setStage(
  c: pg.PoolClient,
  input: {
    leadId: number;
    stage: LeadStage;
    actor: string;
    reason?: string;
    closedReason?: string | null;
  },
): Promise<void> {
  const before = await c.query<{ stage: LeadStage; agent_id: number; company_id: number }>(
    `select stage, agent_id, company_id from sales.lead where id = $1`,
    [input.leadId],
  );
  const previous = before.rows[0];
  if (!previous || previous.stage === input.stage) return;

  await c.query(
    `update sales.lead
        set stage = $2, stage_changed_at = now(), updated_at = now(),
            closed_reason = coalesce($3, closed_reason)
      where id = $1`,
    [input.leadId, input.stage, input.closedReason ?? null],
  );

  await log({
    client: c,
    leadId: input.leadId,
    companyId: previous.company_id,
    agentId: previous.agent_id,
    actor: input.actor,
    type: "stage_changed",
    summary: input.reason ?? `${previous.stage} → ${input.stage}`,
    data: { from: previous.stage, to: input.stage },
  });
}

export async function setScore(
  c: pg.PoolClient,
  input: {
    leadId: number;
    score: number;
    priority: "hot" | "warm" | "low";
    breakdown: unknown;
    reason: string;
    modelVersion: string;
  },
): Promise<void> {
  await c.query(
    `insert into sales.lead_score (lead_id, score, priority, breakdown, reason, model_version)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      input.leadId,
      input.score,
      input.priority,
      JSON.stringify(input.breakdown),
      input.reason,
      input.modelVersion,
    ],
  );
  // The cache on `lead`, written in the same transaction as the immutable row
  // it summarises — so the two can never disagree.
  await c.query(
    `update sales.lead set current_score = $2, priority = $3, updated_at = now() where id = $1`,
    [input.leadId, input.score, input.priority],
  );
}
