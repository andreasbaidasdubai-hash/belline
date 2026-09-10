import pg from "pg";

/**
 * Postgres, for the sales engine only.
 *
 * The voice product keeps its JSON store untouched — nothing in `src/lib/store.ts`
 * changes, and no data moves. This is a second, additive store for a workload
 * that is genuinely different: tens of thousands of companies, indexed dedup,
 * an append-only timeline, concurrent workers claiming jobs, and reporting that
 * groups by six dimensions at once.
 *
 * `DATABASE_URL` unset is a supported state, not an error. The sales dashboard
 * renders "not configured" and every other route behaves exactly as it does
 * today — the same contract the speech and telephony providers already follow.
 */

const { Pool, types } = pg;

/**
 * `bigint` (oid 20) arrives from pg as a string, because a 64-bit integer does
 * not fit in a JS number. Every id in this schema is a bigserial and every one
 * of them is far below 2^53, so parsing to a number here buys ergonomics
 * everywhere else — `lead.id === 42` rather than `lead.id === "42"`, and no
 * accidental string concatenation in a `WHERE id = ${id}`.
 */
types.setTypeParser(20, (v) => Number(v));

/** `numeric` (1700) is also a string by default, for the same reason and with
 * a better justification — it is arbitrary precision. Money in this schema is
 * numeric(14,4); parsing to a float is safe for reading and reporting, and all
 * arithmetic that matters happens in SQL. */
types.setTypeParser(1700, (v) => Number(v));

// Next's dev server re-evaluates modules on edit and the worker may run in the
// same process. Pin the pool on the global so a hot reload does not leak
// connections until Postgres refuses new ones.
const globalRef = globalThis as unknown as { __bellineSalesPool?: pg.Pool };

export function isConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function pool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. The sales engine needs Postgres; the voice product does not.",
    );
  }
  if (!globalRef.__bellineSalesPool) {
    globalRef.__bellineSalesPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.SALES_DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Managed Postgres (Railway, Neon, Supabase) terminates TLS with a
      // certificate we have no chain for. Refusing to connect would be
      // security theatre against a connection string that already carries the
      // password; opt out explicitly rather than silently.
      ssl: sslSetting(),
    });
    // A pool that emits an unhandled 'error' takes the process down. A dropped
    // idle connection is routine — log it and let the pool replace it.
    globalRef.__bellineSalesPool.on("error", (err) => {
      console.error("[sales/db] idle client error:", err.message);
    });
  }
  return globalRef.__bellineSalesPool;
}

function sslSetting(): { rejectUnauthorized: boolean } | undefined {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.SALES_DB_SSL === "off") return undefined;
  if (/localhost|127\.0\.0\.1/.test(url) && process.env.SALES_DB_SSL !== "on") return undefined;
  return { rejectUnauthorized: false };
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const started = Date.now();
  const result = await pool().query<T>(text, params as never[]);
  const ms = Date.now() - started;
  if (ms > 1000) {
    console.warn(`[sales/db] slow query ${ms}ms: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  return result.rows;
}

/** Exactly one row, or undefined. */
export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await query<T>(text, params))[0];
}

/**
 * A transaction.
 *
 * Every pipeline handler that writes more than one row uses this, because the
 * invariants here span tables: a lead claim and its activity row, a message
 * status flip and its cost event, a suppression and the sequence stop it
 * causes. Half of any of those is worse than none.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // The connection is already gone; the transaction died with it.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** True when a failed insert was a unique-constraint violation on `constraint`. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== "23505") return false;
  return constraint ? e.constraint === constraint : true;
}

export async function close(): Promise<void> {
  if (globalRef.__bellineSalesPool) {
    await globalRef.__bellineSalesPool.end();
    globalRef.__bellineSalesPool = undefined;
  }
}
