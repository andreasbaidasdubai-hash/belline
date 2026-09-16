import type pg from "pg";
import { isConfigured, query } from "../client";

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

/**
 * Audit, from a caller that may have no database.
 *
 * `audit` below needs Postgres. Three of the things most worth recording —
 * recording a venue's phone number, connecting its WhatsApp, exporting the
 * client book — happen in routes that work off the JSON store and are expected
 * to keep working when the sales database is not configured at all.
 *
 * So the row is written where there is somewhere to write it, and a reporting
 * database that is missing or briefly down never turns into a failed action.
 * It swallows deliberately and says so in the log: the alternative is a staff
 * member pressing Save, being shown an error, pressing it again, and the
 * number having changed both times.
 */
export async function tryAudit(input: Parameters<typeof audit>[0]): Promise<void> {
  if (!isConfigured()) return;
  try {
    await audit(input);
  } catch (err) {
    console.error(
      "[sales] audit row not written:",
      err instanceof Error ? err.message : String(err),
    );
  }
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
