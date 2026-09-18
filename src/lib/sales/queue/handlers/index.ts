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

  /**
   * Send whatever an approved batch has scheduled for now, then check health.
   *
   * Safe to run twice: `dispatchDue` only picks items still in `planned` or
   * `queued`, moves each to `sending` before the provider call and to `sent`
   * after, and the unique index on (lead_id, step) means a retry that races
   * cannot produce a second message to the same person.
   *
   * With no credentials it returns immediately having done nothing, which is
   * the correct behaviour for a worker running every few minutes in an
   * environment where the engine is not set up.
   */
  outreach_send: async () => {
    const { dispatchDue } = await import("../../sending/dispatch");
    const { watchHealth } = await import("../../sending/watch");
    const origin = (process.env.PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
    if (!origin) throw new Error("PUBLIC_ORIGIN is not set, so no unsubscribe link could be built.");
    const result = await dispatchDue({ origin });
    if (result.inert) return;
    await watchHealth();
  },
};

export function isKnownType(type: string): boolean {
  return type in HANDLERS;
}
