import type pg from "pg";
import { one, pool, query } from "../db/client";

/**
 * Job queue, in Postgres.
 *
 * Not Redis and not BullMQ, for two reasons. This system does thousands of
 * jobs a day rather than millions, so throughput is not the constraint — and
 * enqueueing inside the same transaction as the write that caused it *is* the
 * constraint. "Claim the lead and schedule its research" must either both
 * happen or neither; with a separate broker that is a distributed-systems
 * problem, and here it is one `begin`.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, which is the whole trick: several
 * workers can take different rows concurrently without blocking each other and
 * without ever handing the same row to two of them.
 */

export interface JobRow<P = Record<string, unknown>> {
  id: number;
  type: string;
  payload: P;
  agent_id: number | null;
  run_id: number | null;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
}

export interface EnqueueInput {
  type: string;
  payload?: Record<string, unknown>;
  agentId?: number | null;
  runId?: number | null;
  /** When to run. Omitted means now. */
  runAt?: Date;
  /** Lower runs first. Default 100. */
  priority?: number;
  maxAttempts?: number;
  /**
   * Derived from the work, not from the moment — `research:{company}:{hash}`,
   * never a uuid. This is what stops a crash between "call the provider" and
   * "record that we called it" from spending the money twice on retry.
   */
  idempotencyKey?: string;
  /** Enqueue inside a caller's transaction. */
  client?: pg.PoolClient;
}

/**
 * Returns the new job id, or null when an identical job already exists.
 *
 * Null is the ordinary case, not an error: re-running an agent over the same
 * companies should re-enqueue nothing.
 */
export async function enqueue(input: EnqueueInput): Promise<number | null> {
  const sql = `
    insert into sales.job
      (type, payload, agent_id, run_id, run_at, priority, max_attempts, idempotency_key)
    values ($1, $2, $3, $4, coalesce($5, now()), $6, $7, $8)
    on conflict (idempotency_key) do nothing
    returning id`;
  const params = [
    input.type,
    JSON.stringify(input.payload ?? {}),
    input.agentId ?? null,
    input.runId ?? null,
    input.runAt ?? null,
    input.priority ?? 100,
    input.maxAttempts ?? 5,
    input.idempotencyKey ?? null,
  ];

  if (input.client) {
    const result = await input.client.query<{ id: number }>(sql, params);
    return result.rows[0]?.id ?? null;
  }
  const row = await one<{ id: number }>(sql, params);
  return row?.id ?? null;
}

/** Enqueue several in one round trip. Returns how many were new. */
export async function enqueueMany(inputs: EnqueueInput[]): Promise<number> {
  let created = 0;
  for (const input of inputs) {
    if (await enqueue(input)) created++;
  }
  return created;
}

/**
 * Take the next due job, or null.
 *
 * The whole claim is one statement so there is no window between choosing a
 * row and marking it taken. `skip locked` means a second worker steps over
 * anything already being claimed rather than waiting behind it.
 */
export async function claim(workerId: string): Promise<JobRow | null> {
  const row = await one<JobRow>(
    `update sales.job
        set status     = 'running',
            locked_by  = $1,
            locked_at  = now(),
            attempts   = attempts + 1,
            updated_at = now()
      where id = (
        select id from sales.job
         where status = 'pending' and run_at <= now()
         order by priority, run_at
         for update skip locked
         limit 1
      )
      returning id, type, payload, agent_id, run_id, attempts, max_attempts, idempotency_key`,
    [workerId],
  );
  return row ?? null;
}

export async function complete(jobId: number): Promise<void> {
  await query(
    `update sales.job
        set status = 'done', locked_by = null, locked_at = null,
            last_error = null, updated_at = now()
      where id = $1`,
    [jobId],
  );
}

/**
 * Exponential backoff: 30s, 2m, 8m, 32m, 2h — capped. Past `max_attempts` the
 * job becomes `dead` with its error kept, and surfaces in the dashboard.
 * A dead-letter queue nobody can see is how a pipeline stops working quietly.
 */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 4 ** Math.max(0, attempts - 1), 7200);
}

export async function fail(job: JobRow, error: unknown): Promise<"retry" | "dead"> {
  const message = error instanceof Error ? error.message : String(error);
  const dead = job.attempts >= job.max_attempts;

  await query(
    `update sales.job
        set status     = $2,
            run_at     = case when $2 = 'pending'
                              then now() + ($3 || ' seconds')::interval
                              else run_at end,
            locked_by  = null,
            locked_at  = null,
            last_error = $4,
            updated_at = now()
      where id = $1`,
    [job.id, dead ? "dead" : "pending", String(backoffSeconds(job.attempts)), message.slice(0, 2000)],
  );
  return dead ? "dead" : "retry";
}

/**
 * Return jobs a worker claimed and never finished — a crashed or killed
 * process leaves rows stuck in `running` forever otherwise. Called at worker
 * start and periodically.
 */
export async function reclaimStale(olderThanMinutes = 15): Promise<number> {
  const rows = await query<{ id: number }>(
    `update sales.job
        set status = 'pending', locked_by = null, locked_at = null,
            last_error = coalesce(last_error, 'reclaimed after worker died'),
            updated_at = now()
      where status = 'running'
        and locked_at < now() - ($1 || ' minutes')::interval
      returning id`,
    [String(olderThanMinutes)],
  );
  return rows.length;
}

export interface QueueStats {
  pending: number;
  running: number;
  dead: number;
  dueNow: number;
}

export async function stats(): Promise<QueueStats> {
  const row = await one<QueueStats>(
    `select
       count(*) filter (where status = 'pending')::int as pending,
       count(*) filter (where status = 'running')::int as running,
       count(*) filter (where status = 'dead')::int    as dead,
       count(*) filter (where status = 'pending' and run_at <= now())::int as "dueNow"
     from sales.job`,
  );
  return row ?? { pending: 0, running: 0, dead: 0, dueNow: 0 };
}

export async function listDead(limit = 50): Promise<
  (JobRow & { last_error: string; updated_at: Date })[]
> {
  return query(
    `select id, type, payload, agent_id, run_id, attempts, max_attempts,
            idempotency_key, last_error, updated_at
       from sales.job where status = 'dead'
      order by updated_at desc limit $1`,
    [limit],
  );
}

/** Put a dead job back in the queue with its attempt count reset. */
export async function retryDead(jobId: number): Promise<void> {
  await query(
    `update sales.job
        set status = 'pending', attempts = 0, run_at = now(),
            last_error = null, updated_at = now()
      where id = $1 and status = 'dead'`,
    [jobId],
  );
}

/** Close the pool so a CLI exits rather than hanging on an idle connection. */
export async function drain(): Promise<void> {
  await pool().end();
}
