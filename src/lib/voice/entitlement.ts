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
