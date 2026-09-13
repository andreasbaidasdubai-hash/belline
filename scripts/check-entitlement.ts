/**
 * When Belline stops answering a venue — and, more importantly, when it never does.
 *
 * The trial used to be decorative: fourteen days and thirty minutes were
 * written at signup and consulted by nothing on a call path. The half of these
 * tests that matters most is the second half — a paying venue past its
 * allowance, or a trial while card payments are switched off, must keep
 * being answered.
 *
 *   npm run check:entitlement
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-entitle-"));
delete process.env.STRIPE_SECRET_KEY;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, upsertLocation, saveCall, listLocations } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { lapseOf, serviceState } = await import("../src/lib/billing/entitlement");
const { todayIn } = await import("../src/lib/time");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

seedIfEmpty();

const made = await signUp({
  businessName: "Jumeirah Smile Studio",
  email: "owner@smile.test",
  password: "Correct-Horse-Battery-9",
  vertical: "clinic",
  timezone: "Asia/Dubai",
});
assert.ok(made.ok, "signup failed");
const venueId = made.ok ? made.location.id : "";
const fresh = () => getLocation(venueId)!;
const today = todayIn("Asia/Dubai");

console.log("\n\x1b[1mA trial ends\x1b[0m\n");

test("a new trial is answered", () => {
  assert.equal(lapseOf(fresh(), today), null);
  assert.equal(serviceState(fresh(), today, { enforce: true }).answering, true);
});

test("the day after the trial ends, it has lapsed", () => {
  const after = addDays(fresh().subscription!.trial!.endsOn, 1);
  assert.equal(lapseOf(fresh(), after), "trial_ended");
  const state = serviceState(fresh(), after, { enforce: true });
  assert.equal(state.answering, false);
  assert.match(state.callerMessage ?? "", /Jumeirah Smile Studio/);
  // The caller is a patient, not the account holder. Money is not their business.
  assert.doesNotMatch(state.callerMessage ?? "", /trial|plan|pay|subscri/i);
});

test("the last day of the trial is still answered", () => {
  assert.equal(lapseOf(fresh(), fresh().subscription!.trial!.endsOn), null);
});

test("test-console calls do not use up the trial", () => {
  const call = startCall(fresh(), "browser", "browser-console");
  call.status = "completed";
  call.startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  call.endedAt = new Date().toISOString();
  saveCall(call);
  assert.equal(lapseOf(fresh(), today), null);
});

test("thirty live minutes use up the trial", () => {
  const call = startCall(fresh(), "phone", "+971501234567");
  call.status = "completed";
  call.startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  call.endedAt = new Date().toISOString();
  saveCall(call);
  assert.equal(lapseOf(fresh(), today), "trial_minutes_used");
});

console.log("\n\x1b[1mAnd when nothing stops\x1b[0m\n");

test("with card payments off, a lapsed trial keeps answering — and still says it lapsed", () => {
  const state = serviceState(fresh(), today);
  assert.equal(state.answering, true);
  assert.equal(state.lapsed, "trial_minutes_used");
});

test("a paying venue far past its allowance is never stopped", () => {
  const v = fresh();
  upsertLocation({ ...v, subscription: { ...v.subscription!, status: "active", trial: undefined } });
  assert.equal(lapseOf(fresh(), addDays(today, 200)), null);
  assert.equal(serviceState(fresh(), today, { enforce: true }).answering, true);
});

test("a failed card does not stop the phone while Stripe retries", () => {
  const v = fresh();
  upsertLocation({ ...v, subscription: { ...v.subscription!, paymentFailedAt: new Date().toISOString() } });
  assert.equal(serviceState(fresh(), today, { enforce: true }).answering, true);
});

test("a cancelled plan answers to the end of the paid period, then stops", () => {
  const v = fresh();
  const startedOn = addDays(today, -40);
  upsertLocation({
    ...v,
    subscription: { ...v.subscription!, status: "cancelled", startedOn, cancelledAt: `${addDays(today, -1)}T10:00:00Z` },
  });
  assert.equal(lapseOf(fresh(), today), null);
  assert.equal(lapseOf(fresh(), addDays(today, 40)), "cancelled");
});

test("demo lines and our own venues are never lapsed", () => {
  for (const l of listLocations({ includeInternal: true }).filter((l) => l.demo?.enabled || l.internal)) {
    const expired = {
      ...l,
      subscription: { planId: "starter" as const, cycle: "monthly" as const, startedOn: "2020-01-01", status: "trialing" as const, trial: { endsOn: "2020-01-15", minutes: 30 } },
    };
    assert.equal(lapseOf(expired, today), null, l.name);
  }
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
