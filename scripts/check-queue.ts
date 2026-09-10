/**
 * Queue integration checks.
 *
 * Needs a real Postgres — `SKIP LOCKED`, unique-constraint dedup and
 * transactional enqueue are the whole point, and none of them can be faked.
 * Skips cleanly when DATABASE_URL is unset so it is safe in a plain checkout.
 *
 *   npm run check:queue
 */

import assert from "node:assert";
import { close, isConfigured, query } from "../src/lib/sales/db/client";
import { backoffSeconds, enqueue, reclaimStale } from "../src/lib/sales/queue/jobs";
import { Worker } from "../src/lib/sales/queue/worker";

if (!isConfigured()) {
  console.log("\n  DATABASE_URL not set — skipping queue checks.\n");
  process.exit(0);
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

const TAG = `test:${Date.now()}`;

async function cleanup() {
  await query(`delete from sales.job where idempotency_key like $1`, [`${TAG}%`]);
}

console.log("\n  Queue\n");

await test("a job runs exactly once, even with several workers competing", async () => {
  const N = 40;
  for (let i = 0; i < N; i++) {
    await enqueue({ type: "noop", idempotencyKey: `${TAG}:once:${i}` });
  }

  // Two workers, four loops each — eight concurrent claimers against 40 rows
  // is the shape that would expose a claim race if SKIP LOCKED were wrong.
  const a = new Worker({ concurrency: 4, maxJobs: N, idleMs: 10, quiet: true });
  const b = new Worker({ concurrency: 4, maxJobs: N, idleMs: 10, quiet: true });
  await Promise.all([a.start(), b.start()]);

  const rows = await query<{ status: string; attempts: number }>(
    `select status, attempts from sales.job where idempotency_key like $1`,
    [`${TAG}:once:%`],
  );
  assert.strictEqual(rows.length, N, "wrong number of jobs");
  assert.ok(
    rows.every((r) => r.status === "done"),
    `${rows.filter((r) => r.status !== "done").length} job(s) did not complete`,
  );
  assert.ok(
    rows.every((r) => r.attempts === 1),
    "a job was claimed more than once — two workers ran the same row",
  );
});

await test("an identical idempotency key does not enqueue twice", async () => {
  const key = `${TAG}:idem`;
  const first = await enqueue({ type: "noop", idempotencyKey: key });
  const second = await enqueue({ type: "noop", idempotencyKey: key });
  assert.ok(first, "the first enqueue should return an id");
  assert.strictEqual(second, null, "the second should be deduped, not duplicated");

  const rows = await query(`select id from sales.job where idempotency_key = $1`, [key]);
  assert.strictEqual(rows.length, 1);
});

await test("jobs without an idempotency key are never deduped against each other", async () => {
  // `unique` on a nullable column: Postgres treats NULLs as distinct, which is
  // what we want here and worth pinning down.
  await enqueue({ type: "noop", payload: { tag: TAG } });
  await enqueue({ type: "noop", payload: { tag: TAG } });
  const rows = await query(
    `select id from sales.job where payload->>'tag' = $1 and idempotency_key is null`,
    [TAG],
  );
  assert.strictEqual(rows.length, 2);
  await query(`delete from sales.job where payload->>'tag' = $1`, [TAG]);
});

await test("a failing job retries with backoff, then dies with its error kept", async () => {
  await enqueue({
    type: "always_fails",
    idempotencyKey: `${TAG}:dead`,
    maxAttempts: 2,
  });

  // First attempt: fails, reschedules into the future.
  await new Worker({ concurrency: 1, maxJobs: 1, idleMs: 10, quiet: true }).start();
  let row = await query<{ status: string; attempts: number; last_error: string }>(
    `select status, attempts, last_error from sales.job where idempotency_key = $1`,
    [`${TAG}:dead`],
  );
  assert.strictEqual(row[0].status, "pending", "should be waiting for its retry");
  assert.strictEqual(row[0].attempts, 1);
  assert.match(row[0].last_error, /by design/);

  // Backoff put it in the future; pull it back so the test does not sleep 30s.
  await query(`update sales.job set run_at = now() where idempotency_key = $1`, [`${TAG}:dead`]);

  await new Worker({ concurrency: 1, maxJobs: 1, idleMs: 10, quiet: true }).start();
  row = await query(
    `select status, attempts, last_error from sales.job where idempotency_key = $1`,
    [`${TAG}:dead`],
  );
  assert.strictEqual(row[0].status, "dead", "should be dead after max_attempts");
  assert.strictEqual(row[0].attempts, 2);
});

await test("an unknown job type dies immediately rather than retrying for hours", async () => {
  await enqueue({ type: "no_such_handler", idempotencyKey: `${TAG}:unknown` });
  await new Worker({ concurrency: 1, maxJobs: 1, idleMs: 10, quiet: true }).start();
  const row = await query<{ status: string }>(
    `select status from sales.job where idempotency_key = $1`,
    [`${TAG}:unknown`],
  );
  assert.strictEqual(row[0].status, "dead");
});

await test("a job stranded by a killed worker is reclaimed", async () => {
  await enqueue({ type: "noop", idempotencyKey: `${TAG}:stranded` });
  // Simulate a process that died mid-job: claimed, locked, never finished.
  await query(
    `update sales.job
        set status = 'running', locked_by = 'dead-worker',
            locked_at = now() - interval '30 minutes'
      where idempotency_key = $1`,
    [`${TAG}:stranded`],
  );

  const reclaimed = await reclaimStale(15);
  assert.ok(reclaimed >= 1, "nothing was reclaimed");

  const row = await query<{ status: string }>(
    `select status from sales.job where idempotency_key = $1`,
    [`${TAG}:stranded`],
  );
  assert.strictEqual(row[0].status, "pending");
});

await test("backoff grows and is capped", async () => {
  assert.strictEqual(backoffSeconds(1), 30);
  assert.strictEqual(backoffSeconds(2), 120);
  assert.strictEqual(backoffSeconds(3), 480);
  assert.ok(backoffSeconds(20) <= 7200, "backoff must be capped");
});

await cleanup();
await close();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
