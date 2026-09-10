import type { JobRow } from "../jobs";

/**
 * The handler registry.
 *
 * One entry per pipeline stage (docs/sales-engine/PIPELINE.md). Handlers are
 * added here as each stage lands; the worker needs no changes to run a new one.
 *
 * A handler must be safe to run twice. The queue guarantees at-least-once
 * delivery, not exactly-once — a process killed between "send the email" and
 * "record that we sent it" will retry, and the only thing standing between
 * that and a prospect receiving the same message twice is the handler's own
 * idempotency.
 */

export interface HandlerContext {
  job: JobRow;
  workerId: string;
}

export type Handler = (ctx: HandlerContext) => Promise<void>;

export const HANDLERS: Record<string, Handler> = {
  /**
   * Does nothing, on purpose. Exercises claim → run → complete, and is what
   * the concurrency and idempotency checks in `npm run check:queue` run
   * against — a queue test that needs a working pipeline tests neither well.
   */
  noop: async () => {},

  /** Deliberately always throws, to exercise backoff and the dead-letter path. */
  always_fails: async () => {
    throw new Error("this handler always fails, by design");
  },
};

export function isKnownType(type: string): boolean {
  return type in HANDLERS;
}
