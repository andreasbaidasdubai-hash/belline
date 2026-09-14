/**
 * Belle as the salesperson, without keys.
 *
 * The tools are exercised exactly as the model calls them. What is pinned is
 * the half no prompt can be trusted with: prices come from the catalogue,
 * discounts are refused in code, a trial never starts on an address that was
 * not confirmed, a sign-in link never appears in a reply, and none of this is
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

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listLocations, listLeads, findUserByEmail } = await import("../src/lib/store");
const { BELLINE_LOCATION_ID, bellineVenue } = await import("../src/lib/seed-belline");
const { startCall } = await import("../src/lib/calls");
const { toolsFor, executeTool } = await import("../src/lib/agent/tools");
const { SALES_TOOL_NAMES } = await import("../src/lib/agent/sales");
const { consumeLoginToken, signLoginToken } = await import("../src/lib/auth");
const { money, priceOf, sellable } = await import("../src/lib/billing/plans");

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

console.log("\n\x1b[1mWho gets the sales tools\x1b[0m\n");

await test("Belle has every sales tool, on text and on voice", () => {
  for (const channel of ["text", "voice"] as const) {
    const names = toolsFor(belline, channel).map((t) => t.name);
    for (const tool of SALES_TOOL_NAMES) assert.ok(names.includes(tool), `${tool} missing on ${channel}`);
  }
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
  assert.match((result as { say: string }).say, /same for everyone/);
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

await test("checkout only for a real plan, and the link goes by email, not into the reply", async () => {
  const bad = await executeTool("send_checkout", { email: "owner@palmdental.test", plan: "everything_ultra" }, chat());
  assert.equal((bad.result as { sent: boolean }).sent, false);
  const good = await executeTool("send_checkout", { email: "owner@palmdental.test", plan: "everything_business" }, chat());
  assert.doesNotMatch(JSON.stringify(good.result), /https?:\/\//);
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
  assert.match(bellineVenue.agent.persona, /salesperson/);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
