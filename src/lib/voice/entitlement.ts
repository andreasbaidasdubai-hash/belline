import type { Location } from "../types";

/**
 * May a signed stream token open a call to this venue?
 *
 * Lives here rather than inline in server.ts because it is a security
 * decision, and a security decision that cannot be unit-tested gets changed
 * by someone in a hurry. It has already been wrong once: widening it for
 * Belline's own venue silently removed the spend cap, and the version before
 * that rejected the venue outright with a 403 nobody could diagnose from the
 * browser.
 *
 * Two conditions, and both matter:
 *
 *   It must be ours to spend on — a prospect demo built from a public
 *   website, or Belline's own venue behind the bell. Never a customer's. A
 *   leaked token must not become free calls on their bill or a stranger
 *   reading their diary.
 *
 *   It must be capped. `checkDemoGate` only caps a venue with `demo.enabled`,
 *   so without it a public line spends real money with three vendors for
 *   every second anybody leaves it open.
 */
export function mayStreamTo(location: Location | undefined): boolean {
  if (!location) return false;
  const ours = Boolean(location.prospect || location.internal);
  return ours && Boolean(location.demo?.enabled);
}

/**
 * Liveness for one websocket.
 *
 * Separated from the sweep so both halves can be tested together, because the
 * two got out of step once and it cost every call in production.
 *
 * A `noServer` websocket server driven by `handleUpgrade` never emits
 * `connection` — the upgrade callback *is* the connection. Registering the
 * pong listener on that event therefore registered it nowhere: the first
 * sweep pinged and marked the socket not-alive, no pong was ever recorded,
 * and the next sweep terminated it. Every call died at about fifty seconds,
 * killed by the code written to stop calls dying.
 */
export interface Liveness {
  isAlive?: boolean;
  readyState?: number;
  on(event: "pong", listener: () => void): unknown;
  ping(): void;
  send(data: string): void;
  terminate(): void;
}

/**
 * What the sweep sends to keep a proxy from closing the line.
 *
 * A protocol-level ping is the obvious thing and it is not enough. Measured
 * against production: the server pinged at 21.7s, 46.7s, 71.7s and 96.7s, the
 * client answered every one, and the connection still died at 96.9s with
 * close code 1006 — an abnormal termination with no close frame, which is
 * what a proxy killing an idle connection looks like from the inside. The
 * last *application* data had been at 1.7s.
 *
 * So the proxy counts application frames toward idle and ignores control
 * frames. This is an application frame. The client has no case for it and
 * ignores it, which is exactly what it is for.
 */
export const KEEPALIVE_FRAME = JSON.stringify({ type: "keepalive" });

/** ws.OPEN. Written out so this module needs no dependency on `ws`. */
const OPEN = 1;

/** Mark a socket live and keep it marked. Call this per connection. */
export function watchLiveness(ws: Liveness): void {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
}

/**
 * One heartbeat sweep. Terminates whatever failed to answer the last ping.
 *
 * Returns how many were terminated, which is the only thing worth asserting
 * about it — and would have been zero, every time, on a socket being watched.
 */
export function sweepLiveness(clients: Iterable<Liveness>): number {
  let dropped = 0;
  for (const client of clients) {
    if (client.isAlive === false) {
      client.terminate();
      dropped++;
      continue;
    }
    client.isAlive = false;
    // The ping is for us — it is how we learn the far end is still there.
    client.ping();
    // The frame is for whatever sits between us. See KEEPALIVE_FRAME.
    if (client.readyState === undefined || client.readyState === OPEN) {
      try {
        client.send(KEEPALIVE_FRAME);
      } catch {
        // A socket that has gone since the readyState check. The next sweep
        // terminates it; failing to keep it warm is not worth throwing over.
      }
    }
  }
  return dropped;
}
