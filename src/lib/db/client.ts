import pg from "pg";

/**
 * Postgres.
 *
 * The JSON book in `src/lib/store.ts` is untouched and stays where it is: it
 * holds venues, bookings and calls, it is small, it is atomic, and rewriting it
 * would be a large change with no user visible on the other side.
 *
 * This is the second, additive store, for the workloads that are genuinely a
 * different shape — the sales engine (tens of thousands of companies, indexed
 * dedup, workers claiming jobs) and reception conversations (message volume, a
 * unique index doing duplicate-webhook defence, two writers on one row while a
 * customer and a member of staff both type).
 *
 * It began under `sales/` because the sales engine needed it first. It is
 * here now because reception needs the same pool, and two pools on two globals
 * is how a process ends up being refused connections.
 *
 * `DATABASE_URL` unset is a supported state, not an error — the same contract
 * the speech and telephony providers already follow.
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
const globalRef = globalThis as unknown as { __bellineDbPool?: pg.Pool };

export function isConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function pool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. The sales engine and WhatsApp reception need Postgres; voice does not.",
    );
  }
  if (!globalRef.__bellineDbPool) {
    globalRef.__bellineDbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? process.env.SALES_DB_POOL_MAX ?? 10),
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
    globalRef.__bellineDbPool.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
  }
  return globalRef.__bellineDbPool;
}

function sslSetting(): { rejectUnauthorized: boolean } | undefined {
  const url = process.env.DATABASE_URL ?? "";
  const ssl = process.env.DB_SSL ?? process.env.SALES_DB_SSL;
  if (ssl === "off") return undefined;
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
    console.warn(`[db] slow query ${ms}ms: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
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
  if (globalRef.__bellineDbPool) {
    await globalRef.__bellineDbPool.end();
    globalRef.__bellineDbPool = undefined;
  }
}
