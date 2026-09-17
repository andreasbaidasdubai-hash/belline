import type { StaffAuditRow, User } from "../types";
import { appendStaffAudit, id, listStaffAuditRows } from "../store";
import { tryAudit } from "../sales/db/repo/activity";

/**
 * Who changed what, when, and why, for everything staff do in the console.
 *
 * Written twice, on purpose. The JSON store holds customer data and has no
 * history of its own, so the row goes there first, next to what it describes,
 * and is there whether or not a sales database exists. Where Postgres is
 * configured it is mirrored into `sales.audit_log` through `tryAudit`, which
 * swallows a database that is down: a reporting table must never turn a saved
 * change into an error the staff member retries.
 *
 * Never put a secret in `before` or `after`. A password-reset link is logged
 * as "a link was made", never as the link.
 */

export interface AuditInput {
  actor: Pick<User, "id" | "name" | "email">;
  action: string;
  entity: string;
  entityId: string | number;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

export async function staffAudit(input: AuditInput, now: Date = new Date()): Promise<StaffAuditRow> {
  const row: StaffAuditRow = {
    id: id("aud"),
    at: now.toISOString(),
    actorId: input.actor.id,
    actorName: input.actor.name || input.actor.email,
    action: input.action,
    entity: input.entity,
    entityId: String(input.entityId),
    ...(input.reason ? { reason: input.reason.slice(0, 1000) } : {}),
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
  };
  appendStaffAudit(row);
  await tryAudit({
    actor: `user:${input.actor.id}`,
    action: input.action,
    entity: input.entity,
    entityId: row.entityId,
    before: input.before,
    after: input.reason ? { ...(isObject(input.after) ? input.after : { value: input.after }), reason: input.reason } : input.after,
  });
  return row;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Newest first. */
export function listAudit(filter: { entity?: string; entityId?: string; limit?: number } = {}): StaffAuditRow[] {
  return listStaffAuditRows()
    .filter((r) => (!filter.entity || r.entity === filter.entity) && (!filter.entityId || r.entityId === filter.entityId))
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, filter.limit ?? 200);
}

/** A reason staff must give: trimmed, bounded, and at least a few characters. */
export function reasonProblem(reason: unknown): string | null {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 3) return "Say why, in a few words. It goes in the audit log.";
  if (text.length > 1000) return "Keep the reason under 1,000 characters.";
  return null;
}

export function cleanReason(reason: unknown): string {
  return typeof reason === "string" ? reason.trim().slice(0, 1000) : "";
}
