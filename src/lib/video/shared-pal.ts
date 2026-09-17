/**
 * The shared-PAL circuit breaker.
 *
 * A venue's reusable PAL identifies each call by the session token Belline puts
 * in `conversational_context`, and the model route only trusts that token from
 * a system message. Tavus documents that the context is "appended to any
 * context provided in the PAL"; it does not document where that lands in a
 * custom LLM's request (docs/video/tavus-notes.md). If a request arrives with a
 * venue PAL's key but no token in any system message, that assumption has
 * failed for this deployment: the venue is switched to a PAL per call, in
 * memory, until the process restarts, so the next visitor is answered.
 *
 * Nothing here ever lets such a request through.
 */

const globalRef = globalThis as unknown as { __bellineSharedPalBroken?: Map<string, number> };

function broken(): Map<string, number> {
  globalRef.__bellineSharedPalBroken ??= new Map();
  return globalRef.__bellineSharedPalBroken;
}

export function sharedContextBroken(locationId: string): boolean {
  return broken().has(locationId);
}

export function markSharedContextBroken(locationId: string): void {
  if (!broken().has(locationId)) {
    console.warn(`[video] ${locationId}: shared PAL request carried no session token in a system message — this venue now uses a PAL per call until restart`);
  }
  broken().set(locationId, Date.now());
}

/** For the checks. */
export function resetSharedPalState(): void {
  globalRef.__bellineSharedPalBroken = new Map();
}
