import crypto from "node:crypto";
import type { Location, OnboardingState } from "../types";
import { snapshotOf } from "../brain";
import { flag } from "../flags";

/**
 * Whether a venue's recorded checks still describe the venue.
 *
 * Kept apart from selftest.ts, which loads the whole agent, so that journey()
 * and the home page can ask "are the checks current?" without importing a tool
 * loop.
 *
 * A fingerprint of content, not a version number. Going live publishes a
 * version of its own, and a check that went stale the moment it let somebody
 * through would be no gate at all.
 */

export type SelftestRecord = NonNullable<OnboardingState["tests"]>;

/** Everything a check's answer depends on: what the agent knows, and where bookings go. */
export function configDigest(location: Location): string {
  const o = location.onboarding;
  const basis = {
    brain: snapshotOf(location),
    destination: o?.destination ? { kind: o.destination.kind, link: o.destination.bookingLink ?? null } : null,
    requestRules: o?.requestRules ?? null,
    escalation: o?.escalation ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

/** The checks ran against exactly what the venue says now. */
export function testsCurrent(location: Location): boolean {
  const tests = location.onboarding?.tests;
  return Boolean(tests && tests.digest === configDigest(location));
}

/** The last run passed, and nothing has changed since. What the Go live gate reads. */
export function testsPassed(location: Location): boolean {
  return Boolean(location.onboarding?.tests?.passed && testsCurrent(location));
}

/** A model the checks can use: the scripted one under stubs, or the real one with a key. */
export function selftestAvailable(): boolean {
  return flag("stubs") || flag("import.model");
}

/** Checks exist, but the setup changed after them. Shown as "Re-run checks", never as a block once live. */
export function testsStale(location: Location): boolean {
  return Boolean(location.onboarding?.tests && !testsCurrent(location));
}
