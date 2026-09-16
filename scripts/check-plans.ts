/**
 * The catalogue, and whether it makes money.
 *
 * Pinned here: catalogue v2 (2026-10) — three UAE plans at AED 199 / 399 /
 * 799 with pooled allowances and explicit annual prices; the packs, assisted
 * setup and volume terms; the trial; what a customer may buy (v2 only); that
 * every older product is kept exactly as it was sold and the September bundles
 * never lapse; and that every v2 plan and pack clears 30% gross margin at full
 * use on the conservative UAE basis, computed from the rate card the meter
 * uses.
 *
 *   npm run check:plans
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-plans-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("RATE_")) delete process.env[key];
}
delete process.env.ELEVENLABS_PLAN;

const plans = await import("../src/lib/billing/plans");
const { MARKETS, MARKET_CODES } = await import("../src/lib/markets");
const margin = await import("../src/lib/billing/margin");
const { modelKey } = await import("../src/lib/billing/cost");
const { seedIfEmpty } = await import("../src/lib/seed");
const { bellineVenue } = await import("../src/lib/seed-belline");
const { listLocations } = await import("../src/lib/store");

const {
  CATALOGUE_VERSION,
  PRODUCTS,
  PACKS,
  SERVICES,
  VOLUME,
  CHANNELS,
  TRIAL,
  allowanceText,
  annualPerMonth,
  checkSelection,
  grandfatherOf,
  isSellable,
  periodFee,
  poolOf,
  priceOf,
  productById,
  publicLines,
  recommend,
  sellable,
} = plans;
type Market = (typeof MARKET_CODES)[number];
type ProductId = Parameters<typeof productById>[0];

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

const V2: ProductId[] = ["v2_starter", "v2_growth", "v2_scale"];
const SEPTEMBER: ProductId[] = ["everything_starter", "everything_business", "everything_pro"];
const ORIGINAL: ProductId[] = ["starter", "business", "enterprise"];
const major = (id: ProductId, m: Market) => priceOf(id, m) / 100;

console.log("\n\x1b[1mThe catalogue\x1b[0m\n");

test("the catalogue is versioned, and every product and pack says which version it belongs to", () => {
  assert.equal(CATALOGUE_VERSION, "2026-10");
  for (const p of PRODUCTS) assert.ok(typeof p.version === "string" && p.version.length > 0, `${p.id} has no version`);
  for (const id of V2) assert.equal(productById(id).version, CATALOGUE_VERSION, id);
  for (const id of [...SEPTEMBER, ...ORIGINAL]) assert.notEqual(productById(id).version, CATALOGUE_VERSION, id);
  for (const pack of PACKS) assert.equal(pack.version, CATALOGUE_VERSION, pack.id);
});

test("every price is whole minor units and a whole unit of currency", () => {
  const priced = [
    ...PRODUCTS.flatMap((p) => [...Object.entries(p.prices), ...Object.entries(p.annualPrices ?? {})].map(([m, v]) => [p.id, m, v] as const)),
    ...[...SERVICES, ...PACKS].flatMap((s) => Object.entries(s.prices).map(([m, v]) => [s.id, m, v] as const)),
  ];
  for (const [id, m, v] of priced) {
    assert.ok(Number.isInteger(v) && (v as number) > 0, `${id} ${m}: ${v}`);
    assert.equal((v as number) % 100, 0, `${id} ${m} is not a whole ${MARKETS[m as Market].currency}`);
  }
});

test("exactly the three v2 plans are sold in the UAE, and nothing is sold anywhere else yet", () => {
  assert.deepEqual(sellable("AE").map((p) => p.id), V2);
  for (const m of MARKET_CODES.filter((m) => m !== "AE")) assert.deepEqual(sellable(m).map((p) => p.id), [], m);
  for (const id of V2) assert.deepEqual(Object.keys(productById(id).prices), ["AE"], `${id} is priced outside the UAE`);
});

test("the UAE prices are the ones decided: AED 199 / 399 / 799 a month", () => {
  assert.deepEqual(V2.map((id) => major(id, "AE")), [199, 399, 799]);
  for (const id of V2) assert.equal(productById(id).kind, "plan");
});

test("annual prices are stored, not derived: AED 1,990 / 3,990 / 7,990 billed yearly", () => {
  assert.deepEqual(V2.map((id) => productById(id).annualPrices?.AE), [199000, 399000, 799000]);
  assert.deepEqual(V2.map((id) => periodFee([id], "AE", "annual")), [199000, 399000, 799000]);
  for (const id of V2) assert.ok(annualPerMonth([id], "AE") * 12 <= periodFee([id], "AE", "annual"), `${id} overstates`);
});

test("Growth is the one marked most popular", () => {
  assert.deepEqual(sellable("AE").filter((p) => p.recommended).map((p) => p.id), ["v2_growth"]);
});

test("allowances are pooled: voice minutes across phone and the voice button, text conversations across chat and WhatsApp", () => {
  assert.equal(poolOf("phone"), "minutes");
  assert.equal(poolOf("web_voice"), "minutes");
  assert.equal(poolOf("chat"), "conversations");
  assert.equal(poolOf("whatsapp"), "conversations");
  assert.deepEqual(productById("v2_starter").pools, { minutes: 75, conversations: 200 });
  assert.deepEqual(productById("v2_growth").pools, { minutes: 300, conversations: 750 });
  assert.deepEqual(productById("v2_scale").pools, { minutes: 600, conversations: 2000 });
});

test("users per plan are stored as a limit: 2 / 5 / 15", () => {
  assert.deepEqual(V2.map((id) => productById(id).users), [2, 5, 15]);
});

test("each plan costs more and includes more than the one below", () => {
  for (let i = 1; i < V2.length; i++) {
    const [lo, hi] = [productById(V2[i - 1]), productById(V2[i])];
    assert.ok(priceOf(hi.id, "AE") > priceOf(lo.id, "AE"));
    assert.ok(hi.pools!.minutes! > lo.pools!.minutes! && hi.pools!.conversations! > lo.pools!.conversations!);
    assert.ok(hi.users! > lo.users!);
  }
});

test("nothing that can be bought or quoted is unlimited", () => {
  for (const p of PRODUCTS.filter((p) => p.kind !== "legacy")) {
    for (const [channel, v] of Object.entries(p.allowances)) assert.equal(typeof v, "number", `${p.id} leaves ${channel} uncounted`);
    for (const [pool, v] of Object.entries(p.pools ?? {})) assert.equal(typeof v, "number", `${p.id} leaves ${pool} uncounted`);
  }
});

test("packs: 100 voice minutes for AED 99, 150 text conversations for AED 49", () => {
  const minutes = PACKS.find((p) => p.pool === "minutes")!;
  const conversations = PACKS.find((p) => p.pool === "conversations")!;
  assert.equal(minutes.units, 100);
  assert.equal(minutes.prices.AE, 9900);
  assert.equal(conversations.units, 150);
  assert.equal(conversations.prices.AE, 4900);
});

test("assisted setup is AED 399 once, for Starter and Growth; the managed track's service is still hidden", () => {
  const assisted = SERVICES.find((s) => s.id === "assisted_setup")!;
  assert.equal(assisted.prices.AE, 39900);
  assert.deepEqual(assisted.forProducts, ["v2_starter", "v2_growth"]);
  const glove = SERVICES.find((s) => s.id === "white_glove_setup")!;
  assert.equal(glove.prices.AE, 750 * 100);
  assert.equal(glove.status, "not-yet");
});

test("volume: a subscription per location, 10% off from 5 to 19, custom from 20, applied by a person", () => {
  assert.equal(VOLUME.perLocation, true);
  assert.deepEqual(VOLUME.tiers, [
    { from: 5, to: 19, percentOff: 10 },
    { from: 20, custom: true },
  ]);
  assert.equal(VOLUME.appliedBy, "person");
});

test("the trial: thirty days, 30 voice minutes, 50 text conversations, one calendar connection, of Starter", () => {
  assert.equal(TRIAL.days, 30);
  assert.equal(TRIAL.minutes, 30);
  assert.equal(TRIAL.conversations, 50);
  assert.equal(TRIAL.calendarConnections, 1);
  assert.deepEqual([...TRIAL.products], ["v2_starter"]);
});

test("WhatsApp is live, shares every plan's text conversations with website chat, and nothing not-yet reaches a public line", () => {
  assert.equal(CHANNELS.whatsapp.status, "live");
  for (const id of V2) {
    const lines = publicLines(productById(id));
    assert.ok(lines.length > 0, `${id} shows nothing`);
    const conversations = lines.find((l) => /text conversations a month/.test(l));
    assert.ok(conversations, `${id} has no text conversations line`);
    assert.match(conversations!, /your website chat and WhatsApp/, `${id}: ${conversations}`);
    // The pool line is where WhatsApp is sold, on every plan alike: no separate
    // "WhatsApp" feature that would imply a cheaper plan goes without it.
    assert.equal(lines.filter((l) => /whatsapp/i.test(l)).length, 1, `${id}: ${lines.join(" | ")}`);
    // It is a second number the business registers, never their existing one.
    assert.ok(!lines.some((l) => /(?:your|their) (?:own |existing |current )?whats\s?app(?: number)?\b/i.test(l)), `${id}: ${lines.join(" | ")}`);
    for (const f of productById(id).features.filter((f) => f.status === "not-yet")) {
      assert.ok(!lines.includes(f.text), `${id} shows not-yet "${f.text}"`);
      assert.ok((f.gap ?? "").length > 40, `${id} "${f.text}" has no real gap`);
    }
  }
});

test("the things the strategy lists that do not work yet are recorded as not-yet, never promoted", () => {
  const notYet = V2.flatMap((id) => productById(id).features.filter((f) => f.status === "not-yet").map((f) => f.text)).join(" | ");
  for (const needle of [/calendar/i, /specialist booking/i, /routing/i, /API/]) {
    assert.match(notYet, needle, `${needle} is not recorded as not-yet`);
  }
});

test("no overage, unlimited use or 'keeps answering' promise is written anywhere in the catalogue", () => {
  assert.doesNotMatch(JSON.stringify(PRODUCTS), /overage|unlimited|keeps answering|no per-minute|free chat|badge/i);
});

console.log("\n\x1b[1mWhat older customers keep\x1b[0m\n");

test("the September bundles are legacy now: never sold, prices and allowances exactly as sold", () => {
  const sold: Record<string, [number, Record<string, number>]> = {
    everything_starter: [299, { phone: 200, web_voice: 100, chat: 150, whatsapp: 300 }],
    everything_business: [599, { phone: 600, web_voice: 200, chat: 400, whatsapp: 800 }],
    everything_pro: [1199, { phone: 1500, web_voice: 300, chat: 1000, whatsapp: 1500 }],
  };
  for (const id of SEPTEMBER) {
    const p = productById(id);
    assert.equal(p.kind, "legacy", id);
    assert.equal(major(id, "AE"), sold[id][0], id);
    assert.deepEqual(p.allowances, sold[id][1], id);
    assert.equal(p.pools, undefined, `${id} was given pools`);
    assert.equal(periodFee([id], "AE", "annual"), priceOf(id, "AE") * 10, `${id} annual changed`);
    for (const m of MARKET_CODES) assert.equal(isSellable(p, m), false, `${id} is sellable in ${m}`);
  }
});

test("the September bundles are grandfathered indefinitely; the original ladder keeps its 90 days", () => {
  for (const id of SEPTEMBER) assert.equal(grandfatherOf(productById(id)), "indefinite", id);
  for (const id of ORIGINAL) assert.deepEqual(grandfatherOf(productById(id)), { days: 90 }, id);
  for (const id of V2) assert.equal(grandfatherOf(productById(id)), null, id);
});

test("the managed track is in the catalogue, and can be neither bought nor seen", () => {
  for (const [id, aed] of [["professional", 999], ["premium", 1999]] as const) {
    const p = productById(id);
    assert.equal(p.kind, "managed");
    assert.equal(p.status, "not-yet");
    assert.equal(major(id, "AE"), aed);
    for (const m of MARKET_CODES) assert.equal(isSellable(p, m), false, `${id} is sellable in ${m}`);
  }
});

console.log("\n\x1b[1mWhat a customer may buy\x1b[0m\n");

test("one v2 plan", () => {
  for (const id of V2) {
    const s = checkSelection([id], "AE");
    assert.ok(s.ok && s.products.join() === id, id);
  }
});

test("refused: two plans, a September bundle, the original ladder, a managed plan, another market, nonsense, nothing", () => {
  for (const [bad, market] of [
    [["v2_starter", "v2_scale"], "AE"],
    [["everything_business"], "AE"],
    [["starter"], "AE"],
    [["professional"], "AE"],
    [["v2_growth"], "GB"],
    [["chat_free"], "AE"],
    [[], "AE"],
  ] as [unknown[], Market][]) {
    assert.equal(checkSelection(bad, market).ok, false, `accepted ${JSON.stringify(bad)} in ${market}`);
  }
});

console.log("\n\x1b[1mMoving up\x1b[0m\n");

test("a busy Starter moves to Growth, not Scale — pooled voice minutes count", () => {
  assert.deepEqual(recommend({ phone: 100, web_voice: 60 }, ["v2_starter"], "AE")?.products, ["v2_growth"]);
});

test("text conversations count too, pooled across chat and WhatsApp", () => {
  assert.deepEqual(recommend({ chat: 600, whatsapp: 300 }, ["v2_growth"], "AE")?.products, ["v2_scale"]);
});

test("a plan that fits recommends nothing, and nothing is ever recommended downwards", () => {
  assert.equal(recommend({ phone: 70, chat: 150 }, ["v2_starter"], "AE"), null);
  assert.equal(recommend({ phone: 5 }, ["v2_scale"], "AE"), null);
});

test("a September bundle past its allowance is pointed at the v2 plan that carries it", () => {
  // Growth matches the bundle's pooled 300 minutes rather than shrinking it,
  // and carries the usage: since the allowances were raised it is the cheapest
  // plan that does both, where it used to take Scale.
  assert.deepEqual(recommend({ phone: 240, chat: 100 }, ["everything_starter"], "AE")?.products, ["v2_growth"]);
});

console.log("\n\x1b[1mUnit costs agree with the strategy doc (§1.3)\x1b[0m\n");

// Re-pinned on 16 September 2026, because the doc became the stale side rather
// than the code. Three corrections moved these. Meta raised the UAE utility
// rate on 1 October 2025 and §1.3 still carried the old one; the paid-template
// share fell to 0.3 conservative / 0.15 lean once the free 24-hour service
// window was accounted for — together taking lean WhatsApp $0.027 → $0.0231.
// And the conservative basis now costs text on Haiku, the model reception
// ships, taking its chat $0.031 → $0.0148 and its WhatsApp $0.049 → $0.0313.
// The 7% tolerance is untouched: these are the figures §1.3 would print today.
const DOC_UNIT: Record<"lean" | "conservative", Record<"phone" | "web_voice" | "chat" | "whatsapp", number>> = {
  lean: { phone: 0.063, web_voice: 0.05, chat: 0.015, whatsapp: 0.0231 },
  conservative: { phone: 0.101, web_voice: 0.06, chat: 0.0148, whatsapp: 0.0313 },
};
for (const basis of margin.BASIS_ORDER) {
  test(`${basis}: phone, voice button, chat and WhatsApp within 7% of the doc`, () => {
    const got: string[] = [];
    for (const [channel, expected] of Object.entries(DOC_UNIT[basis])) {
      const actual = margin.unitCostUsd(channel as never, basis);
      got.push(`${channel} $${actual.toFixed(4)}`);
      assert.ok(Math.abs(actual - expected) / expected <= 0.07, `${channel}: $${actual.toFixed(4)} against $${expected}`);
    }
    console.log(`      ${got.join(" · ")}`);
  });
}

test("the conservative basis costs text on the model reception actually ships", () => {
  // Costing text on Haiku is only honest while Haiku is what we run, so the
  // basis is tied to the seeded venues rather than asserted in a comment. This
  // fails if a seeded venue moves off Haiku, or if the basis moves off it.
  seedIfEmpty();
  const seeded = [...listLocations(), bellineVenue];
  assert.ok(seeded.length > 3, "nothing was seeded, so this would prove nothing");
  for (const venue of seeded) {
    assert.equal(
      modelKey(venue.agent.model).key,
      margin.BASES.conservative.textModel,
      `${venue.name} runs ${venue.agent.model}, which is not what the conservative basis costs text on`,
    );
  }
});

test("a pool is costed at its dearest channel, so the mix can only flatter the margin", () => {
  for (const basis of margin.BASIS_ORDER) {
    assert.equal(margin.poolCostUsd("minutes", basis), Math.max(margin.unitCostUsd("phone", basis), margin.unitCostUsd("web_voice", basis)));
    assert.equal(margin.poolCostUsd("conversations", basis), Math.max(margin.unitCostUsd("chat", basis), margin.unitCostUsd("whatsapp", basis)));
  }
});

test("card fees are part of the cost", () => {
  const p = productById("v2_growth");
  const withFees = margin.marginOf(p, "AE", "conservative", 0).costUsd;
  assert.ok(withFees > margin.numberRentalUsd("conservative"), "a month with no use cost only the number: no card fee counted");
});

console.log("\n\x1b[1mMargins — conservative UAE basis, 25 / 50 / 75 / 100% of every allowance\x1b[0m");
const SHARES = [0.25, 0.5, 0.75, 1];
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 1000) / 10}%`);
const unverified = margin.unverifiedLines("conservative");
console.log(`\n  ${margin.BASES.conservative.label}`);
if (unverified.length) console.log(`  \x1b[33mestimated lines: ${unverified.join(", ")}\x1b[0m`);
console.log(`\n  ${"".padEnd(26)}${SHARES.map((s) => `${s * 100}%`.padStart(9)).join("")}`);
const under: string[] = [];
for (const id of V2) {
  const p = productById(id);
  for (const cycle of ["monthly", "annual"] as const) {
    const cells = SHARES.map((s) => margin.marginOf(p, "AE", "conservative", s, cycle));
    const full = cells[cells.length - 1].margin!;
    if (cycle === "monthly" && full < margin.MARGIN_FLOOR.bundle) under.push(`${p.name} monthly at 100%: ${pct(full)}`);
    console.log(`  ${`${p.name} ${cycle}`.padEnd(26)}${cells.map((c) => pct(c.margin).padStart(9)).join("")}`);
  }
}
for (const pack of PACKS) {
  const cells = SHARES.map((s) => margin.packMarginOf(pack, "AE", "conservative", s));
  const full = cells[cells.length - 1].margin!;
  if (full < margin.MARGIN_FLOOR.bundle) under.push(`${pack.name} at 100%: ${pct(full)}`);
  console.log(`  ${pack.name.padEnd(26)}${cells.map((c) => pct(c.margin).padStart(9)).join("")}`);
}
console.log("");

test("every v2 plan clears 30% at full use, monthly, on the conservative UAE basis — and so does every pack", () => {
  assert.deepEqual(under, []);
});

test("a real carrier quote replaces an estimated rate without a deploy", () => {
  const lines = margin.unverifiedLines("conservative");
  for (const key of lines) process.env[`RATE_${key}`] = "0.01";
  try {
    assert.deepEqual(margin.unverifiedLines("conservative"), []);
  } finally {
    for (const key of lines) delete process.env[`RATE_${key}`];
  }
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
