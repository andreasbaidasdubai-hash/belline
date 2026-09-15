/**
 * How often one address may sign up.
 *
 * In memory, per process, and reset by a redeploy — which is fine for what it
 * is defending against: a script that finds the endpoint and creates ten
 * thousand tenants overnight. Something stronger belongs in front of the
 * whole service rather than inside one route handler.
 *
 * Two buckets, because they defend against different things. Accounts
 * actually created are the expensive part, so those are few. Refused attempts
 * are cheap and mostly a person fighting the form — a short password, a typo
 * in the email — so they get a much higher ceiling. The first version counted
 * every attempt in one bucket, and five wrong passwords locked a real
 * customer out for an hour.
 */

export interface LimitOptions {
  maxAccounts: number;
  maxRefused: number;
  windowMs: number;
}

export const SIGNUP_LIMITS: LimitOptions = {
  maxAccounts: 5,
  maxRefused: 40,
  windowMs: 60 * 60 * 1000,
};

export function createSignupLimiter(opts: LimitOptions = SIGNUP_LIMITS) {
  const accounts = new Map<string, number[]>();
  const refused = new Map<string, number[]>();

  const recent = (map: Map<string, number[]>, key: string, now: number) => {
    const hits = (map.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (hits.length) map.set(key, hits);
    else map.delete(key);
    return hits;
  };

  const prune = (map: Map<string, number[]>, now: number) => {
    // Keep the maps from growing without bound on a long-lived process.
    if (map.size <= 5000) return;
    for (const [key, times] of map) {
      if (!times.some((t) => now - t < opts.windowMs)) map.delete(key);
    }
  };

  return {
    /** Checked before the attempt. Does not count it. */
    blocked(key: string, now = Date.now()): boolean {
      return (
        recent(accounts, key, now).length >= opts.maxAccounts ||
        recent(refused, key, now).length >= opts.maxRefused
      );
    },
    /** Counted after the attempt, in the bucket its outcome belongs to. */
    record(key: string, created: boolean, now = Date.now()): void {
      const map = created ? accounts : refused;
      map.set(key, [...recent(map, key, now), now]);
      prune(map, now);
    },
  };
}

/**
 * Who is asking, as well as a route handler can tell.
 *
 * The proxy's `x-forwarded-for` first, then `x-real-ip`, then the socket
 * address server.ts stamps on every request (overwriting anything a client
 * sent under that name). Only when all three are missing does a request fall
 * into the shared "unknown" bucket, which used to be everybody.
 */
export const PEER_HEADER = "x-belline-peer";

export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || headers.get(PEER_HEADER)?.trim() || "unknown";
}
