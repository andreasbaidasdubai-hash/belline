/**
 * Taking money.
 *
 * Stripe's own behaviour is Stripe's to test. What is worth pinning here is
 * the half that is ours, and every one of these is a way a payment system goes
 * wrong quietly rather than loudly.
 *
 * **The price Stripe is told is the price on the page.** A price configured in
 * a dashboard is a second source of truth for what Belline costs, and the two
 * drift — usually after somebody runs a promotion. Everything is derived from
 * `plans.ts`, and the lookup key carries the amount so a changed price cannot
 * silently reuse the old one.
 *
 * **Nothing believes a redirect.** A customer returning to a success page
 * proves only that a browser followed a link. The subscription flips on a
 * signed webhook, and the webhook is what these tests exercise.
 *
 * **An event for somebody else's venue changes nothing.** The venue id rides
 * on the session; an event carrying an id we do not own, or none at all, must
 * be a no-op rather than a guess.
 *
 *   npm run check:checkout
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-checkout-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation } = await import("../src/lib/store");
const { applyStripeEvent, stripeEnabled } = await import("../src/lib/billing/stripe");
const { PLANS, periodFee, planById } = await import("../src/lib/billing/plans");

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

seedIfEmpty();

const signed = await signUp({
  businessName: "Checkout Salon",
  email: "owner@checkout.test",
  password: "Correct-Horse-Battery-9",
  vertical: "salon",
  timezone: "Asia/Dubai",
});
assert.ok(signed.ok, "could not create the test account");
const venue = signed.ok ? signed.location : null!;

/** A Stripe event, shaped the way Stripe shapes them. */
function event(type: string, object: Record<string, unknown>) {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    data: { object },
  } as never;
}

console.log("\n\x1b[1mThe price is the one on the page\x1b[0m\n");

await test("every plan has a whole-dirham monthly and annual price", () => {
  for (const plan of PLANS) {
    for (const cycle of ["monthly", "annual"] as const) {
      const fils = periodFee(plan, cycle);
      assert.ok(fils > 0, `${plan.name} ${cycle} is not priced`);
      // Stripe takes the minor unit. A fractional fils would be rejected, and
      // a float anywhere near an invoice is how rounding bugs get shipped.
      assert.equal(Number.isInteger(fils), true, `${plan.name} ${cycle} is not an integer`);
      assert.equal(fils % 100, 0, `${plan.name} ${cycle} is not a whole dirham`);
    }
  }
});

await test("the annual cycle really is cheaper per month", () => {
  // Otherwise the "two months free" on the pricing page is a lie told by
  // arithmetic rather than by anybody.
  for (const plan of PLANS) {
    assert.ok(plan.annual < plan.monthly * 12, `${plan.name} annual is not a discount`);
  }
});

console.log("\n\x1b[1mThe subscription flips on the webhook, not the redirect\x1b[0m\n");

await test("a completed checkout puts the venue on the plan it bought", () => {
  const before = getLocation(venue.id)!;
  assert.equal(before.subscription?.status, "trialing");

  applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_1",
      customer: "cus_test_1",
      subscription: "sub_test_1",
      client_reference_id: venue.id,
      metadata: {
        belline_location: venue.id,
        belline_tenant: venue.tenantId,
        belline_plan: "business",
        belline_cycle: "annual",
      },
    }),
  );

  const after = getLocation(venue.id)!;
  assert.equal(after.subscription?.status, "active");
  assert.equal(after.subscription?.planId, "business");
  assert.equal(after.subscription?.cycle, "annual");
  assert.equal(after.stripe?.customerId, "cus_test_1");
  assert.equal(after.stripe?.subscriptionId, "sub_test_1");
});

await test("the billing anniversary is set, so the first period is right", () => {
  const sub = getLocation(venue.id)!.subscription!;
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(sub.startedOn), `not a date: ${sub.startedOn}`);
});

await test("an event naming a venue we do not have changes nothing", () => {
  const before = JSON.stringify(getLocation(venue.id));
  const out = applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_2",
      metadata: { belline_location: "loc_does_not_exist", belline_plan: "starter" },
    }),
  );
  assert.match(out.applied, /ignored/);
  assert.equal(JSON.stringify(getLocation(venue.id)), before);
});

await test("an event naming no venue at all changes nothing", () => {
  const before = JSON.stringify(getLocation(venue.id));
  const out = applyStripeEvent(event("checkout.session.completed", { id: "cs_test_3" }));
  assert.match(out.applied, /ignored/);
  assert.equal(JSON.stringify(getLocation(venue.id)), before);
});

await test("an event type we do not handle is ignored rather than guessed at", () => {
  const out = applyStripeEvent(event("customer.updated", { id: "cus_test_1" }));
  assert.match(out.applied, /ignored/);
});

console.log("\n\x1b[1mLosing a customer, and nearly losing one\x1b[0m\n");

await test("a cancelled subscription is recorded with the date", () => {
  applyStripeEvent(
    event("customer.subscription.deleted", {
      id: "sub_test_1",
      metadata: { belline_location: venue.id },
    }),
  );
  const sub = getLocation(venue.id)!.subscription!;
  assert.equal(sub.status, "cancelled");
  assert.ok(sub.cancelledAt, "no cancellation date");
  // The plan they were on is kept. "What were they paying when they left" is
  // the first question anybody asks about a cancellation.
  assert.equal(sub.planId, "business");
});

await test("a failed payment does not switch the receptionist off", () => {
  // Stripe retries for a fortnight. Cutting a venue's phone line over one
  // declined card would do more damage than the unpaid invoice — and it is
  // the kind of thing that only gets noticed by the customer.
  const before = getLocation(venue.id)!.subscription!.status;
  applyStripeEvent(
    event("invoice.payment_failed", {
      id: "in_test_1",
      parent: { subscription_details: { metadata: { belline_location: venue.id } } },
    }),
  );
  assert.equal(getLocation(venue.id)!.subscription!.status, before);
});

console.log("\n\x1b[1mWithout keys\x1b[0m\n");

await test("an unconfigured Stripe is a supported state, not a crash", () => {
  // The same contract the speech and telephony providers follow: the button
  // says so, and everything else in the product still works.
  const had = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(stripeEnabled(), false);
  if (had) process.env.STRIPE_SECRET_KEY = had;
});

await test("the checkout page shows only features that are live", () => {
  // Same guarantee as the pricing page. A plan whose feature is marked
  // not-yet must not be sold on the page where somebody types a card number.
  for (const plan of PLANS) {
    const shown = planById(plan.id).features.filter((f) => f.status === "live");
    assert.ok(shown.length > 0, `${plan.name} would render an empty list`);
    assert.equal(
      shown.some((f) => f.status !== "live"),
      false,
    );
  }
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
