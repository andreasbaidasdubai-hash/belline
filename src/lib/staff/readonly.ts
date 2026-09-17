import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A request that may read and must not write.
 *
 * "View as customer" lets Belline staff open a customer's dashboard as that
 * customer sees it. The first line of defence is the custom server refusing
 * every non-GET request on such a session (view-as.ts `viewAsRefusal`). This is
 * the second: the whole request runs inside a read-only context, and every
 * mutator in store.ts calls `assertWritable()` before it touches the cache, so
 * a GET that happens to write (an OAuth callback, a backfill on render) is
 * refused too rather than quietly changing a customer's data.
 *
 * One instance per process, pinned on `globalThis`: server.ts and the Next
 * bundle load this module separately, and two AsyncLocalStorage instances
 * would never see each other's context. The same trick store.ts uses for its
 * cache.
 *
 * No `next/*` imports: server.ts and the checks use it directly.
 */

export interface ReadOnlyContext {
  /** Why writing is refused, for the error and the log. */
  reason: string;
  /** Who is looking, for the log. */
  staffUserId?: string;
  tenantId?: string;
}

const globalRef = globalThis as unknown as { __bellineReadOnly?: AsyncLocalStorage<ReadOnlyContext> };

function storage(): AsyncLocalStorage<ReadOnlyContext> {
  globalRef.__bellineReadOnly ??= new AsyncLocalStorage<ReadOnlyContext>();
  return globalRef.__bellineReadOnly;
}

export class ReadOnlyError extends Error {
  readonly status = 403;
  constructor(readonly context: ReadOnlyContext) {
    super(`Read-only: ${context.reason}. Nothing was changed.`);
    this.name = "ReadOnlyError";
  }
}

/** Run `fn` (and everything it awaits) with writes refused. */
export function runReadOnly<T>(context: ReadOnlyContext, fn: () => T): T {
  return storage().run(context, fn);
}

export function readOnlyContext(): ReadOnlyContext | undefined {
  return storage().getStore();
}

/** Throws inside a read-only request. Called first thing by every store mutator. */
export function assertWritable(): void {
  const context = storage().getStore();
  if (context) {
    console.warn(`[view-as] refused a write while ${context.reason} (staff ${context.staffUserId ?? "?"}, tenant ${context.tenantId ?? "?"})`);
    throw new ReadOnlyError(context);
  }
}
