/**
 * The billing engine, and the promise the pricing page makes about it.
 *
 * Two things here reach a customer directly: a number on an invoice, and a
 * claim on a pricing page. Both are tested as if somebody will argue with
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
const plans = await import("../src/lib/billing/plans");
const { MARKETS, MARKET_CODES, formatMoney, liveMarkets } = await import("../src/lib/markets");
const usage = await import("../src/lib/billing/usage");
const { applyPricing, renderMarket, renderPricing } = await import("./site-pricing");
const { priceAnswer, trialAnswer, numberWords } = await import("../src/lib/billing/speak");
const { bellineVenue } = await import("../src/lib/seed-belline");

const { PRODUCTS, TRIAL, aed, allowanceText, annualPerMonth, notYetLive, priceOf, publicLines, sellable } = plans;
const { billableMinutes, billableVoiceMinutes, conversationStarts, periodFor, accountFor, MINUTE_DEFINITION, CONVERSATION_DEFINITION } = usage;

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

type Channel = "phone" | "browser" | "embed" | "webchat" | "whatsapp";

/** A completed voice call of a given length, on a given day. */
function call(seconds: number, day: string, extra: Record<string, unknown> = {}) {
  const c = startCall(getLocation(base.id)!, "phone", "+971501234567");
  const start = new Date(`${day}T12:00:00Z`);
  return saveCall({
    ...c,
    ...extra,
    channel: (extra.channel as Channel) ?? "phone",
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + seconds * 1000).toISOString(),
    status: (extra.status as "completed" | "failed") ?? "completed",
    outcome: "booking_created",
  });
}

/** A written thread with Belline's replies at the given hours after the start of `day`. */
function thread(day: string, replyHours: number[], extra: Record<string, unknown> = {}) {
  const c = startCall(getLocation(base.id)!, "webchat", "Website");
  const start = Date.parse(`${day}T08:00:00Z`);
  const transcript = replyHours.flatMap((h) => [
    { role: "caller" as const, text: "Hello", at: new Date(start + h * 3_600_000 - 1000).toISOString() },
    { role: "agent" as const, text: "Hi there", at: new Date(start + h * 3_600_000).toISOString() },
  ]);
  return saveCall({
    ...c,
    ...extra,
    channel: (extra.channel as Channel) ?? "webchat",
    startedAt: new Date(start).toISOString(),
    status: "active",
    transcript,
  } as never);
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
  assert.equal(billableVoiceMinutes(call(300, "2026-03-02", { channel: "browser" })), 0);
});

test("a call through the website's voice button is billed as a voice-button minute, not a phone one", () => {
  const bell = call(90, "2026-03-02", { channel: "embed" });
  assert.equal(billableVoiceMinutes(bell), 2);
  assert.equal(billableMinutes(bell), 0);
});

test("the public demo line is our expense, not theirs", () => {
  assert.equal(billableMinutes(call(300, "2026-03-02", { isDemo: true })), 0);
});

test("a call our own server broke is not billed", () => {
  // `failed` is what reconcileStaleCalls sets when the process died mid-call.
  assert.equal(billableMinutes(call(300, "2026-03-02", { status: "failed" })), 0);
});

console.log("\nWhat counts as a conversation\n");

test("a thread Belline never replied to is free", () => {
  assert.deepEqual(conversationStarts(thread("2026-03-03", [])), []);
});

test("any number of replies inside 24 hours is one conversation", () => {
  assert.equal(conversationStarts(thread("2026-03-03", [0, 1, 5, 23.9])).length, 1);
});

test("a reply more than 24 hours after the first starts the next one", () => {
  assert.equal(conversationStarts(thread("2026-03-03", [0, 2, 25, 26, 50])).length, 3);
});

test("a demo thread is free, and the definition says what counts", () => {
  assert.equal(conversationStarts(thread("2026-03-03", [0], { isDemo: true })).length, 0);
  assert.match(CONVERSATION_DEFINITION, /24 hours/);
  assert.match(CONVERSATION_DEFINITION, /replies at least once/);
});

console.log("\nBilling periods\n");

const anchor = (startedOn: string) => ({ startedOn });

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
  assert.equal(periodFor(anchor("2026-03-10"), "2026-04-10").start, "2026-04-10");
});

test("a subscription started on the 31st bills on the 28th in February", () => {
  const p = periodFor(anchor("2026-01-31"), "2026-03-01");
  assert.equal(p.start, "2026-02-28", `got ${p.start}`);
  assert.equal(p.end, "2026-03-31", `got ${p.end}`);
});

test("and goes back to the 31st in March — the anchor is remembered, not clamped", () => {
  const p = periodFor(anchor("2026-01-31"), "2026-04-05");
  assert.equal(p.start, "2026-03-31", `got ${p.start}`);
  assert.equal(p.end, "2026-04-30", `got ${p.end}`);
});

test("a leap year's 29th is handled", () => {
  assert.equal(periodFor(anchor("2028-01-31"), "2028-02-29").start, "2028-02-29");
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
      products: ["everything_business"],
      market: "AE",
      cycle: "monthly",
      startedOn: "2026-03-01",
      status: "active",
      ...over,
    } as never,
  });
  return getLocation(base.id)!;
}

const channelOf = (account: NonNullable<ReturnType<typeof accountFor>>, channel: string) =>
  account.usage.channels.find((c) => c.channel === channel)!;

test("inside the allowance the invoice is just the plan", () => {
  const account = accountFor(subscribe({}), "2026-03-15")!;
  assert.ok(account.usage.channels.every((c) => c.overBy === 0));
  assert.equal(account.bill.dueNow, priceOf("everything_business", "AE"));
});

test("a bundle shows every channel it includes, each against its own allowance", () => {
  const account = accountFor(subscribe({}), "2026-03-15")!;
  assert.deepEqual(account.usage.channels.map((c) => c.channel), ["phone", "web_voice", "chat", "whatsapp"]);
  assert.equal(channelOf(account, "phone").included, 600);
  assert.equal(channelOf(account, "chat").included, 400);
});

test("money is whole minor units, so an invoice can never print a float artefact", () => {
  for (const p of PRODUCTS) {
    for (const v of Object.values(p.prices)) assert.ok(Number.isInteger(v), `${p.id} is not whole`);
  }
  assert.equal(aed(89900), "AED 899");
  assert.equal(aed(19865), "AED 198.65");
  assert.equal(formatMoney(3500, "GB"), "£35");
  assert.equal(formatMoney(14900, "CH"), "CHF 149");
});

test("going past the allowance costs nothing — it recommends the next tier", () => {
  // The promise the pricing page makes is that the invoice is the plan fee and
  // nothing else. This is the test that keeps it honest.
  const loc = subscribe({ products: ["phone_starter"], startedOn: "2026-06-01" });
  for (let i = 0; i < 250; i++) call(30, "2026-06-05");
  const account = accountFor(getLocation(loc.id)!, "2026-06-15")!;
  const phone = channelOf(account, "phone");
  assert.equal(phone.used, 250);
  assert.equal(phone.overBy, 50);
  assert.equal(account.bill.dueNow, priceOf("phone_starter", "AE"), "a metered charge appeared on the bill");
  assert.deepEqual(account.usage.upgrade?.products, ["phone_business"]);
  assert.match(account.notes.join(" "), /still being answered and nothing extra/);
});

test("nobody is ever told a paid channel stops because of an allowance", () => {
  const account = accountFor(subscribe({ products: ["phone_starter"], startedOn: "2026-06-01" }), "2026-06-15")!;
  assert.doesNotMatch(account.notes.join(" "), /stop answering|calls will stop|suspend|paused/i);
});

test("a grandfathered Enterprise venue keeps its uncounted minutes", () => {
  const loc = subscribe({ products: undefined, planId: "enterprise", startedOn: "2026-06-01", grandfatheredUntil: "2026-09-01" });
  const account = accountFor(getLocation(loc.id)!, "2026-06-15")!;
  const phone = channelOf(account, "phone");
  assert.equal(phone.included, null, "unlimited was given a number");
  assert.equal(phone.overBy, 0);
  assert.equal(account.usage.upgrade, null);
  assert.equal(account.bill.dueNow, 899 * 100);
  assert.match(account.notes.join(" "), /original .* plan, kept exactly as it was/);
});

test("the recommendation only ever points upwards", () => {
  const quiet = listLocations().find((l) => l.vertical === "clinic")!;
  upsertLocation({
    ...quiet,
    subscription: { products: ["everything_pro"], cycle: "monthly", startedOn: "2026-06-01", status: "active" },
  } as never);
  assert.equal(accountFor(getLocation(quiet.id)!, "2026-06-15")!.usage.upgrade, null);
});

test("calls from another period are not on this invoice", () => {
  const loc = subscribe({});
  const before = channelOf(accountFor(getLocation(loc.id)!, "2026-03-15")!, "phone").used;
  call(600, "2026-02-14");
  call(600, "2026-05-14");
  assert.equal(channelOf(accountFor(getLocation(loc.id)!, "2026-03-15")!, "phone").used, before);
});

test("website chat conversations are counted against the chat allowance", () => {
  const loc = subscribe({ products: ["chat"], startedOn: "2026-10-01" });
  thread("2026-10-02", [0, 30]);
  thread("2026-10-03", [0]);
  const chat = channelOf(accountFor(getLocation(loc.id)!, "2026-10-10")!, "chat");
  assert.equal(chat.used, 3);
  assert.equal(chat.included, 150);
});

test("the free chat is the one allowance that pauses, and the dashboard says so", () => {
  const loc = subscribe({ products: ["chat_free"], startedOn: "2026-11-01" });
  for (let i = 0; i < 100; i++) thread("2026-11-02", [0]);
  // Late in the period, so the pace is the usage rather than a projection of it.
  const account = accountFor(getLocation(loc.id)!, "2026-11-29")!;
  assert.equal(channelOf(account, "chat").used, 100);
  assert.equal(account.bill.dueNow, 0);
  assert.match(account.notes.join(" "), /paused until/);
  assert.deepEqual(account.usage.upgrade?.products, ["chat"]);
});

test("the annual cycle is prepaid, so nothing is invoiced during the year", () => {
  const account = accountFor(subscribe({ cycle: "annual" }), "2026-03-15")!;
  assert.equal(account.bill.prepaid, true);
  assert.equal(account.bill.dueNow, 0, "an annual plan was billed twice");
  assert.equal(account.bill.planFee, annualPerMonth(["everything_business"], "AE"));
});

test("a trial charges nothing, switches every channel on and does not upsell", () => {
  const account = accountFor(
    subscribe({ status: "trialing", products: ["everything_starter"], trial: { endsOn: "2026-03-15", minutes: 60 } }),
    "2026-03-10",
  )!;
  assert.equal(channelOf(account, "phone").included, 60);
  assert.equal(account.usage.channels.length, 4);
  assert.equal(account.bill.dueNow, 0, "a trial was invoiced");
  assert.equal(account.usage.upgrade, null, "a trial was upsold before it had finished");
  assert.match(account.notes.join(" "), /Nothing is charged|Nothing has been charged/);
});

test("a venue with no subscription has no account rather than a zeroed one", () => {
  const { subscription: _drop, ...without } = getLocation(base.id)!;
  upsertLocation(without as never);
  assert.equal(accountFor(getLocation(base.id)!, "2026-03-15"), null);
});

test("somebody heading past the allowance is told early, not at the end", () => {
  const loc = subscribe({ products: ["phone_starter"], startedOn: "2026-07-01" });
  for (let i = 0; i < 150; i++) call(60, "2026-07-01");
  const phone = channelOf(accountFor(getLocation(loc.id)!, "2026-07-01")!, "phone");
  assert.equal(phone.overBy, 0, "already over — this tests the warning, not the state");
  assert.ok(phone.projected > (phone.included as number));
  assert.match(accountFor(getLocation(loc.id)!, "2026-07-01")!.notes.join(" "), /Told now rather than at the end/);
});

console.log("\nWhat the website is allowed to say\n");

const landing = fs.readFileSync(path.join(ROOT, "public", "landing.html"), "utf8");
const publicPages = fs
  .readdirSync(path.join(ROOT, "public"))
  .filter((f) => f.endsWith(".html"))
  .map((f) => ({ file: f, html: fs.readFileSync(path.join(ROOT, "public", f), "utf8") }));

test("the pricing on the page is exactly what the catalogue renders — run npm run pricing if not", () => {
  assert.equal(applyPricing(landing), landing, "public/landing.html is stale against src/lib/billing/plans.ts");
});

test("every market's page carries every sellable product's price, allowances and live lines", () => {
  // Every market, not only the open ones: the day a market opens, its page is
  // already pinned.
  for (const market of MARKET_CODES) {
    const html = renderMarket(market);
    for (const product of sellable(market)) {
      if (!product.free) assert.ok(html.includes(formatMoney(priceOf(product.id, market), market)), `${product.id} ${market} price`);
      for (const line of publicLines(product)) {
        assert.ok(html.includes(line.replace(/&/g, "&amp;")), `${market} ${product.id}: "${line}" is live but missing`);
      }
    }
  }
});

test("the open markets' prices are on the landing page, and the closed markets' are not", () => {
  for (const market of liveMarkets()) {
    for (const product of sellable(market).filter((p) => !p.free)) {
      assert.ok(landing.includes(formatMoney(priceOf(product.id, market), market)), `${product.name} ${market}`);
    }
  }
  for (const market of MARKET_CODES.filter((m) => MARKETS[m].status !== "live")) {
    assert.ok(!landing.includes(`data-market="${market}"`), `${MARKETS[market].name} is on the page and is not open`);
  }
});

test("a second open market renders with a picker and its own hidden block", () => {
  const html = renderPricing(["AE", "GB"]);
  assert.match(html, /data-market-pick/);
  assert.match(html, /data-market="GB" hidden/);
  assert.ok(html.includes("£35"));
});

test("nothing that is not yet live appears anywhere public", () => {
  // The guarantee, rather than a promise to remember.
  const hidden = notYetLive().filter((g) => !["Market", "Channel", "Product", "Service"].includes(g.where));
  for (const { file, html } of publicPages) {
    for (const gap of hidden) {
      assert.ok(!html.includes(gap.feature), `${file} advertises "${gap.feature}", which does not work yet`);
    }
    for (const product of PRODUCTS.filter((p) => p.kind === "bundle")) {
      const whatsapp = allowanceText("whatsapp", product.allowances.whatsapp as number);
      assert.ok(!html.includes(whatsapp), `${file} sells "${whatsapp}"`);
    }
  }
});

test("the old ladder is gone from the page", () => {
  for (const old of ["AED 179", "AED 365", "AED 899", "Enterprise", "Unlimited voice minutes", "checkout?plan="]) {
    assert.ok(!landing.includes(old), `landing.html still says "${old}"`);
  }
});

test("the page never quotes a per-minute or per-conversation rate, because there is not one", () => {
  for (const { file, html } of publicPages) {
    assert.doesNotMatch(html, /AED\s*\d+\.\d{2}\s*(each|a minute|per minute|a conversation|per conversation)/i, file);
  }
});

test("the page explains what a minute and a conversation are, in the engine's own words", () => {
  assert.ok(landing.includes(MINUTE_DEFINITION), "the minute definition has drifted");
  assert.ok(landing.includes(CONVERSATION_DEFINITION), "the conversation definition has drifted");
});

test("the trial reads the same on the pricing page, in the terms and in Belle's mouth", () => {
  assert.ok(landing.includes(`${TRIAL.phoneMinutes} minutes of live calls`));
  const terms = publicPages.find((p) => p.file === "terms.html")!.html;
  assert.ok(terms.includes(`${TRIAL.days} days and includes ${TRIAL.phoneMinutes} minutes of live calls`));
  const faqs = bellineVenue.agent.faqs.map((f) => f.a);
  assert.ok(faqs.includes(trialAnswer()), "Belle's trial answer is not generated from the catalogue");
});

test("Belle's price answer is generated from the catalogue and names nothing that is not live", () => {
  const answer = priceAnswer("AE");
  assert.ok(bellineVenue.agent.faqs.some((f) => f.a === answer), "Belle's price answer is hand-typed");
  assert.ok(answer.includes(numberWords(priceOf("everything_starter", "AE") / 100)));
  assert.doesNotMatch(answer, /WhatsApp|unlimited|discount/i);
});

test("the gaps are written down rather than merely absent", () => {
  const gaps = notYetLive();
  assert.ok(gaps.length > 0, "nothing is recorded as not-yet-live — is that really true?");
  for (const gap of gaps) assert.ok(gap.gap.length > 40, `${gap.feature}: the reason is too thin to act on`);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n[32m✓ ${passed} passed, 0 failed[0m\n` : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
