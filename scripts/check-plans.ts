/**
 * The catalogue, and whether it makes money.
 *
 * Three things are pinned here. The UAE prices are the ones decided on
 * 14 September 2026, and every other market's are marked provisional. What a
 * customer may buy is exactly what the checkout, the API and the Stripe
 * webhook agree on: one of three plans. And every plan clears a 30% margin at
 * typical use, computed from the same rate card the meter uses (Phase 1) —
 * on the lean basis in every market, and on the pessimistic UAE-line basis in
 * the UAE.
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

const {
  PRODUCTS,
  SERVICES,
  CHANNELS,
  TRIAL,
  allowanceText,
  annualPerMonth,
  checkSelection,
  isSellable,
  periodFee,
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

const LADDER: ProductId[] = ["everything_starter", "everything_business", "everything_pro"];
const major = (id: ProductId, m: Market) => priceOf(id, m) / 100;

console.log("\n\x1b[1mThe catalogue\x1b[0m\n");

test("every price is whole minor units and a whole unit of currency", () => {
  for (const p of [...PRODUCTS, ...SERVICES]) {
    for (const [m, v] of Object.entries(p.prices)) {
      assert.ok(Number.isInteger(v) && (v as number) > 0, `${p.id} ${m}: ${v}`);
      assert.equal((v as number) % 100, 0, `${p.id} ${m} is not a whole ${MARKETS[m as Market].currency}`);
    }
  }
});

test("exactly three plans are sold, in every market, and nothing is free", () => {
  for (const m of MARKET_CODES) {
    assert.deepEqual(sellable(m).map((p) => p.id), LADDER, m);
    for (const id of LADDER) assert.ok(priceOf(id, m) > 0, `${id} is free in ${m}`);
  }
});

test("the UAE prices are the ones decided: AED 299 / 599 / 1,199, not provisional", () => {
  assert.deepEqual(LADDER.map((id) => major(id, "AE")), [299, 599, 1199]);
  for (const id of LADDER) assert.ok(!productById(id).provisional?.includes("AE"));
});

test("every other market's price is marked provisional", () => {
  for (const id of LADDER) {
    for (const m of MARKET_CODES.filter((m) => m !== "AE")) {
      assert.ok(productById(id).provisional?.includes(m), `${id} in ${m} is not marked provisional`);
    }
  }
});

test("every plan includes every channel, and nothing that can be bought or quoted is unlimited", () => {
  for (const id of LADDER) {
    assert.deepEqual(Object.keys(productById(id).allowances).sort(), ["chat", "phone", "web_voice", "whatsapp"]);
  }
  for (const p of PRODUCTS.filter((p) => p.kind !== "legacy")) {
    for (const [channel, v] of Object.entries(p.allowances)) {
      assert.equal(typeof v, "number", `${p.id} leaves ${channel} uncounted`);
    }
  }
});

test("the allowances are the strategy doc's (§2.2)", () => {
  assert.deepEqual(productById("everything_starter").allowances, { phone: 200, web_voice: 100, chat: 150, whatsapp: 300 });
  assert.deepEqual(productById("everything_business").allowances, { phone: 600, web_voice: 200, chat: 400, whatsapp: 800 });
  assert.deepEqual(productById("everything_pro").allowances, { phone: 1500, web_voice: 300, chat: 1000, whatsapp: 1500 });
});

test("in every market each plan costs more and includes more than the one below", () => {
  for (const m of MARKET_CODES) {
    for (let i = 1; i < LADDER.length; i++) {
      assert.ok(priceOf(LADDER[i], m) > priceOf(LADDER[i - 1], m), `${LADDER[i]} is not dearer in ${m}`);
      for (const [channel, amount] of Object.entries(productById(LADDER[i]).allowances)) {
        const below = productById(LADDER[i - 1]).allowances[channel as keyof typeof CHANNELS];
        assert.ok((amount as number) > (below as number), `${LADDER[i]} does not include more ${channel}`);
      }
    }
  }
});

test("annual is ten months for twelve, and the monthly equivalent never overstates it", () => {
  for (const id of LADDER) {
    for (const m of MARKET_CODES) {
      assert.equal(periodFee([id], m, "annual"), priceOf(id, m) * 10, `${id} ${m}`);
      assert.ok(annualPerMonth([id], m) * 12 <= periodFee([id], m, "annual"), `${id} ${m} overstates`);
    }
  }
});

test("the managed track is in the catalogue, and can be neither bought nor seen (addendum §2)", () => {
  for (const [id, aed] of [["professional", 999], ["premium", 1999]] as const) {
    const p = productById(id);
    assert.equal(p.kind, "managed");
    assert.equal(p.status, "not-yet");
    assert.equal(major(id, "AE"), aed);
    assert.ok(p.features.some((f) => f.status === "not-yet"), `${id} lists nothing it is waiting on`);
    for (const m of MARKET_CODES) assert.equal(isSellable(p, m), false, `${id} is sellable in ${m}`);
  }
  const glove = SERVICES.find((s) => s.id === "white_glove_setup")!;
  assert.equal(glove.prices.AE, 750 * 100);
  assert.equal(glove.status, "not-yet");
});

test("WhatsApp is not shown on any plan until it works", () => {
  assert.equal(CHANNELS.whatsapp.status, "not-yet");
  for (const id of LADDER) {
    const p = productById(id);
    const line = allowanceText("whatsapp", p.allowances.whatsapp as number);
    assert.ok(!publicLines(p).includes(line), `${p.name} shows "${line}"`);
  }
});

test("the trial is fourteen days and sixty phone minutes", () => {
  assert.equal(TRIAL.days, 14);
  assert.equal(TRIAL.phoneMinutes, 60);
});

test("no per-minute or per-conversation charge, and no free tier, is described anywhere in the catalogue", () => {
  assert.doesNotMatch(JSON.stringify(PRODUCTS), /overage|per minute|per conversation|extra minutes|free chat|badge/i);
});

console.log("\n\x1b[1mWhat a customer may buy\x1b[0m\n");

test("one plan", () => {
  for (const id of LADDER) {
    const s = checkSelection([id], "AE");
    assert.ok(s.ok && s.products.join() === id, id);
  }
});

test("refused: two plans, a managed plan, the old ladder, nonsense, nothing", () => {
  for (const bad of [
    ["everything_starter", "everything_pro"],
    ["professional"],
    ["starter"],
    ["chat_free"],
    ["phone_starter"],
    [],
  ]) {
    assert.equal(checkSelection(bad, "AE").ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

console.log("\n\x1b[1mMoving up\x1b[0m\n");

test("a busy Starter moves to Business, not Pro", () => {
  assert.deepEqual(recommend({ phone: 450 }, ["everything_starter"], "AE")?.products, ["everything_business"]);
});

test("any channel past its allowance counts, not only the phone", () => {
  assert.deepEqual(recommend({ phone: 100, chat: 500 }, ["everything_business"], "AE")?.products, ["everything_pro"]);
});

test("a plan that fits recommends nothing, and nothing is ever recommended downwards", () => {
  assert.equal(recommend({ phone: 100 }, ["everything_starter"], "AE"), null);
  assert.equal(recommend({ phone: 5 }, ["everything_pro"], "AE"), null);
});

test("a grandfathered venue past its minutes is pointed at the cheapest plan that keeps its channels", () => {
  assert.deepEqual(recommend({ phone: 150, chat: 40 }, ["starter"], "AE")?.products, ["everything_starter"]);
});

console.log("\n\x1b[1mUnit costs agree with the strategy doc (§1.3)\x1b[0m\n");

const DOC_UNIT: Record<"lean" | "conservative", Record<"phone" | "web_voice" | "chat" | "whatsapp", number>> = {
  lean: { phone: 0.063, web_voice: 0.05, chat: 0.015, whatsapp: 0.027 },
  conservative: { phone: 0.101, web_voice: 0.06, chat: 0.031, whatsapp: 0.049 },
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

console.log("\n\x1b[1mMargins — typical use (60%) / full allowance\x1b[0m");

for (const basis of margin.BASIS_ORDER) {
  const unverified = margin.unverifiedLines(basis);
  const scope = margin.BASES[basis].markets;
  const markets = scope === "all" ? MARKET_CODES : scope;
  console.log(`\n  ${margin.BASES[basis].label}${unverified.length ? `  \x1b[33m(estimated: ${unverified.join(", ")})\x1b[0m` : ""}\n`);
  console.log(`  ${"".padEnd(12)}${markets.map((m) => m.padStart(9)).join("")}`);

  const under: string[] = [];
  for (const id of LADDER) {
    const p = productById(id);
    const cells = markets.map((m) => {
      const typical = margin.marginOf(p, m, basis, margin.TYPICAL_USE).margin!;
      const full = margin.marginOf(p, m, basis, 1).margin!;
      if (typical < margin.MARGIN_FLOOR.bundle) under.push(`${p.name} in ${m}: ${Math.round(typical * 100)}%`);
      const cell = `${Math.round(typical * 100)}/${Math.round(full * 100)}`;
      return typical < margin.MARGIN_FLOOR.bundle ? `\x1b[31m${cell.padStart(9)}\x1b[0m` : cell.padStart(9);
    });
    console.log(`  ${p.name.padEnd(12)}${cells.join("")}`);
  }
  console.log("");

  test(`${basis}: every plan clears 30% at typical use, in ${scope === "all" ? "every market" : markets.join(", ")}`, () => {
    assert.deepEqual(under, []);
  });
}

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
