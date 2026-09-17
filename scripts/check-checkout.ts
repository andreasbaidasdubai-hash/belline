/**
 * Taking money.
 *
 * Stripe's own behaviour is Stripe's to test. What is worth pinning here is
 * the half that is ours, and every one of these is a way a payment system goes
 * wrong quietly rather than loudly.
 *
 * **The price Stripe is told is the price on the page.** Everything is derived
 * from `plans.ts` — one Stripe price per plan, market and cycle — and the
 * lookup key carries the amount, so a changed price cannot reuse the old one.
 *
 * **Nothing believes a redirect.** The subscription flips on a signed webhook,
 * and the webhook is what these tests exercise.
 *
 * **An event for somebody else's venue, or for a plan we would not sell,
 * changes nothing.**
 *
 * **The trial takes no card.** The card is taken when a plan is chosen, never
 * at signup.
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
const { applyStripeEvent, checkoutParams, lookupKeyFor, stripeEnabled } = await import("../src/lib/billing/stripe");
const { grandfatherLegacyPlans } = await import("../src/lib/billing/grandfather");
const { MARKET_CODES } = await import("../src/lib/markets");
const { CATALOGUE_VERSION, GRANDFATHER_DAYS, PRODUCTS, TRIAL, annualPerMonth, checkPurchased, checkSelection, offered, periodFee, priceOf, recommendedPlan, sellable } = await import(
  "../src/lib/billing/plans"
);
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

await test("every plan has a whole-unit price for both cycles, in every market", () => {
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
  for (const product of sellable("AE")) {
    const perMonth = annualPerMonth([product.id], "AE");
    assert.ok(perMonth < priceOf(product.id, "AE"), `${product.name}: ${perMonth}`);
    assert.equal(perMonth % 100, 0);
  }
});

await test("a lookup key names the plan, market, cycle and amount — so a new price is a new key", () => {
  assert.equal(lookupKeyFor("v2_starter", "AE", "monthly"), "belline_v2_starter_ae_monthly_24900");
  assert.equal(lookupKeyFor("v2_starter", "AE", "annual"), "belline_v2_starter_ae_annual_273900");
});

await test("the keys already in Stripe have not moved: a September bundle's key is exactly what it was", () => {
  assert.equal(lookupKeyFor("everything_starter", "GB", "monthly"), "belline_everything_starter_gb_monthly_6500");
  assert.equal(lookupKeyFor("everything_starter", "AE", "annual"), "belline_everything_starter_ae_annual_299000");
});

await test("no v2 key can collide with any key an older product could have created, in any market or cycle", () => {
  const older = new Set<string>();
  for (const product of PRODUCTS.filter((p) => p.version !== CATALOGUE_VERSION)) {
    for (const market of Object.keys(product.prices) as (typeof MARKET_CODES)[number][]) {
      for (const cycle of ["monthly", "annual"] as const) older.add(lookupKeyFor(product.id, market, cycle));
    }
  }
  for (const product of sellable("AE")) {
    assert.equal(product.version, CATALOGUE_VERSION);
    for (const cycle of ["monthly", "annual"] as const) {
      const key = lookupKeyFor(product.id, "AE", cycle);
      assert.ok(!older.has(key), `${key} is already an older product's key`);
      assert.ok(![...older].some((k) => k.startsWith(`belline_${product.id}_`)), `${product.id} shares a prefix with an older key`);
    }
  }
});

const params = checkoutParams(
  {
    location: venue,
    products: ["v2_growth"],
    market: "AE",
    cycle: "monthly",
    email: "owner@checkoutsalon.test",
    successUrl: "https://app.belline.ai/billing?paid=1",
    cancelUrl: "https://app.belline.ai/checkout?cancelled=1",
  },
  ["price_business"],
);

await test("a subscription is one line: the plan", () => {
  assert.deepEqual(params.line_items, [{ price: "price_business", quantity: 1 }]);
  assert.equal(params.mode, "subscription");
});

await test("Stripe Tax is on, with the address it needs, and can be switched off for an unregistered account", () => {
  assert.deepEqual(params.automatic_tax, { enabled: true });
  assert.equal(params.billing_address_collection, "required");
  process.env.STRIPE_TAX = "off";
  const off = checkoutParams(
    { location: venue, products: ["v2_starter"], market: "AE", cycle: "monthly", email: "x@y.z", successUrl: "a", cancelUrl: "b" },
    ["p"],
  );
  delete process.env.STRIPE_TAX;
  assert.deepEqual(off.automatic_tax, { enabled: false });
});

await test("the venue, plan, market, cycle, amount and catalogue version ride on the session and the subscription", () => {
  for (const meta of [params.metadata, params.subscription_data?.metadata]) {
    assert.equal(meta?.belline_location, venue.id);
    assert.equal(meta?.belline_products, "v2_growth");
    assert.equal(meta?.belline_market, "AE");
    assert.equal(meta?.belline_cycle, "monthly");
    assert.equal(meta?.belline_amount, String(periodFee(["v2_growth"], "AE", "monthly")));
    assert.equal(meta?.belline_catalogue, CATALOGUE_VERSION);
  }
});

console.log("\n\x1b[1mGermany, Austria and Switzerland: priced, never sold\x1b[0m\n");

await test("a DACH market's plans are offered for its waitlist page and refused by every selling path", () => {
  for (const market of ["DE", "AT", "CH"] as const) {
    assert.equal(offered(market).length, 3, `${market} has no planned prices to show`);
    assert.deepEqual(sellable(market), [], `${market} is sellable`);
    for (const id of ["v2_starter", "v2_growth", "v2_scale"]) {
      const selection = checkSelection([id], market);
      assert.equal(selection.ok, false, `${id} can be chosen in ${market}`);
      assert.equal(checkPurchased([id], market).ok, false, `${id} counts as bought in ${market}`);
    }
    assert.equal(recommendedPlan(market).id, "v2_growth", "the fallback plan changed");
  }
});

await test("the checkout page falls back to the UAE for a closed market, and offers only open ones", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "checkout", "page.tsx"), "utf8");
  assert.match(page, /MARKETS\[asked\]\.status === "live"\s*\?\s*asked\s*:\s*"AE"/, "?market=DE could price the checkout in euros");
  assert.match(page, /markets=\{liveMarkets\(\)\}/);
  const route = fs.readFileSync(path.join(process.cwd(), "src", "app", "api", "checkout", "route.ts"), "utf8");
  assert.match(route, /const selection = checkSelection\(raw, market\);\s*if \(!selection\.ok\)/, "the checkout route no longer checks the selection against the market");
});

await test("a paid checkout that claims a DACH market changes nothing", async () => {
  const dach = await account("Dach Probe Salon");
  const before = JSON.stringify(getLocation(dach.id));
  applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_dach",
      customer: "cus_test_dach",
      subscription: "sub_test_dach",
      client_reference_id: dach.id,
      metadata: { belline_location: dach.id, belline_products: "v2_growth", belline_market: "DE", belline_cycle: "monthly", belline_catalogue: CATALOGUE_VERSION },
    }),
  );
  const after = getLocation(dach.id)!;
  assert.notEqual(after.subscription?.status, "active", "a DE checkout activated a plan");
  assert.notEqual(after.subscription?.market, "DE");
  assert.equal(JSON.stringify(after.subscription), JSON.stringify(JSON.parse(before).subscription));
});

console.log("\n\x1b[1mThe trial takes no card\x1b[0m\n");

await test("signup starts a card-free trial of Starter: 30 voice minutes, 50 text conversations, thirty days", () => {
  const sub = getLocation(venue.id)!.subscription!;
  assert.equal(sub.status, "trialing");
  assert.deepEqual(sub.products, [...TRIAL.products]);
  assert.equal(sub.trial?.minutes, TRIAL.minutes);
  assert.equal(sub.trial?.conversations, TRIAL.conversations);
  assert.equal(venue.stripe, undefined, "a Stripe customer was created at signup");
});

await test("the plan somebody picked on the checkout page is remembered on the trial", async () => {
  const picky = await account("Picky Clinic", { products: ["v2_scale"], market: "AE" });
  assert.deepEqual(getLocation(picky.id)!.subscription!.products, ["v2_scale"]);
});

await test("an invalid pick — two plans, or a plan no longer sold — falls back to the trial's own plan", async () => {
  const odd = await account("Odd Studio", { products: ["v2_starter", "v2_scale"] });
  assert.deepEqual(getLocation(odd.id)!.subscription!.products, [...TRIAL.products]);
  const old = await account("Old Link Studio", { products: ["everything_pro"] });
  assert.deepEqual(getLocation(old.id)!.subscription!.products, [...TRIAL.products]);
});

console.log("\n\x1b[1mThe subscription flips on the webhook, not the redirect\x1b[0m\n");

await test("a completed checkout puts the venue on the plan it bought", () => {
  applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_1",
      customer: "cus_test_1",
      subscription: "sub_test_1",
      client_reference_id: venue.id,
      metadata: {
        belline_location: venue.id,
        belline_products: "v2_growth",
        belline_market: "AE",
        belline_cycle: "annual",
        belline_amount: "548900",
        belline_catalogue: CATALOGUE_VERSION,
      },
    }),
  );
  const after = getLocation(venue.id)!;
  assert.equal(after.subscription?.status, "active");
  assert.deepEqual(after.subscription?.products, ["v2_growth"]);
  assert.equal(after.subscription?.market, "AE");
  assert.equal(after.subscription?.cycle, "annual");
  assert.equal(after.subscription?.catalogueVersion, CATALOGUE_VERSION);
  assert.equal(after.subscription?.priceMinor, periodFee(["v2_growth"], "AE", "annual"));
  assert.equal(after.stripe?.customerId, "cus_test_1");
  assert.equal(after.stripe?.subscriptionId, "sub_test_1");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(after.subscription!.startedOn));
});

await test("a later event without ids does not erase the customer", () => {
  applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test_2",
      metadata: { belline_location: venue.id, belline_products: "v2_growth", belline_market: "AE" },
    }),
  );
  assert.equal(getLocation(venue.id)!.stripe?.customerId, "cus_test_1");
});

await test("a session whose products are not something we sold changes nothing", () => {
  const before = JSON.stringify(getLocation(venue.id));
  for (const [products, market] of [
    ["v2_starter,v2_scale", "AE"],
    ["everything_starter,everything_pro", "AE"],
    ["professional", "AE"],
    ["starter", "AE"],
    ["v2_growth", "GB"],
    ["chat_free", "AE"],
    ["", "AE"],
  ]) {
    const out = applyStripeEvent(
      event("checkout.session.completed", {
        id: "cs_bad",
        metadata: { belline_location: venue.id, belline_products: products, belline_market: market },
      }),
    );
    assert.match(out.applied, /ignored/, `${products} in ${market}`);
  }
  assert.equal(JSON.stringify(getLocation(venue.id)), before);
});

await test("a checkout opened on a September bundle and paid after v2 shipped is honoured as sold, and never runs out", async () => {
  const late = await account("September Payer Salon");
  applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_sept",
      metadata: { belline_location: late.id, belline_products: "everything_business", belline_market: "AE", belline_cycle: "monthly" },
    }),
  );
  const sub = getLocation(late.id)!.subscription!;
  assert.equal(sub.status, "active");
  assert.deepEqual(sub.products, ["everything_business"]);
  assert.equal(sub.priceMinor, 599 * 100, "a September bundle was repriced");
  assert.equal(sub.catalogueVersion, "2026-09");
  assert.equal(sub.grandfatheredUntil, undefined, "a September bundle was given an end date");
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
    applyStripeEvent(
      event("checkout.session.completed", { id: "cs_3", metadata: { belline_location: "loc_nope", belline_products: "v2_starter" } }),
    ).applied,
    /ignored/,
  );
  assert.match(applyStripeEvent(event("checkout.session.completed", { id: "cs_4" })).applied, /ignored/);
  assert.equal(JSON.stringify(getLocation(venue.id)), before);
});

await test("an event type we do not handle is ignored rather than guessed at", () => {
  assert.match(applyStripeEvent(event("customer.updated", { id: "cus_test_1" })).applied, /ignored/);
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

  const bundle = await account("Bundle Barbers");
  upsertLocation({
    ...getLocation(bundle.id)!,
    subscription: { products: ["everything_starter"], market: "AE", cycle: "monthly", startedOn: "2026-09-10", status: "active" },
  });

  grandfatherLegacyPlans();
  assert.equal(getLocation(pilot.id)!.subscription!.grandfatheredUntil, addDays(todayIn("Asia/Dubai"), GRANDFATHER_DAYS));
  assert.equal(getLocation(trial.id)!.subscription!.grandfatheredUntil, undefined);
  assert.equal(getLocation(bundle.id)!.subscription!.grandfatheredUntil, undefined, "a September bundle was given an end date");

  upsertLocation({ ...getLocation(pilot.id)!, subscription: { ...getLocation(pilot.id)!.subscription!, grandfatheredUntil: "2026-01-01" } });
  grandfatherLegacyPlans();
  assert.equal(getLocation(pilot.id)!.subscription!.grandfatheredUntil, "2026-01-01", "the date moved on a second boot");
});

await test("a cancelled subscription is recorded with the date, and keeps what they were paying", () => {
  applyStripeEvent(event("customer.subscription.deleted", { id: "sub_test_1", metadata: { belline_location: venue.id } }));
  const sub = getLocation(venue.id)!.subscription!;
  assert.equal(sub.status, "cancelled");
  assert.ok(sub.cancelledAt);
  assert.deepEqual(sub.products, ["v2_growth"]);
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

console.log("\n\x1b[1mThe checkout page\x1b[0m\n");

{
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  // The app compiles JSX with the classic runtime outside Next.
  (globalThis as { React?: unknown }).React = React;
  const { default: Order } = await import("../src/app/checkout/Order");
  const state = await import("../src/app/checkout/order-state");
  const render = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      React.createElement(Order, {
        market: "AE",
        initial: ["v2_growth"],
        initialCycle: "monthly",
        signedIn: false,
        venueName: "your venue",
        stripe: false,
        cancelled: false,
        markets: ["AE"],
        trade: "",
        siteOrigin: "https://belline-staging.up.railway.app",
        ...props,
      } as never),
    );
  const pressed = (html: string) => /<button[^>]*aria-pressed="true"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";

  await test("?cycle=annual preselects annual on the page; anything else is monthly", () => {
    assert.equal(state.cycleFromParam("annual"), "annual");
    assert.equal(state.cycleFromParam(undefined), "monthly");
    assert.equal(state.cycleFromParam("yearly"), "monthly");
    assert.match(pressed(render({ initialCycle: state.cycleFromParam("annual") })), /^Annual/);
    assert.equal(pressed(render()), "Monthly");
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/checkout/page.tsx"), "utf8");
    assert.match(page, /cycleFromParam\(params\.cycle\)/, "the page does not read ?cycle= through cycleFromParam");
  });

  await test("editing the plan keeps the annual cycle, in the order and in the address bar", () => {
    let order = state.initialOrder("v2_growth", "annual");
    order = state.toggleEditing(order);
    assert.equal(order.editing, true);
    order = state.choosePlan(order, "v2_scale");
    assert.deepEqual(order, { selected: "v2_scale", cycle: "annual", editing: false });
    order = state.choosePlan(state.toggleEditing(order), "v2_starter");
    assert.equal(order.cycle, "annual");
    const search = new URLSearchParams(state.orderSearch("?cycle=annual&plan=starter&trade=salon", order));
    assert.equal(search.get("cycle"), "annual");
    assert.equal(search.get("products"), "v2_starter");
    assert.equal(search.get("plan"), null);
    assert.equal(search.get("trade"), "salon");
    assert.equal(new URLSearchParams(state.orderSearch("?cycle=annual", state.chooseCycle(order, "monthly"))).get("cycle"), null);
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/checkout/Order.tsx"), "utf8");
    assert.match(src, /choosePlan\(o, p\.id\)/, "Order.tsx picks a plan without choosePlan");
  });

  await test("the plan is a summary with Edit; the feature list is behind What's included", () => {
    const html = render();
    assert.match(html, /data-plan-summary/);
    assert.match(html, /Belline Growth/);
    assert.match(html, /aria-expanded="false"[^>]*>Edit</);
    assert.doesNotMatch(html, /role="radiogroup"/, "the plan list is open before anybody asked to edit");
    const details = /<details[^>]*>([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    assert.match(details, /What(&#x27;|&rsquo;|’|')s included/);
    assert.ok(details.includes("<li"), "the feature list is not inside the disclosure");
    assert.equal((html.match(/<li/g) ?? []).length - (details.match(/<li/g) ?? []).length, 5, "features listed outside the disclosure");
  });

  await test("the trial allowance from the catalogue sits by Due today, with the VAT note from the terms", () => {
    const html = render();
    assert.equal(state.trialAllowance(TRIAL), `${TRIAL.days} days, ${TRIAL.minutes} voice minutes, ${TRIAL.conversations} text conversations`);
    const due = html.indexOf("Due today");
    const allowance = html.indexOf(state.trialAllowance(TRIAL));
    assert.ok(due > 0 && allowance > due && allowance - due < 400, "the trial allowance is not beside Due today");
    assert.match(html, /AED 0/);
    const terms = fs.readFileSync(path.join(process.cwd(), "public/terms.html"), "utf8");
    assert.ok(terms.includes(state.VAT_NOTE), "the VAT note says something the terms do not");
    assert.ok(html.includes(state.VAT_NOTE));
    assert.ok(render({ signedIn: true }).includes(state.VAT_NOTE));
  });

  await test("with video live, the trial and the plan say their voice minutes as video minutes too", () => {
    assert.equal(state.trialAllowance(TRIAL, true), "30 days, 30 voice minutes or 12 video minutes, 50 text conversations");
    const html = render({ video: true });
    assert.ok(html.includes("30 voice minutes or 12 video minutes"), "the trial allowance does not name video minutes");
    assert.ok(html.includes("250 voice min or 100 video min"), "the Growth summary does not name video minutes");
    assert.doesNotMatch(render({ video: false }), /video min/, "video minutes are named while video is not live");
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/checkout/page.tsx"), "utf8");
    assert.match(page, /video=\{videoLive\(\)\}/);
  });

  await test("the account side says what follows, and nothing promises four things", () => {
    const html = render();
    assert.doesNotMatch(html, /Four things/i);
    const steps = [...html.matchAll(/<li[^>]*><span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(steps, ["Create your account", "Confirm your email", "Add your business", "Test Belle", "Go live"]);
  });

  await test("the primary button carries words, not a bell", () => {
    const form = fs.readFileSync(path.join(process.cwd(), "src/app/checkout/CheckoutForm.tsx"), "utf8");
    const at = form.indexOf('type="submit"');
    const button = form.slice(form.lastIndexOf("<button", at), form.indexOf("</button>", at));
    assert.doesNotMatch(button, /<svg|Bell|bell/);
  });

  await test("the checkout's own links follow the environment: staging links to staging", () => {
    const html = render();
    assert.doesNotMatch(html, /https:\/\/(app\.|www\.)?belline\.ai/);
    for (const file of ["src/app/checkout/page.tsx", "src/app/checkout/CheckoutForm.tsx", "src/app/checkout/Order.tsx", "src/app/whatsapp/page.tsx", "src/app/not-found.tsx"]) {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      assert.doesNotMatch(src, /href="https:\/\/(app\.|www\.)?belline\.ai/, `${file} hard-codes a production link`);
    }
  });

  await test("siteOrigin: belline.ai for production, the app's own origin anywhere else", async () => {
    const { siteOrigin } = await import("../src/lib/origin");
    const before = { a: process.env.PUBLIC_APP_URL, o: process.env.PUBLIC_ORIGIN };
    try {
      delete process.env.PUBLIC_APP_URL;
      delete process.env.PUBLIC_ORIGIN;
      assert.equal(siteOrigin(), "https://belline.ai");
      process.env.PUBLIC_ORIGIN = "https://app.belline.ai";
      assert.equal(siteOrigin(), "https://belline.ai");
      process.env.PUBLIC_ORIGIN = "https://belline-staging.up.railway.app/";
      assert.equal(siteOrigin(), "https://belline-staging.up.railway.app");
      process.env.PUBLIC_ORIGIN = "http://localhost:3100";
      assert.equal(siteOrigin(), "http://localhost:3100");
    } finally {
      if (before.a === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = before.a;
      if (before.o === undefined) delete process.env.PUBLIC_ORIGIN;
      else process.env.PUBLIC_ORIGIN = before.o;
    }
  });
}

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
