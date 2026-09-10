import type pg from "pg";
import { query } from "../client";

/**
 * The lead timeline. Append-only, forever.
 *
 * Takes an optional client so it can be written inside the transaction that
 * caused it — a stage change and its activity row must both happen or neither,
 * or the timeline stops being a record of what occurred and becomes a record
 * of what mostly occurred.
 */

export type ActivityType =
  | "discovered"
  | "imported"
  | "merged"
  | "claim_conflict"
  | "researched"
  | "scored"
  | "drafted"
  | "approved"
  | "rejected"
  | "sent"
  | "opened"
  | "replied"
  | "classified"
  | "demo_issued"
  | "demo_used"
  | "meeting_booked"
  | "stage_changed"
  | "suppressed"
  | "agent_paused"
  | "error";

export interface ActivityInput {
  leadId?: number | null;
  companyId?: number | null;
  agentId?: number | null;
  /** `agent:12`, `user:usr_abc`, or `system`. Never blank — the first question
   *  anyone asks of an audit trail is who did this. */
  actor: string;
  type: ActivityType;
  summary: string;
  data?: Record<string, unknown>;
  client?: pg.PoolClient;
}

export async function log(input: ActivityInput): Promise<void> {
  const sql = `insert into sales.activity
                 (lead_id, company_id, agent_id, actor, type, summary, data)
               values ($1, $2, $3, $4, $5, $6, $7)`;
  const params = [
    input.leadId ?? null,
    input.companyId ?? null,
    input.agentId ?? null,
    input.actor,
    input.type,
    input.summary.slice(0, 500),
    JSON.stringify(input.data ?? {}),
  ];
  if (input.client) {
    await input.client.query(sql, params);
    return;
  }
  await query(sql, params);
}

/** Configuration and approval changes, kept separately from the lead timeline. */
export async function audit(input: {
  actor: string;
  action: string;
  entity: string;
  entityId: string | number;
  before?: unknown;
  after?: unknown;
  client?: pg.PoolClient;
}): Promise<void> {
  const sql = `insert into sales.audit_log (actor, action, entity, entity_id, before, after)
               values ($1, $2, $3, $4, $5, $6)`;
  const params = [
    input.actor,
    input.action,
    input.entity,
    String(input.entityId),
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
  ];
  if (input.client) {
    await input.client.query(sql, params);
    return;
  }
  await query(sql, params);
}
