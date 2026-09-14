/**
 * The catalogue, and whether it makes money.
 *
 * Three things are pinned here. The prices are the strategy doc's (§2.2,
 * §2.4, addendum), and anything derived rather than decided says so. What a
 * customer may buy is exactly what the checkout, the API and the Stripe
 * webhook agree on. And every module and bundle clears its margin floor at
 * typical use — 30% for a bundle, 45% for a module — computed from the same
 * rate card the meter uses (Phase 1), not from a spreadsheet.
 *
 * A margin basis that rests on an unverified rate (the UAE line, today) is
 * printed and reported, not enforced; it becomes a hard gate the moment its
 * rates are verified or set with RATE_<KEY>.
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

const selfServe = PRODUCTS.filter((p) => p.kind === "module" || p.kind === "bundle");
const major = (id: ProductId, m: Market) => priceOf(id, m) / 100;

console.log("\n\x1b[1mThe catalogue\x1b[0m\n");

test("every price is whole minor units and a whole unit of currency", () => {
  for (const p of [...PRODUCTS, ...SERVICES]) {
    for (const [m, v] of Object.entries(p.prices)) {
      assert.ok(Number.isInteger(v) && (v as number) >= 0, `${p.id} ${m}: ${v}`);
      assert.equal((v as number) % 100, 0, `${p.id} ${m} is not a whole ${MARKETS[m as Market].currency}`);
    }
  }
});

test("the self-serve ladder is priced in every market", () => {
  for (const p of selfServe) {
    for (const m of MARKET_CODES) assert.ok(p.prices[m] !== undefined, `${p.id} has no ${m} price`);
  }
});

test("nothing that can be bought or quoted is unlimited", () => {
  for (const p of PRODUCTS.filter((p) => p.kind !== "legacy")) {
    for (const [channel, v] of Object.entries(p.allowances)) {
      assert.equal(typeof v, "number", `${p.id} leaves ${channel} uncounted`);
    }
  }
});

test("the UAE prices are the strategy doc's (§2.2)", () => {
  const doc: Partial<Record<ProductId, number>> = {
    chat_free: 0, chat: 49, whatsapp: 99, web_voice: 99,
    phone_starter: 149, phone_business: 349, phone_pro: 799,
    everything_starter: 249, everything_business: 499, everything_pro: 999,
  };
  for (const [id, aed] of Object.entries(doc)) {
    assert.equal(major(id as ProductId, "AE"), aed, id);
    assert.ok(!productById(id as ProductId).provisional?.includes("AE"), `${id} AE is from the doc, not provisional`);
  }
});

test("the allowances are the strategy doc's (§2.2)", () => {
  const doc: Record<string, Record<string, number>> = {
    chat_free: { chat: 100 }, chat: { chat: 150 }, whatsapp: { whatsapp: 300 }, web_voice: { web_voice: 150 },
    phone_starter: { phone: 200 }, phone_business: { phone: 600 }, phone_pro: { phone: 1500 },
    everything_starter: { phone: 200, web_voice: 100, chat: 150, whatsapp: 300 },
    everything_business: { phone: 600, web_voice: 200, chat: 400, whatsapp: 800 },
    everything_pro: { phone: 1500, web_voice: 300, chat: 1000, whatsapp: 1500 },
  };
  for (const [id, allowances] of Object.entries(doc)) {
    assert.deepEqual(productById(id as ProductId).allowances, allowances, id);
  }
});

test("each market's phone tiers are §2.4's, and Switzerland's the addendum's", () => {
  const doc: Partial<Record<Market, [number, number, number]>> = {
    AE: [149, 349, 799], GB: [35, 79, 179], AU: [59, 139, 319], CA: [55, 129, 299],
    US: [39, 95, 219], SG: [55, 129, 299], IE: [39, 89, 199], CH: [149, 349, 699],
  };
  for (const [m, tiers] of Object.entries(doc) as [Market, number[]][]) {
    (["phone_starter", "phone_business", "phone_pro"] as const).forEach((id, i) => {
      assert.equal(major(id, m), tiers[i], `${id} in ${m}`);
      assert.ok(!productById(id).provisional?.includes(m), `${id} ${m} is from the doc, not provisional`);
    });
  }
});

test("every price the doc did not set is marked provisional", () => {
  const phone = new Set<ProductId>(["phone_starter", "phone_business", "phone_pro"]);
  for (const p of selfServe) {
    for (const m of MARKET_CODES) {
      const decided = p.id === "chat_free" || m === "AE" || (phone.has(p.id) && m !== "NZ");
      if (!decided) assert.ok(p.provisional?.includes(m), `${p.id} in ${m} is derived but not marked provisional`);
    }
  }
});

test("in every market the tiers climb in price and allowance, and a bundle costs more than its phone tier", () => {
  const ladders: ProductId[][] = [
    ["phone_starter", "phone_business", "phone_pro"],
    ["everything_starter", "everything_business", "everything_pro"],
  ];
  for (const m of MARKET_CODES) {
    for (const ladder of ladders) {
      for (let i = 1; i < ladder.length; i++) {
        assert.ok(priceOf(ladder[i], m) > priceOf(ladder[i - 1], m), `${ladder[i]} is not dearer than ${ladder[i - 1]} in ${m}`);
        assert.ok(
          (productById(ladder[i]).allowances.phone ?? 0) > (productById(ladder[i - 1]).allowances.phone ?? 0),
          `${ladder[i]} does not include more than ${ladder[i - 1]}`,
        );
      }
    }
    (["starter", "business", "pro"] as const).forEach((tier) => {
      assert.ok(
        priceOf(`everything_${tier}`, m) > priceOf(`phone_${tier}`, m),
        `Everything ${tier} is not dearer than Phone ${tier} in ${m}`,
      );
    });
  }
});

test("annual is ten months for twelve, and the monthly equivalent never overstates it", () => {
  for (const p of selfServe) {
    for (const m of MARKET_CODES) {
      assert.equal(periodFee([p.id], m, "annual"), priceOf(p.id, m) * 10, `${p.id} ${m}`);
      assert.ok(annualPerMonth([p.id], m) * 12 <= periodFee([p.id], m, "annual"), `${p.id} ${m} overstates`);
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

test("WhatsApp is not sold, or shown on a bundle, until it works", () => {
  assert.equal(CHANNELS.whatsapp.status, "not-yet");
  for (const m of MARKET_CODES) assert.equal(isSellable(productById("whatsapp"), m), false);
  for (const p of selfServe.filter((p) => p.kind === "bundle")) {
    const line = allowanceText("whatsapp", p.allowances.whatsapp as number);
    assert.ok(!publicLines(p).includes(line), `${p.name} shows "${line}"`);
  }
});

test("the free chat is capped: 100 conversations, Haiku, 20 messages, the badge", () => {
  const free = productById("chat_free");
  assert.equal(free.allowances.chat, 100);
  assert.deepEqual(free.free, { model: "claude-haiku-4-5", maxMessagesPerChat: 20, badge: true, inboxTakeover: false });
  for (const m of MARKET_CODES) assert.equal(priceOf("chat_free", m), 0);
});

test("the trial is fourteen days and sixty phone minutes (§2.3)", () => {
  assert.equal(TRIAL.days, 14);
  assert.equal(TRIAL.phoneMinutes, 60);
});

test("no per-minute or per-conversation charge is described anywhere in the catalogue", () => {
  assert.doesNotMatch(JSON.stringify(PRODUCTS), /overage|per minute|per conversation|extra minutes/i);
});

console.log("\n\x1b[1mWhat a customer may buy\x1b[0m\n");

test("a bundle on its own", () => {
  const s = checkSelection(["everything_business"], "AE");
  assert.ok(s.ok && s.products.join() === "everything_business");
});

test("modules, one per channel, in a fixed order whatever order they were picked in", () => {
  const s = checkSelection(["chat", "phone_starter", "web_voice"], "AE");
  assert.ok(s.ok, s.ok ? "" : s.error);
  assert.deepEqual(s.products, ["chat", "web_voice", "phone_starter"]);
});

test("the free chat with a phone — the dashboard's one-click upsell", () => {
  assert.ok(checkSelection(["chat_free", "phone_starter"], "AE").ok);
});

test("refused: a bundle with a module, two phone tiers, free and paid chat, WhatsApp, a managed plan, nonsense, nothing", () => {
  for (const bad of [
    ["everything_starter", "chat"],
    ["phone_starter", "phone_business"],
    ["chat_free", "chat"],
    ["whatsapp"],
    ["professional"],
    ["starter"],
    ["everything"],
    [],
  ]) {
    assert.equal(checkSelection(bad, "AE").ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

console.log("\n\x1b[1mMoving up\x1b[0m\n");

test("a busy free chat is pointed at the paid chat", () => {
  assert.deepEqual(recommend({ chat: 130 }, ["chat_free"], "AE")?.products, ["chat"]);
});

test("a busy phone moves one tier, not two", () => {
  assert.deepEqual(recommend({ phone: 450 }, ["phone_starter"], "AE")?.products, ["phone_business"]);
});

test("a channel they pay for stays in the answer, even after a quiet month", () => {
  const r = recommend({ phone: 700, chat: 0 }, ["phone_starter", "chat"], "AE");
  assert.ok(r?.products.includes("chat"), `dropped the chat: ${r?.products}`);
  assert.deepEqual(r?.products, ["chat", "phone_pro"]);
});

test("a bundle wins when it is cheaper than the modules", () => {
  assert.deepEqual(recommend({ phone: 150, web_voice: 60, chat: 100 }, ["phone_starter"], "AE")?.products, [
    "everything_starter",
  ]);
});

test("a plan that fits recommends nothing, and nothing is ever recommended downwards", () => {
  assert.equal(recommend({ phone: 100 }, ["phone_starter"], "AE"), null);
  assert.equal(recommend({ phone: 5 }, ["everything_pro"], "AE"), null);
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

const priced = selfServe.filter((p) => !p.free);
const floorOf = (kind: string) => (kind === "bundle" ? margin.MARGIN_FLOOR.bundle : margin.MARGIN_FLOOR.module);

for (const basis of margin.BASIS_ORDER) {
  const unverified = margin.unverifiedLines(basis);
  console.log(`\n  ${margin.BASES[basis].label}${unverified.length ? `  \x1b[33m(provisional: ${unverified.join(", ")} unverified)\x1b[0m` : ""}\n`);
  console.log(`  ${"".padEnd(30)}${MARKET_CODES.map((m) => m.padStart(9)).join("")}`);

  const under: string[] = [];
  for (const p of priced) {
    const cells = MARKET_CODES.map((m) => {
      const typical = margin.marginOf(p, m, basis, margin.TYPICAL_USE).margin!;
      const full = margin.marginOf(p, m, basis, 1).margin!;
      if (typical < floorOf(p.kind)) under.push(`${p.name} in ${m}: ${Math.round(typical * 100)}% (floor ${floorOf(p.kind) * 100}%)`);
      const cell = `${Math.round(typical * 100)}/${Math.round(full * 100)}`;
      return (typical < floorOf(p.kind) ? `\x1b[31m${cell.padStart(9)}\x1b[0m` : cell.padStart(9));
    });
    console.log(`  ${p.name.padEnd(30)}${cells.join("")}`);
  }
  const free = productById("chat_free");
  console.log(`  ${"Chat Receptionist — Free".padEnd(30)} costs $${margin.marginOf(free, "AE", basis, 1).costUsd.toFixed(2)} a month per account at full use`);
  console.log("");

  if (unverified.length === 0) {
    test(`${basis}: every bundle clears 30% and every module 45% at typical use, in every market`, () => {
      assert.deepEqual(under, []);
    });
  } else {
    test(`${basis}: reported, not enforced, while it rests on unverified rates (${under.length} under the floor)`, () => {
      for (const line of under) console.log(`      \x1b[33m⚠\x1b[0m ${line}`);
      assert.ok(true);
    });
  }
}

test("a basis becomes a hard gate once its rates are verified", () => {
  const lines = margin.unverifiedLines("conservative");
  for (const key of lines) process.env[`RATE_${key}`] = "0.01";
  try {
    assert.deepEqual(margin.unverifiedLines("conservative"), []);
  } finally {
    for (const key of lines) delete process.env[`RATE_${key}`];
  }
});

test("the free chat costs about what §2.2 says — $1.50 a month lean, $3 conservative", () => {
  const free = productById("chat_free");
  assert.ok(margin.marginOf(free, "AE", "lean", 1).costUsd <= 1.6);
  assert.ok(margin.marginOf(free, "AE", "conservative", 1).costUsd <= 3.1);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
