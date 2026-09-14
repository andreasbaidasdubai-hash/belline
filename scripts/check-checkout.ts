/**
 * Taking money.
 *
 * Stripe's own behaviour is Stripe's to test. What is worth pinning here is
 * the half that is ours, and every one of these is a way a payment system goes
 * wrong quietly rather than loudly.
 *
 * **The price Stripe is told is the price on the page.** Everything is derived
 * from `plans.ts` — one Stripe price per product, market and cycle — and the
 * lookup key carries the amount, so a changed price cannot reuse the old one.
 *
 * **Nothing believes a redirect.** The subscription flips on a signed webhook,
 * and the webhook is what these tests exercise.
 *
 * **An event for somebody else's venue, or for a plan we would not sell,
 * changes nothing.**
 *
 * **The trial takes no card.** Confirmed as a decision before Stripe goes
 * live: the card is taken when a plan is chosen, never at signup.
 *
 *   npm run check:checkout
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-checkout-"));
delete process.env.STRIPE_TAX;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, upsertLocation } = await import("../src/lib/store");
const { activateFree, applyStripeEvent, checkoutParams, lookupKeyFor, stripeEnabled } = await import(
  "../src/lib/billing/stripe"
);
const { grandfatherLegacyPlans } = await import("../src/lib/billing/grandfather");
const { MARKET_CODES } = await import("../src/lib/markets");
const { GRANDFATHER_DAYS, TRIAL, annualPerMonth, periodFee, priceOf, sellable } = await import("../src/lib/billing/plans");
const { addDays, todayIn } = await import("../src/lib/time");

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

async function account(name: string, extra: Record<string, unknown> = {}) {
  const signed = await signUp({
    businessName: name,
    email: `owner@${name.toLowerCase().replace(/\W+/g, "")}.test`,
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
    ...extra,
  });
  assert.ok(signed.ok, `could not create ${name}`);
  return signed.ok ? signed.location : null!;
}

const venue = await account("Checkout Salon");

/** A Stripe event, shaped the way Stripe shapes them. */
function event(type: string, object: Record<string, unknown>) {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, data: { object } } as never;
}

console.log("\n\x1b[1mThe price is the one on the page\x1b[0m\n");

await test("every sellable product has a whole-unit price for both cycles, in every market", () => {
  for (const market of MARKET_CODES) {
    for (const product of sellable(market)) {
      for (const cycle of ["monthly", "annual"] as const) {
        const minor = periodFee([product.id], market, cycle);
        assert.equal(Number.isInteger(minor), true, `${product.id} ${market} ${cycle}`);
        assert.equal(minor % 100, 0, `${product.id} ${market} ${cycle} is not a whole unit`);
      }
    }
  }
});

await test("the annual per-month figure is a price, not a minor-unit count, and below monthly", () => {
  // It once rendered "AED 14,900 a month" because the page multiplied again.
  for (const product of sellable("AE").filter((p) => !p.free)) {
    const perMonth = annualPerMonth([product.id], "AE");
    assert.ok(perMonth < priceOf(product.id, "AE"), `${product.name}: ${perMonth}`);
    assert.equal(perMonth % 100, 0);
  }
});

await test("a lookup key names the product, market, cycle and amount — so a new price is a new key", () => {
  assert.equal(lookupKeyFor("phone_starter", "GB", "monthly"), "belline_phone_starter_gb_monthly_3500");
  assert.equal(lookupKeyFor("phone_starter", "AE", "annual"), "belline_phone_starter_ae_annual_199000");
});

const params = checkoutParams(
  {
    location: venue,
    products: ["chat", "phone_starter"],
    market: "AE",
    cycle: "monthly",
    email: "owner@checkoutsalon.test",
    successUrl: "https://app.belline.ai/billing?paid=1",
    cancelUrl: "https://app.belline.ai/checkout?cancelled=1",
  },
  ["price_chat", "price_phone"],
);

await test("a subscription is one line per product", () => {
  assert.deepEqual(params.line_items, [
    { price: "price_chat", quantity: 1 },
    { price: "price_phone", quantity: 1 },
  ]);
  assert.equal(params.mode, "subscription");
});

await test("Stripe Tax is on, with the address it needs, and can be switched off for an unregistered account", () => {
  assert.deepEqual(params.automatic_tax, { enabled: true });
  assert.equal(params.billing_address_collection, "required");
  process.env.STRIPE_TAX = "off";
  const off = checkoutParams({ location: venue, products: ["chat"], market: "AE", cycle: "monthly", email: "x@y.z", successUrl: "a", cancelUrl: "b" }, ["p"]);
  delete process.env.STRIPE_TAX;
  assert.deepEqual(off.automatic_tax, { enabled: false });
});

await test("the venue, products, market and cycle ride on the session and the subscription", () => {
  for (const meta of [params.metadata, params.subscription_data?.metadata]) {
    assert.equal(meta?.belline_location, venue.id);
    assert.equal(meta?.belline_products, "chat,phone_starter");
    assert.equal(meta?.belline_market, "AE");
    assert.equal(meta?.belline_cycle, "monthly");
  }
});

console.log("\n\x1b[1mThe trial takes no card\x1b[0m\n");

await test("signup starts a card-free trial of the Everything bundle, sixty phone minutes, fourteen days", () => {
  const sub = getLocation(venue.id)!.subscription!;
  assert.equal(sub.status, "trialing");
  assert.deepEqual(sub.products, TRIAL.products);
  assert.equal(sub.trial?.minutes, TRIAL.phoneMinutes);
  assert.equal(venue.stripe, undefined, "a Stripe customer was created at signup");
});

await test("what somebody picked on the checkout page is remembered on the trial", async () => {
  const picky = await account("Picky Clinic", { products: ["web_voice", "chat"], market: "AE" });
  assert.deepEqual(getLocation(picky.id)!.subscription!.products, ["chat", "web_voice"]);
});

await test("an invalid pick falls back to the trial's own bundle rather than failing signup", async () => {
  const odd = await account("Odd Studio", { products: ["phone_starter", "phone_pro"] });
  assert.deepEqual(getLocation(odd.id)!.subscription!.products, TRIAL.products);
});

console.log("\n\x1b[1mThe subscription flips on the webhook, not the redirect\x1b[0m\n");

await test("a completed checkout puts the venue on the bundle it bought", () => {
  applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_1",
      customer: "cus_test_1",
      subscription: "sub_test_1",
      client_reference_id: venue.id,
      metadata: {
        belline_location: venue.id,
        belline_products: "everything_business",
        belline_market: "AE",
        belline_cycle: "annual",
      },
    }),
  );
  const after = getLocation(venue.id)!;
  assert.equal(after.subscription?.status, "active");
  assert.deepEqual(after.subscription?.products, ["everything_business"]);
  assert.equal(after.subscription?.market, "AE");
  assert.equal(after.subscription?.cycle, "annual");
  assert.equal(after.stripe?.customerId, "cus_test_1");
  assert.equal(after.stripe?.subscriptionId, "sub_test_1");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(after.subscription!.startedOn));
});

await test("a set of modules lands in the catalogue's order", () => {
  const other = getLocation(venue.id)!;
  applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_mods",
      metadata: { belline_location: other.id, belline_products: "phone_starter,chat", belline_market: "AE" },
    }),
  );
  assert.deepEqual(getLocation(venue.id)!.subscription?.products, ["chat", "phone_starter"]);
});

await test("a session whose products are not a plan we sell changes nothing", () => {
  const before = JSON.stringify(getLocation(venue.id));
  for (const products of ["phone_starter,phone_pro", "professional", "whatsapp", ""]) {
    const out = applyStripeEvent(
      event("checkout.session.completed", { id: "cs_bad", metadata: { belline_location: venue.id, belline_products: products } }),
    );
    assert.match(out.applied, /ignored/, products);
  }
  assert.equal(JSON.stringify(getLocation(venue.id)), before);
});

await test("a checkout opened on the old ladder and paid after the switch is honoured and grandfathered", async () => {
  const late = await account("Late Payer Spa");
  applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_legacy",
      metadata: { belline_location: late.id, belline_plan: "business", belline_cycle: "monthly" },
    }),
  );
  const sub = getLocation(late.id)!.subscription!;
  assert.equal(sub.planId, "business");
  assert.equal(sub.status, "active");
  assert.equal(sub.grandfatheredUntil, addDays(todayIn("Asia/Dubai"), GRANDFATHER_DAYS));
});

await test("an event naming a venue we do not have, or none at all, changes nothing", () => {
  const before = JSON.stringify(getLocation(venue.id));
  assert.match(
    applyStripeEvent(event("checkout.session.completed", { id: "cs_2", metadata: { belline_location: "loc_nope", belline_products: "chat" } })).applied,
    /ignored/,
  );
  assert.match(applyStripeEvent(event("checkout.session.completed", { id: "cs_3" })).applied, /ignored/);
  assert.equal(JSON.stringify(getLocation(venue.id)), before);
});

await test("an event type we do not handle is ignored rather than guessed at", () => {
  assert.match(applyStripeEvent(event("customer.updated", { id: "cus_test_1" })).applied, /ignored/);
});

console.log("\n\x1b[1mThe free chat needs no card\x1b[0m\n");

await test("a trial venue can switch to the free chat without Stripe", async () => {
  const small = await account("Tiny Barber");
  const done = activateFree(getLocation(small.id)!, "AE");
  assert.ok(done.ok);
  const sub = getLocation(small.id)!.subscription!;
  assert.deepEqual(sub.products, ["chat_free"]);
  assert.equal(sub.status, "active");
});

await test("but not over a paid Stripe subscription, which would keep charging the card", () => {
  const paying = getLocation(venue.id)!;
  assert.ok(paying.stripe?.subscriptionId);
  const done = activateFree(paying, "AE");
  assert.equal(done.ok, false);
});

console.log("\n\x1b[1mKeeping customers, and losing them\x1b[0m\n");

await test("pilots on the old ladder are grandfathered for 90 days, once, and trials are not", async () => {
  const pilot = await account("Pilot Dental");
  upsertLocation({
    ...getLocation(pilot.id)!,
    subscription: { planId: "starter", cycle: "monthly", startedOn: "2026-05-01", status: "active" },
  });
  const trial = await account("Trial Nails");
  upsertLocation({
    ...getLocation(trial.id)!,
    subscription: { planId: "starter", cycle: "monthly", startedOn: "2026-09-01", status: "trialing", trial: { endsOn: "2026-09-15", minutes: 30 } },
  });

  grandfatherLegacyPlans();
  const stamped = getLocation(pilot.id)!.subscription!.grandfatheredUntil;
  assert.equal(stamped, addDays(todayIn("Asia/Dubai"), GRANDFATHER_DAYS));
  assert.equal(getLocation(trial.id)!.subscription!.grandfatheredUntil, undefined);

  upsertLocation({ ...getLocation(pilot.id)!, subscription: { ...getLocation(pilot.id)!.subscription!, grandfatheredUntil: "2026-01-01" } });
  grandfatherLegacyPlans();
  assert.equal(getLocation(pilot.id)!.subscription!.grandfatheredUntil, "2026-01-01", "the date moved on a second boot");
});

await test("a cancelled subscription is recorded with the date, and keeps what they were paying", () => {
  applyStripeEvent(event("customer.subscription.deleted", { id: "sub_test_1", metadata: { belline_location: venue.id } }));
  const sub = getLocation(venue.id)!.subscription!;
  assert.equal(sub.status, "cancelled");
  assert.ok(sub.cancelledAt);
  assert.deepEqual(sub.products, ["chat", "phone_starter"]);
});

await test("a failed payment does not switch the receptionist off", () => {
  const before = getLocation(venue.id)!.subscription!.status;
  applyStripeEvent(
    event("invoice.payment_failed", {
      id: "in_test_1",
      parent: { subscription_details: { metadata: { belline_location: venue.id } } },
    }),
  );
  assert.equal(getLocation(venue.id)!.subscription!.status, before);
  assert.ok(getLocation(venue.id)!.subscription!.paymentFailedAt);
});

console.log("\n\x1b[1mWithout keys\x1b[0m\n");

await test("an unconfigured Stripe is a supported state, not a crash", () => {
  const had = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(stripeEnabled(), false);
  if (had) process.env.STRIPE_SECRET_KEY = had;
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
