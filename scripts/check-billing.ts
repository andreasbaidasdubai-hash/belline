/**
 * The billing engine, and the promise the pricing page makes about it.
 *
 * Two things here reach a customer directly: a number on an invoice, and a
 * claim on a pricing card. Both are tested as if somebody will argue with
 * them, because eventually somebody will.
 *
 *   npm run check:billing
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-bill-"));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, saveCall, upsertLocation, getLocation } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { PLANS, FILS, planById, annualPerMonth, notYetLive, aed } = await import(
  "../src/lib/billing/plans"
);
const { billableMinutes, periodFor, accountFor, MINUTE_DEFINITION } = await import(
  "../src/lib/billing/usage"
);
const type = await import("../src/lib/types");
void type;

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  [32m✓[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

seedIfEmpty();
const base = listLocations().find((l) => l.vertical === "salon")!;

/** A completed phone call of a given length, on a given day. */
function call(seconds: number, day: string, extra: Record<string, unknown> = {}) {
  const c = startCall(getLocation(base.id)!, "phone", "+971501234567");
  const start = new Date(`${day}T12:00:00Z`);
  return saveCall({
    ...c,
    ...extra,
    channel: (extra.channel as "phone" | "browser") ?? "phone",
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + seconds * 1000).toISOString(),
    status: (extra.status as "completed" | "failed") ?? "completed",
    outcome: "booking_created",
  });
}

console.log("\nWhat counts as a minute\n");

test("a 61-second call is two minutes, not one", () => {
  assert.equal(billableMinutes(call(61, "2026-03-02")), 2);
});

test("a 60-second call is one minute", () => {
  assert.equal(billableMinutes(call(60, "2026-03-02")), 1);
});

test("a one-second call still costs a minute, and we say so", () => {
  assert.equal(billableMinutes(call(1, "2026-03-02")), 1);
  assert.match(MINUTE_DEFINITION, /rounded up/);
});

test("a call with no duration is not billed", () => {
  assert.equal(billableMinutes(call(0, "2026-03-02")), 0);
});

test("the venue's own test console is never billed", () => {
  assert.equal(billableMinutes(call(300, "2026-03-02", { channel: "browser" })), 0);
});

test("the public demo line is our expense, not theirs", () => {
  assert.equal(billableMinutes(call(300, "2026-03-02", { isDemo: true })), 0);
});

test("a call our own server broke is not billed", () => {
  // `failed` is what reconcileStaleCalls sets when the process died mid-call.
  assert.equal(billableMinutes(call(300, "2026-03-02", { status: "failed" })), 0);
});

console.log("\nBilling periods\n");

const anchor = (startedOn: string) =>
  ({ planId: "starter", cycle: "monthly", startedOn, status: "active" }) as const;

test("a period runs from the anniversary to the next one", () => {
  const p = periodFor(anchor("2026-03-10"), "2026-03-15");
  assert.equal(p.start, "2026-03-10");
  assert.equal(p.end, "2026-04-10");
});

test("the day before the anniversary is still the previous period", () => {
  const p = periodFor(anchor("2026-03-10"), "2026-04-09");
  assert.equal(p.start, "2026-03-10");
  assert.equal(p.end, "2026-04-10");
});

test("the anniversary itself starts the new period", () => {
  const p = periodFor(anchor("2026-03-10"), "2026-04-10");
  assert.equal(p.start, "2026-04-10");
});

test("a subscription started on the 31st bills on the 28th in February", () => {
  const p = periodFor(anchor("2026-01-31"), "2026-03-01");
  assert.equal(p.start, "2026-02-28", `got ${p.start}`);
  assert.equal(p.end, "2026-03-31", `got ${p.end}`);
});

test("and goes back to the 31st in March — the anchor is remembered, not clamped", () => {
  // Clamping once and carrying the clamped day forward silently moves every
  // later invoice. This is the assertion that catches it.
  const p = periodFor(anchor("2026-01-31"), "2026-04-05");
  assert.equal(p.start, "2026-03-31", `got ${p.start}`);
  assert.equal(p.end, "2026-04-30", `got ${p.end}`);
});

test("a leap year's 29th is handled", () => {
  const p = periodFor(anchor("2028-01-31"), "2028-02-29");
  assert.equal(p.start, "2028-02-29", `got ${p.start}`);
});

test("periods do not overlap or leave a gap across a year boundary", () => {
  const sub = anchor("2026-11-30");
  let previousEnd: string | null = null;
  for (const day of ["2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"]) {
    const p = periodFor(sub, day);
    if (previousEnd) assert.equal(p.start, previousEnd, `gap or overlap at ${day}`);
    previousEnd = p.end;
  }
});

console.log("\nThe invoice\n");

function subscribe(over: Record<string, unknown>) {
  upsertLocation({
    ...getLocation(base.id)!,
    subscription: {
      planId: "business",
      cycle: "monthly",
      startedOn: "2026-03-01",
      status: "active",
      ...over,
    } as never,
  });
  return getLocation(base.id)!;
}

test("inside the allowance there is no overage", () => {
  const loc = subscribe({});
  const account = accountFor(loc, "2026-03-15")!;
  assert.equal(account.usage.overageMinutes, 0);
  assert.equal(account.bill.overage, 0);
  assert.equal(account.bill.dueNow, planById("business").monthly);
});

test("overage is exact in fils, not a float that prints wrong", () => {
  // 137 minutes at AED 1.45 is the classic IEEE 754 trap: 137 * 1.45 in
  // floating point is 198.64999999999998, which on an invoice is indefensible.
  const plan = planById("business");
  const over = 137;
  const fils = over * plan.overagePerMinute;
  assert.equal(fils, 19865);
  assert.equal(aed(fils), "AED 198.65");
  assert.ok(Number.isInteger(fils), "overage left integer arithmetic");
});

test("minutes past the allowance are charged at the plan's own rate", () => {
  // Its own month. The earlier minute tests put calls in March, and a period
  // shared between tests is a test that passes until somebody adds a call.
  const loc = subscribe({ startedOn: "2026-06-01" });
  const plan = planById("business");
  for (let i = 0; i < 200; i++) call(30, "2026-06-05");
  const account = accountFor(getLocation(loc.id)!, "2026-06-15")!;
  assert.equal(account.usage.minutes, 200);
  assert.equal(account.usage.overageMinutes, 20);
  assert.equal(account.bill.overage, 20 * plan.overagePerMinute);
  assert.equal(account.bill.dueNow, plan.monthly + 20 * plan.overagePerMinute);
});

test("calls from another period are not on this invoice", () => {
  const loc = subscribe({});
  const before = accountFor(getLocation(loc.id)!, "2026-03-15")!.usage.minutes;
  call(600, "2026-02-14");
  call(600, "2026-05-14");
  assert.equal(accountFor(getLocation(loc.id)!, "2026-03-15")!.usage.minutes, before);
});

test("the annual cycle is prepaid, so only overage is invoiced", () => {
  const loc = subscribe({ cycle: "annual" });
  const account = accountFor(getLocation(loc.id)!, "2026-03-15")!;
  assert.equal(account.bill.prepaid, true);
  assert.equal(account.bill.dueNow, account.bill.overage, "an annual plan was billed twice");
  assert.equal(account.bill.planFee, annualPerMonth(planById("business")));
});

test("annual is two months free, and the monthly equivalent never overstates it", () => {
  for (const plan of PLANS) {
    assert.equal(plan.annual, plan.monthly * 10, `${plan.name} annual is not 10 months`);
    assert.ok(
      annualPerMonth(plan) * 12 <= plan.annual,
      `${plan.name}: twelve advertised months exceed the annual charge`,
    );
  }
});

test("a trial charges nothing, whatever it uses", () => {
  const loc = subscribe({
    status: "trialing",
    trial: { endsOn: "2026-03-15", minutes: 20 },
  });
  const account = accountFor(getLocation(loc.id)!, "2026-03-10")!;
  assert.equal(account.usage.included, 20);
  assert.equal(account.bill.dueNow, 0, "a trial was invoiced");
  assert.equal(account.bill.overage, 0);
  assert.match(account.notes.join(" "), /Nothing is charged|Nothing has been charged/);
});

test("a venue with no subscription has no account rather than a zeroed one", () => {
  const loc = getLocation(base.id)!;
  const { subscription: _drop, ...without } = loc;
  upsertLocation(without as never);
  assert.equal(accountFor(getLocation(base.id)!, "2026-03-15"), null);
});

test("somebody heading for an overage is told before the invoice, not after", () => {
  const loc = subscribe({ startedOn: "2026-07-01" });
  // One day into a 31-day period, 100 minutes already used against 180 — not
  // over yet, but obviously going to be.
  for (let i = 0; i < 100; i++) call(60, "2026-07-01");
  const account = accountFor(getLocation(loc.id)!, "2026-07-01")!;
  assert.equal(account.usage.overageMinutes, 0, "already over — this tests the warning, not the charge");
  assert.ok(
    account.usage.projectedMinutes > account.usage.included,
    `projected ${account.usage.projectedMinutes} against ${account.usage.included}`,
  );
  assert.match(account.notes.join(" "), /Told now rather than on the invoice/);
});

console.log("\nWhat the website is allowed to say\n");

const PUBLIC_HTML = ["landing.html"].map((f) => path.join(ROOT, "public", f));

test("every plan's live features appear on the pricing page", () => {
  const html = PUBLIC_HTML.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  for (const plan of PLANS) {
    for (const feature of plan.features.filter((f) => f.status === "live")) {
      assert.ok(
        html.includes(feature.text),
        `${plan.name}: "${feature.text}" is live but missing from the page`,
      );
    }
  }
});

test("nothing that is not yet live appears anywhere public", () => {
  // The guarantee, rather than a promise to remember. A feature moved to
  // status "not-yet" and left on the page fails the build.
  const files = fs
    .readdirSync(path.join(ROOT, "public"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join(ROOT, "public", f));

  for (const file of files) {
    const html = fs.readFileSync(file, "utf8");
    for (const plan of PLANS) {
      for (const feature of plan.features.filter((f) => f.status === "not-yet")) {
        assert.ok(
          !html.includes(feature.text),
          `${path.basename(file)} advertises "${feature.text}", which does not work yet`,
        );
      }
    }
  }
});

test("the prices on the page are the prices in the catalogue", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "landing.html"), "utf8");
  for (const plan of PLANS) {
    assert.ok(
      html.includes(String(plan.monthly / FILS)),
      `${plan.name}: monthly price ${plan.monthly / FILS} is not on the page`,
    );
    assert.ok(
      html.includes(String(plan.includedMinutes)),
      `${plan.name}: included minutes are not on the page`,
    );
    assert.ok(
      html.includes((plan.overagePerMinute / FILS).toFixed(2)),
      `${plan.name}: overage rate is not on the page`,
    );
  }
});

test("the page explains what a minute is, in the engine's own words", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "landing.html"), "utf8");
  // Not a paraphrase: two copies of a definition drift, and the one that
  // drifts is always the one the customer read.
  assert.ok(html.includes(MINUTE_DEFINITION), "the page's definition of a minute has drifted");
});

test("the gaps are written down rather than merely absent", () => {
  const gaps = notYetLive();
  assert.ok(gaps.length > 0, "nothing is recorded as not-yet-live — is that really true?");
  for (const gap of gaps) {
    assert.ok(gap.gap.length > 40, `${gap.feature}: the reason is too thin to act on`);
  }
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
