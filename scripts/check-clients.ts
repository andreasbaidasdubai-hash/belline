/**
 * The client book and the projection.
 *
 * The book's totals are what the owner reads to know whether the business
 * is working, and the projection is what they plan against. Both are
 * arithmetic, and arithmetic that is not pinned drifts the first time
 * somebody "tidies" it.
 *
 *   npm run check:clients
 */

import assert from "node:assert/strict";

const { project, defaultAssumptions } = await import("../src/lib/sales/projection");
const { totalsOf, bookAsCsv, VENDOR_COST_PER_MINUTE_FILS } = await import("../src/lib/sales/clients");
type ClientRow = import("../src/lib/sales/clients").ClientRow;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function row(over: Partial<ClientRow>): ClientRow {
  return {
    tenantId: "t1",
    tenantName: "Marina Hair",
    venueId: "v1",
    venueName: "Marina Hair",
    vertical: "salon",
    owner: { name: "Sara", email: "sara@example.com" },
    since: "2026-09-01",
    planId: "business",
    planName: "Business",
    cycle: "monthly",
    status: "active",
    trialEndsOn: null,
    paymentFailedAt: null,
    mrrFils: 36500,
    minutes: { used: 100, included: 180 },
    callsThisPeriod: 40,
    bookingsLast30Days: 22,
    lastCallAt: "2026-09-12T10:00:00.000Z",
    stripeCustomerId: null,
    ...over,
  };
}

const base = {
  months: 12,
  newTrialsPerMonth: 10,
  trialGrowth: 0,
  trialConversion: 0.5,
  monthlyChurn: 0,
  arpaFils: 36500,
  minutesPerVenue: 100,
  vendorCostPerMinuteFils: 40,
  fixedCostsFils: 0,
};

console.log("\nThe projection\n");

await test("nothing in, nothing out", () => {
  const rows = project({ paying: 0, trialing: 0 }, { ...base, newTrialsPerMonth: 0 });
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r) => r.paying === 0 && r.mrrFils === 0));
});

await test("a paying base with no churn and no trials stays exactly where it is", () => {
  const rows = project({ paying: 20, trialing: 0 }, { ...base, newTrialsPerMonth: 0 });
  assert.ok(rows.every((r) => r.paying === 20 && r.mrrFils === 20 * 36500));
  assert.equal(rows[11].cumulativeRevenueFils, 12 * 20 * 36500);
});

await test("trials convert the month after they start, at the given rate", () => {
  const rows = project({ paying: 0, trialing: 4 }, base);
  // Month 1: the 4 already on trial, half convert. The 10 new ones convert in month 2.
  assert.equal(rows[0].paying, 2);
  assert.equal(rows[1].paying, 2 + 5);
  assert.equal(rows[2].paying, 2 + 5 + 5);
});

await test("churn compounds on the base", () => {
  const rows = project({ paying: 100, trialing: 0 }, { ...base, newTrialsPerMonth: 0, monthlyChurn: 0.1 });
  assert.ok(Math.abs(rows[0].paying - 90) < 1e-9);
  assert.ok(Math.abs(rows[1].paying - 81) < 1e-9);
});

await test("growth in trials compounds too", () => {
  const rows = project({ paying: 0, trialing: 0 }, { ...base, trialGrowth: 0.5 });
  assert.equal(rows[0].newTrials, 10);
  assert.equal(rows[1].newTrials, 15);
  assert.ok(Math.abs(rows[2].newTrials - 22.5) < 1e-9);
});

await test("profit is MRR less minutes at our cost less the fixed line", () => {
  const rows = project({ paying: 10, trialing: 0 }, { ...base, newTrialsPerMonth: 0, fixedCostsFils: 100000 });
  const r = rows[0];
  assert.equal(r.mrrFils, 10 * 36500);
  assert.equal(r.vendorCostFils, 10 * 100 * 40);
  assert.equal(r.profitFils, 10 * 36500 - 10 * 100 * 40 - 100000);
});

await test("a conversion or churn outside 0..1 is clamped, not obeyed", () => {
  const rows = project({ paying: 10, trialing: 10 }, { ...base, trialConversion: 3, monthlyChurn: -1 });
  assert.equal(rows[0].converted, 10);
  assert.equal(rows[0].churned, 0);
});

await test("defaults come from the book where the book has numbers, and from the plan table where not", () => {
  const empty = defaultAssumptions({ paying: 0, trialing: 0, arpaFils: null, minutesPerVenue: null, trialsLast30Days: 0 });
  assert.equal(empty.arpaFils, 36500);
  assert.equal(empty.minutesPerVenue, 120);
  assert.equal(empty.newTrialsPerMonth, 3, "a floor, so an empty book still projects something");
  const real = defaultAssumptions({ paying: 4, trialing: 2, arpaFils: 20000, minutesPerVenue: 55, trialsLast30Days: 9 });
  assert.equal(real.arpaFils, 20000);
  assert.equal(real.minutesPerVenue, 55);
  assert.equal(real.newTrialsPerMonth, 9);
});

console.log("\nThe book\n");

await test("totals count what they say they count", () => {
  const t = totalsOf(
    [
      row({ venueId: "a" }),
      row({ venueId: "b", tenantId: "t2", planId: "starter", planName: "Starter", mrrFils: 17900, minutes: { used: 30, included: 60 } }),
      row({ venueId: "c", tenantId: "t3", status: "trialing", mrrFils: 0, minutes: { used: 10, included: 30 }, trialEndsOn: "2026-09-25", since: "2026-09-10" }),
      row({ venueId: "d", tenantId: "t4", status: "cancelled", mrrFils: 0 }),
      row({ venueId: "e", tenantId: "t5", status: "active", paymentFailedAt: "2026-09-11T00:00:00Z", mrrFils: 36500, minutes: { used: 0, included: 180 } }),
      row({ venueId: "f", tenantId: "t6", status: "none", planId: null, planName: "—", mrrFils: 0, minutes: { used: 0, included: null } }),
    ],
    new Date("2026-09-13T12:00:00Z"),
  );
  assert.equal(t.clients, 6);
  assert.equal(t.venues, 6);
  assert.equal(t.paying, 3);
  assert.equal(t.trialing, 1);
  assert.equal(t.cancelled, 1);
  assert.equal(t.pastDue, 1);
  assert.equal(t.noPlan, 1);
  assert.equal(t.mrrFils, 36500 + 17900 + 36500);
  assert.equal(t.arrFils, t.mrrFils * 12);
  assert.equal(t.minutesThisPeriod, 100 + 30 + 10 + 100 + 0 + 0);
  assert.equal(t.vendorCostFils, 240 * VENDOR_COST_PER_MINUTE_FILS);
  assert.equal(t.arpaFils, Math.round((36500 + 17900 + 36500) / 3));
  assert.equal(t.trialsLast30Days, 1);
  assert.deepEqual(t.planMix, { Business: 2, Starter: 1 });
});

await test("gross margin is on paying venues' minutes, and null with no revenue", () => {
  const t = totalsOf([row({ minutes: { used: 100, included: 180 } })]);
  // 365 AED of revenue, 100 minutes at 0.40 = 40 AED of cost → 89%.
  assert.equal(t.grossMarginPct, 89);
  assert.equal(totalsOf([row({ status: "trialing", mrrFils: 0 })]).grossMarginPct, null);
});

await test("the CSV has a header, a line per venue, and survives a comma in a name", () => {
  const csv = bookAsCsv([row({ venueName: 'Azure, "The" Table' }), row({ venueId: "b" })]);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("tenant,venue,vertical,owner,email"));
  assert.ok(lines[1].includes('"Azure, ""The"" Table"'));
  assert.ok(lines[1].includes("365.00"));
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
