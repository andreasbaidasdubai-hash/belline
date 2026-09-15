/**
 * Belle as the salesperson, without keys.
 *
 * The tools are exercised exactly as the model calls them. What is pinned is
 * the half no prompt can be trusted with: prices come from the catalogue,
 * discounts are refused in code, a trial never starts on an address that was
 * not confirmed, a sign-in link never appears in a reply, checkout is neither
 * offered nor run while card payments are not configured, and none of this is
 * available on a customer's venue.
 *
 *   npm run check:belle-sales
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-sales-"));
delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
// Card payments off unless a test turns them on: the default in every environment without Stripe.
delete process.env.STRIPE_SECRET_KEY;

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listLocations, listLeads, findUserByEmail } = await import("../src/lib/store");
const { BELLINE_LOCATION_ID, bellineVenue } = await import("../src/lib/seed-belline");
const { startCall } = await import("../src/lib/calls");
const { toolsFor, executeTool } = await import("../src/lib/agent/tools");
const { SALES_TOOL_NAMES } = await import("../src/lib/agent/sales");
const { consumeLoginToken, signLoginToken } = await import("../src/lib/auth");
const { TRIAL, annualMonthsSaved, money, priceOf, sellable } = await import("../src/lib/billing/plans");
const { overLimitSentence, volumeSentence } = await import("../src/lib/billing/speak");

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
const belline = getLocation(BELLINE_LOCATION_ID)!;
const customer = listLocations().find((l) => !l.internal && !l.prospect)!;

function chat() {
  const call = startCall(belline, "webchat", "Website");
  return { location: belline, call };
}

/** Runs `fn` with card payments configured. The key is fake: no test here calls Stripe. */
async function withStripe<T>(fn: () => T | Promise<T>): Promise<T> {
  process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
  try {
    return await fn();
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
}

console.log("\n\x1b[1mWho gets the sales tools\x1b[0m\n");

await test("Belle has every sales tool but checkout, on text and on voice, while card payments are off", () => {
  for (const channel of ["text", "voice"] as const) {
    const names = toolsFor(belline, channel).map((t) => t.name);
    for (const tool of SALES_TOOL_NAMES.filter((t) => t !== "send_checkout")) assert.ok(names.includes(tool), `${tool} missing on ${channel}`);
    assert.ok(!names.includes("send_checkout"), `send_checkout offered on ${channel} with no card payments`);
  }
});

await test("checkout is offered once card payments are configured", async () => {
  await withStripe(() => {
    const names = toolsFor(belline, "text").map((t) => t.name);
    for (const tool of SALES_TOOL_NAMES) assert.ok(names.includes(tool), `${tool} missing`);
  });
});

await test("a customer's receptionist has none of them, and cannot run one", async () => {
  const names = toolsFor(customer, "text").map((t) => t.name);
  for (const tool of SALES_TOOL_NAMES) assert.ok(!names.includes(tool), `${tool} offered to a customer venue`);
  const call = startCall(customer, "webchat", "Website");
  const out = await executeTool("quote", {}, { location: customer, call });
  assert.match(JSON.stringify(out.result), /No such tool/);
});

await test("no tool description carries a price, so the model can only get one from quote", () => {
  const described = JSON.stringify(toolsFor(belline, "text").filter((t) => (SALES_TOOL_NAMES as readonly string[]).includes(t.name)));
  assert.doesNotMatch(described, /AED\s*\d/);
});

await test("no tool description claims how long anything takes", async () => {
  const described = JSON.stringify(await withStripe(() => toolsFor(belline, "text")));
  assert.doesNotMatch(described, /about a minute|takes (?:about |a few )?(?:seconds|minutes)|in minutes/i);
});

console.log("\n\x1b[1mQuoting\x1b[0m\n");

await test("quote gives the three plans at the catalogue's prices", async () => {
  const { result } = await executeTool("quote", {}, chat());
  const plans = (result as { plans: { name: string; price: string }[] }).plans;
  assert.deepEqual(plans.map((p) => p.name), sellable("AE").map((p) => p.name));
  for (const p of sellable("AE")) {
    assert.ok(plans.some((q) => q.price === `${money(priceOf(p.id, "AE"), "AE")} a month`), `${p.name} price`);
  }
});

await test("a discount is refused in code, and the conversation is flagged for a person", async () => {
  const ctx = chat();
  const { result } = await executeTool("quote", { asks_for: "discount" }, ctx);
  assert.equal((result as { refused?: string }).refused, "discount");
  assert.match(ctx.call.escalation ?? "", /discount/);
  assert.match((result as { say: string }).say, /same for every business of the same size/);
  assert.match((result as { say: string }).say, /several_locations/);
});

await test("the trial, setup, usage and volume lines are generated, with no old promise", async () => {
  const { result } = await executeTool("quote", {}, chat());
  const q = result as { trial: string; always: string; several_locations: string; annual_months_free: number };
  assert.equal(q.trial, `${TRIAL.days} days free, ${TRIAL.minutes} voice minutes and ${TRIAL.conversations} text conversations, no card`);
  assert.doesNotMatch(q.trial, /every channel/);
  assert.ok(q.always.includes(overLimitSentence()), "the usage rule is not the catalogue's");
  assert.equal(q.several_locations, volumeSentence());
  assert.equal(q.annual_months_free, annualMonthsSaved(["v2_growth"], "AE"));
  assert.doesNotMatch(JSON.stringify(result), /no per-minute|keeps answering|No setup fee/i);
  // Assisted setup is priced but cannot be bought yet, so it is not quoted.
  assert.doesNotMatch(q.always, /assisted/i);
});

await test("a spoken quote asks for voice minutes, not phone minutes", async () => {
  const call = startCall(belline, "browser", "bell");
  const { result } = await executeTool("quote", {}, { location: belline, call });
  assert.match((result as { say: string }).say, /voice minutes/);
});

await test("a group with several venues is handed to a person", async () => {
  const ctx = chat();
  await executeTool("quote", { asks_for: "several_venues" }, ctx);
  assert.match(ctx.call.escalation ?? "", /several venues/i);
});

console.log("\n\x1b[1mStarting a trial\x1b[0m\n");

await test("no trial on an address that was not read back and confirmed", async () => {
  const { result } = await executeTool(
    "start_trial",
    { business_name: "Palm Dental", email: "owner@palmdental.test", email_confirmed: false, vertical: "clinic" },
    chat(),
  );
  assert.equal((result as { started: boolean }).started, false);
  assert.equal(findUserByEmail("owner@palmdental.test"), undefined);
});

await test("a confirmed address starts a card-free trial, and no sign-in link appears in the reply", async () => {
  const { result } = await executeTool(
    "start_trial",
    { business_name: "Palm Dental", email: "owner@palmdental.test", email_confirmed: true, vertical: "clinic", website: "https://palmdental.test" },
    chat(),
  );
  assert.equal((result as { started: boolean }).started, true);
  assert.doesNotMatch(JSON.stringify(result), /takes minutes|\bminutes\b/, "a setup time crept back into what she says");
  const user = findUserByEmail("owner@palmdental.test");
  assert.ok(user, "no account");
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|magic\?t=/);
  const venue = listLocations().find((l) => l.tenantId === user!.tenantId)!;
  assert.equal(venue.subscription?.status, "trialing");
});

await test("an address that already has an account is not signed up twice", async () => {
  const { result } = await executeTool(
    "start_trial",
    { business_name: "Palm Dental Two", email: "owner@palmdental.test", email_confirmed: true, vertical: "clinic" },
    chat(),
  );
  assert.equal((result as { started: boolean }).started, false);
});

await test("a sign-in link works once, only the latest one works, and it expires", () => {
  const user = findUserByEmail("owner@palmdental.test")!;
  const first = signLoginToken(user);
  const second = signLoginToken(findUserByEmail("owner@palmdental.test")!);
  assert.equal(consumeLoginToken(first), null, "an older link still worked");
  assert.equal(consumeLoginToken(second)?.id, user.id);
  assert.equal(consumeLoginToken(second), null, "a link worked twice");

  const late = signLoginToken(findUserByEmail("owner@palmdental.test")!);
  assert.equal(consumeLoginToken(late, Date.now() + 25 * 3_600_000), null, "a day-old link worked");
  const forged = late.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal(consumeLoginToken(forged), null);
});

console.log("\n\x1b[1mDemos, checkout and leads\x1b[0m\n");

await test("a demo is never built from a private address", async () => {
  const { result } = await executeTool("build_demo", { website: "http://169.254.169.254/" }, chat());
  assert.equal((result as { built: boolean }).built, false);
});

await test("without card payments, checkout is refused in code even if the model calls it", async () => {
  const out = await executeTool("send_checkout", { email: "owner@palmdental.test", plan: "v2_growth" }, chat());
  const result = out.result as { sent: boolean; say: string };
  assert.equal(result.sent, false);
  assert.match(result.say, /card payments are not open yet/i);
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\//);
});

await test("checkout only for a real plan, and the link goes by email, not into the reply", async () => {
  await withStripe(async () => {
    const bad = await executeTool("send_checkout", { email: "owner@palmdental.test", plan: "everything_business" }, chat());
    assert.equal((bad.result as { sent: boolean }).sent, false, "a plan that is no longer sold was accepted");
    const good = await executeTool("send_checkout", { email: "owner@palmdental.test", plan: "v2_growth" }, chat());
    assert.doesNotMatch(JSON.stringify(good.result), /https?:\/\//);
  });
});

await test("a lead is saved once per prospect, marked as coming from Belle", async () => {
  const before = listLeads().length;
  const ctx = chat();
  await executeTool("record_lead", { business: "Marina Smiles", email: "sara@marinasmiles.test", stage: "interested" }, ctx);
  await executeTool("record_lead", { business: "Marina Smiles", email: "sara@marinasmiles.test", pain: "Phones ring out at lunch", stage: "wants_trial" }, ctx);
  const mine = listLeads().filter((l) => l.email === "sara@marinasmiles.test");
  assert.equal(listLeads().length, before + 1);
  assert.equal(mine[0].source, "belle:chat");
  assert.equal(mine[0].intent, "wants_trial");
  assert.match(mine[0].notes ?? "", /lunch/);
});

await test("the booking system a prospect uses is kept with the lead, and not lost on a later update", async () => {
  const ctx = chat();
  await executeTool("record_lead", { business: "Jumeirah Cuts", email: "rana@jcuts.test", booking_system: "Fresha", stage: "interested" }, ctx);
  await executeTool("record_lead", { business: "Jumeirah Cuts", email: "rana@jcuts.test", pain: "Missed calls during colour appointments", stage: "wants_demo" }, ctx);
  const lead = listLeads().find((l) => l.email === "rana@jcuts.test")!;
  assert.match(lead.notes ?? "", /Booking system: Fresha/);
  assert.match(lead.notes ?? "", /colour appointments/);
  const tool = toolsFor(belline, "text").find((t) => t.name === "record_lead")!;
  assert.ok("booking_system" in (tool.input_schema as { properties: Record<string, unknown> }).properties);
});

console.log("\n\x1b[1mHow she sells\x1b[0m\n");

await test("her path is the demo, then the trial, then checkout, and a person last", () => {
  const path = bellineVenue.agent.policies.find((p) => p.startsWith("Your path"))!;
  assert.ok(path, "no path policy");
  const order = ["build_demo", "start_trial", "send_checkout", "wants_person"].map((s) => path.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `missing a step: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the steps are out of order");
});

await test("she books nothing: no booking tools on Belline's line, and a rule against naming times", () => {
  const names = toolsFor(belline, "text").map((t) => t.name);
  for (const tool of ["check_availability", "book", "lookup_booking", "change_booking", "cancel_booking", "join_waitlist"]) {
    assert.ok(!names.includes(tool), `${tool} is still offered to Belle`);
  }
  assert.ok(toolsFor(customer, "text").some((t) => t.name === "book"), "a customer's receptionist lost its booking tools");
  assert.match(bellineVenue.agent.policies.join(" "), /never offer, suggest or name a time/);
});

await test("her prompt carries no booking rules and no demonstration-line block", async () => {
  const { staticPrompt } = await import("../src/lib/agent/prompt");
  const prompt = staticPrompt(belline, "text");
  assert.doesNotMatch(prompt, /# Booking rules/);
  assert.doesNotMatch(prompt, /This is a demonstration line/);
  assert.doesNotMatch(prompt, /check_availability/);
  assert.match(staticPrompt(customer, "text"), /# Booking rules/);
});

await test("she sells with psychology but never fakes proof or urgency", () => {
  const policies = bellineVenue.agent.policies.join(" ");
  assert.match(policies, /Never fake urgency or scarcity/);
  assert.match(policies, /own numbers, never invented ones/);
});

await test("she discloses being an AI, sells with specifics, and names nothing that is not live", () => {
  const policies = bellineVenue.agent.policies.join(" ");
  assert.match(policies, /you are an AI/);
  assert.match(policies, /Never name or criticise a competitor/);
  assert.match(policies, /WhatsApp/, "the not-yet list is not generated from the catalogue");
  assert.doesNotMatch(policies, /live call transfer/, "the stale hand-typed not-yet list is back");
  assert.match(policies, /Card payment at checkout/, "card payment is not named as not-yet while Stripe is off");
  assert.doesNotMatch(policies, /usually one or two saved bookings|takes minutes|in minutes|fourteen days free/i);
  assert.match(policies, /booking system or calendar they use/);
  assert.match(bellineVenue.agent.persona, /salesperson/);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
