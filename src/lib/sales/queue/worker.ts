import os from "node:os";
import crypto from "node:crypto";
import { claim, complete, fail, reclaimStale, stats, type JobRow } from "./jobs";
import { HANDLERS } from "./handlers";
import { BudgetExceeded } from "../cost/budget";

/**
 * The worker loop.
 *
 * Runs as its own process (`npm run worker`). It cannot go on Vercel for the
 * same reason the voice bridge cannot — it is a process that stays up — so it
 * belongs beside the voice server on Railway.
 *
 * Concurrency is N independent loops rather than a batch claim, because a
 * research job that takes 40 seconds should not hold up nineteen fast ones,
 * and `SKIP LOCKED` makes independent claims free.
 */

export interface WorkerOptions {
  concurrency?: number;
  /** Stop after this many jobs. Used by tests; unset runs forever. */
  maxJobs?: number;
  /** How long to wait when the queue is empty. */
  idleMs?: number;
  quiet?: boolean;
}

export class Worker {
  private readonly id: string;
  private readonly concurrency: number;
  private readonly idleMs: number;
  private readonly quiet: boolean;
  private readonly maxJobs?: number;
  private processed = 0;
  private stopping = false;
  private loops: Promise<void>[] = [];

  constructor(opts: WorkerOptions = {}) {
    this.id = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
    this.concurrency = opts.concurrency ?? Number(process.env.SALES_WORKER_CONCURRENCY ?? 4);
    this.idleMs = opts.idleMs ?? 2000;
    this.quiet = opts.quiet ?? false;
    this.maxJobs = opts.maxJobs;
  }

  get workerId(): string {
    return this.id;
  }

  async start(): Promise<void> {
    // A process that was killed leaves rows stuck in `running` forever. Nobody
    // notices until a lead silently stops progressing, so reclaim at boot.
    const reclaimed = await reclaimStale();
    if (reclaimed > 0 && !this.quiet) {
      this.log(`reclaimed ${reclaimed} job(s) left running by a previous worker`);
    }

    for (let i = 0; i < this.concurrency; i++) this.loops.push(this.loop());
    await Promise.all(this.loops);
  }

  stop(): void {
    this.stopping = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      if (this.maxJobs !== undefined && this.processed >= this.maxJobs) return;

      let job: JobRow | null;
      try {
        job = await claim(this.id);
      } catch (err) {
        // Postgres restarting, a dropped connection, a network blip. Backing
        // off beats a hot loop hammering a database that is already unwell.
        this.log(`claim failed: ${(err as Error).message}`);
        await sleep(5000);
        continue;
      }

      if (!job) {
        if (this.maxJobs !== undefined) return;
        await sleep(this.idleMs);
        continue;
      }

      this.processed++;
      await this.run(job);
    }
  }

  private async run(job: JobRow): Promise<void> {
    const handler = HANDLERS[job.type];
    const started = Date.now();

    if (!handler) {
      // Not retryable: an unknown type will still be unknown in four minutes.
      // Burn the attempts immediately so it lands in the dead-letter queue
      // where someone will see it, rather than retrying quietly for two hours.
      await fail({ ...job, attempts: job.max_attempts }, new Error(`No handler for "${job.type}".`));
      this.log(`✗ ${job.type} #${job.id} — no handler`);
      return;
    }

    try {
      await handler({ job, workerId: this.id });
      await complete(job.id);
      if (!this.quiet) this.log(`✓ ${job.type} #${job.id} (${Date.now() - started}ms)`);
    } catch (err) {
      // A budget stop is not a job failure — the agent has been paused and the
      // work is still valid. Leave it pending for after the reset rather than
      // consuming retries against a cap that will not move until midnight.
      if (err instanceof BudgetExceeded) {
        await fail({ ...job, attempts: 0, max_attempts: job.max_attempts }, err);
        this.log(`⏸ ${job.type} #${job.id} — ${err.message}`);
        return;
      }
      const outcome = await fail(job, err);
      this.log(
        `${outcome === "dead" ? "✗" : "↻"} ${job.type} #${job.id} — ${(err as Error).message}`,
      );
    }
  }

  private log(line: string): void {
    console.log(`[worker] ${line}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** For the CLI: run until interrupted, reporting the queue on the way in. */
export async function runForever(opts: WorkerOptions = {}): Promise<void> {
  const worker = new Worker(opts);
  const queue = await stats();
  console.log(
    `\n  Belline sales worker  ${worker.workerId}\n` +
      `  ${queue.pending} pending (${queue.dueNow} due now) · ${queue.running} running · ${queue.dead} dead\n`,
  );

  let stopped = false;
  const shutdown = () => {
    if (stopped) process.exit(1); // second Ctrl-C: give up on the graceful path
    stopped = true;
    console.log("\n  finishing in-flight jobs, press Ctrl-C again to force quit\n");
    worker.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await worker.start();
  console.log("  stopped\n");
}
