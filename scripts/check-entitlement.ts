/**
 * When Belline stops answering a venue — and, more importantly, when it never does.
 *
 * The trial used to be decorative: fourteen days and thirty minutes were
 * written at signup and consulted by nothing on a call path. The half of these
 * tests that matters most is the second half — a paying venue past its
 * allowance, or a trial while card payments are switched off, must keep
 * being answered.
 *
 *   npm run check:entitlement
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-entitle-"));
delete process.env.STRIPE_SECRET_KEY;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, upsertLocation, saveCall, listLocations } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { freeTierOf, lapseOf, serviceState } = await import("../src/lib/billing/entitlement");
const { checkEmbedGate } = await import("../src/lib/embed");
const { chatGate, messageCeiling } = await import("../src/lib/webchat");
const { mayStreamTo } = await import("../src/lib/voice/entitlement");
const { todayIn } = await import("../src/lib/time");

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

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

seedIfEmpty();

const made = await signUp({
  businessName: "Jumeirah Smile Studio",
  email: "owner@smile.test",
  password: "Correct-Horse-Battery-9",
  vertical: "clinic",
  timezone: "Asia/Dubai",
});
assert.ok(made.ok, "signup failed");
const venueId = made.ok ? made.location.id : "";
const fresh = () => getLocation(venueId)!;
const today = todayIn("Asia/Dubai");

console.log("\n\x1b[1mA trial ends\x1b[0m\n");

test("a new trial is answered", () => {
  assert.equal(lapseOf(fresh(), today), null);
  assert.equal(serviceState(fresh(), today, { enforce: true }).answering, true);
});

test("the day after the trial ends, it has lapsed", () => {
  const after = addDays(fresh().subscription!.trial!.endsOn, 1);
  assert.equal(lapseOf(fresh(), after), "trial_ended");
  const state = serviceState(fresh(), after, { enforce: true });
  assert.equal(state.answering, false);
  assert.match(state.callerMessage ?? "", /Jumeirah Smile Studio/);
  // The caller is a patient, not the account holder. Money is not their business.
  assert.doesNotMatch(state.callerMessage ?? "", /trial|plan|pay|subscri/i);
});

test("the last day of the trial is still answered", () => {
  assert.equal(lapseOf(fresh(), fresh().subscription!.trial!.endsOn), null);
});

test("test-console calls do not use up the trial", () => {
  const call = startCall(fresh(), "browser", "browser-console");
  call.status = "completed";
  call.startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  call.endedAt = new Date().toISOString();
  saveCall(call);
  assert.equal(lapseOf(fresh(), today), null);
});

test("a trial answers on every channel", () => {
  for (const channel of ["phone", "web_voice", "chat", "whatsapp"] as const) {
    assert.equal(serviceState(fresh(), today, { enforce: true, channel }).answering, true, channel);
  }
});

test("sixty live minutes use up the trial", () => {
  const call = startCall(fresh(), "phone", "+971501234567");
  call.status = "completed";
  call.startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  call.endedAt = new Date().toISOString();
  saveCall(call);
  assert.equal(lapseOf(fresh(), today), "trial_minutes_used");
});

console.log("\n\x1b[1mAnd when nothing stops\x1b[0m\n");

test("with card payments off, a lapsed trial keeps answering — and still says it lapsed", () => {
  const state = serviceState(fresh(), today);
  assert.equal(state.answering, true);
  assert.equal(state.lapsed, "trial_minutes_used");
});

test("a paying venue far past its allowance is never stopped", () => {
  const v = fresh();
  upsertLocation({ ...v, subscription: { ...v.subscription!, status: "active", trial: undefined } });
  assert.equal(lapseOf(fresh(), addDays(today, 200)), null);
  assert.equal(serviceState(fresh(), today, { enforce: true }).answering, true);
});

test("a failed card does not stop the phone while Stripe retries", () => {
  const v = fresh();
  upsertLocation({ ...v, subscription: { ...v.subscription!, paymentFailedAt: new Date().toISOString() } });
  assert.equal(serviceState(fresh(), today, { enforce: true }).answering, true);
});

test("a cancelled plan answers to the end of the paid period, then stops", () => {
  const v = fresh();
  const startedOn = addDays(today, -40);
  upsertLocation({
    ...v,
    subscription: { ...v.subscription!, status: "cancelled", startedOn, cancelledAt: `${addDays(today, -1)}T10:00:00Z` },
  });
  assert.equal(lapseOf(fresh(), today), null);
  assert.equal(lapseOf(fresh(), addDays(today, 40)), "cancelled");
});

console.log("\n\x1b[1mA channel the plan does not include\x1b[0m\n");

/** A fresh paying venue on exactly these products. */
async function payingOn(name: string, products: string[], extra: Record<string, unknown> = {}) {
  const made = await signUp({
    businessName: name,
    email: `owner@${name.toLowerCase().replace(/\W+/g, "")}.test`,
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
  });
  assert.ok(made.ok);
  const loc = getLocation(made.ok ? made.location.id : "")!;
  upsertLocation({
    ...loc,
    phone: "+97145550199",
    embed: { enabled: true, key: `k_${loc.id}`, mode: "both", allowedOrigins: ["https://example.test"], maxCallsPerDay: 20 },
    subscription: { products, market: "AE", cycle: "monthly", startedOn: addDays(today, -3), status: "active", ...extra },
  } as never);
  return () => getLocation(loc.id)!;
}

const chatOnly = await payingOn("Chat Only Cafe", ["chat"]);

test("a venue on the chat alone is not answered on the phone — even with card payments off", () => {
  const state = serviceState(chatOnly(), today, { channel: "phone" });
  assert.equal(state.answering, false);
  assert.equal(state.refused, "not_in_plan");
  assert.doesNotMatch(state.callerMessage ?? "", /trial|plan|pay|subscri/i);
  assert.equal(serviceState(chatOnly(), today, { channel: "chat" }).answering, true);
});

test("nor through the website's voice button: the gate refuses and no socket may open", () => {
  assert.equal(serviceState(chatOnly(), today, { channel: "web_voice" }).answering, false);
  assert.equal(checkEmbedGate(chatOnly()).allowed, false);
  assert.equal(mayStreamTo(chatOnly()), false, "a stream token could open a call nobody pays for");
});

test("nor on WhatsApp", () => {
  assert.equal(serviceState(chatOnly(), today, { channel: "whatsapp" }).refused, "not_in_plan");
});

const phoneOnly = await payingOn("Phone Only Dental", ["phone_starter"]);

test("a phone-only venue far past its minutes is still answered on the phone", () => {
  for (let i = 0; i < 5; i++) {
    const call = startCall(phoneOnly(), "phone", "+971501234567");
    call.status = "completed";
    call.startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    call.endedAt = new Date().toISOString();
    saveCall(call);
  }
  assert.equal(serviceState(phoneOnly(), today, { enforce: true, channel: "phone" }).answering, true);
  assert.equal(mayStreamTo(phoneOnly()), false);
});

console.log("\n\x1b[1mThe free chat\x1b[0m\n");

const freeChat = await payingOn("Free Chat Florist", ["chat_free"]);

test("the free chat answers on Haiku, twenty messages to a chat, with the badge", () => {
  assert.deepEqual(freeTierOf(freeChat()), { model: "claude-haiku-4-5", maxMessagesPerChat: 20, badge: true, inboxTakeover: false });
  assert.equal(messageCeiling(freeChat()), 20);
  assert.equal(freeTierOf(chatOnly()), null, "a paid chat was given the free tier's limits");
  assert.equal(freeTierOf(fresh()), null);
});

test("and pauses at its hundredth conversation, where a paid chat would keep going", () => {
  for (let i = 0; i < 100; i++) {
    const thread = startCall(freeChat(), "webchat", "Website");
    thread.transcript = [{ role: "agent", text: "Hello", at: new Date().toISOString() }];
    saveCall(thread);
  }
  const state = serviceState(freeChat(), today, { channel: "chat" });
  assert.equal(state.answering, false);
  assert.equal(state.refused, "free_limit");
  assert.equal(chatGate(freeChat()).allowed, false);
});

console.log("\n\x1b[1mGrandfathered plans\x1b[0m\n");

const pilot = await payingOn("Pilot Clinic", [], { planId: "business", grandfatheredUntil: addDays(today, 30) });

test("a pilot on the old ladder keeps the phone, the voice button and the chat until its date", () => {
  for (const channel of ["phone", "web_voice", "chat"] as const) {
    assert.equal(serviceState(pilot(), today, { enforce: true, channel }).answering, true, channel);
  }
  assert.equal(lapseOf(pilot(), today), null);
});

test("after its date it has lapsed — enforced only once card payments are on", () => {
  const after = addDays(today, 31);
  assert.equal(lapseOf(pilot(), after), "legacy_plan_ended");
  assert.equal(serviceState(pilot(), after, { channel: "phone" }).answering, true);
  assert.equal(serviceState(pilot(), after, { enforce: true, channel: "phone" }).answering, false);
});

test("demo lines and our own venues are never lapsed", () => {
  for (const l of listLocations({ includeInternal: true }).filter((l) => l.demo?.enabled || l.internal)) {
    const expired = {
      ...l,
      subscription: { planId: "starter" as const, cycle: "monthly" as const, startedOn: "2020-01-01", status: "trialing" as const, trial: { endsOn: "2020-01-15", minutes: 30 } },
    };
    assert.equal(lapseOf(expired, today), null, l.name);
  }
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
