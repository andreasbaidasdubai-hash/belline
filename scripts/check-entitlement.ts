/**
 * When Belline stops answering a venue — and, more importantly, when it never does.
 *
 * The trial used to be decorative: its days and minutes were written at signup
 * and consulted by nothing on a call path. The half of these tests that
 * matters most is the second half — a paying venue past its allowance, or a
 * trial while card payments are switched off, must keep being answered.
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
const { lapseOf, serviceState } = await import("../src/lib/billing/entitlement");
const { checkEmbedGate } = await import("../src/lib/embed");
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

/** A completed phone call of `minutes`, just ended. */
function phoneCall(venue: () => ReturnType<typeof fresh>, minutes: number, channel: "phone" | "embed" = "phone") {
  const call = startCall(venue(), channel, "+971501234567");
  call.status = "completed";
  call.startedAt = new Date(Date.now() - minutes * 60_000).toISOString();
  call.endedAt = new Date().toISOString();
  saveCall(call);
}

/** `n` website-chat threads Belline replied to just now: one conversation each. */
function chats(venue: () => ReturnType<typeof fresh>, n: number) {
  for (let i = 0; i < n; i++) {
    const call = startCall(venue(), "webchat", "Website");
    const at = new Date(Date.now() - 60_000).toISOString();
    call.transcript = [
      { role: "caller", text: "Hello", at } as never,
      { role: "agent", text: "Hi", at } as never,
    ];
    saveCall(call);
  }
}

console.log("\n\x1b[1mA trial ends\x1b[0m\n");

test("a new trial is answered", () => {
  assert.equal(lapseOf(fresh(), today), null);
  assert.equal(serviceState(fresh(), today, { enforce: true }).answering, true);
});

test("a trial answers on every channel", () => {
  for (const channel of ["phone", "web_voice", "chat", "whatsapp"] as const) {
    assert.equal(serviceState(fresh(), today, { enforce: true, channel }).answering, true, channel);
  }
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

test("thirty voice minutes use up the trial — the voice button counts as well as the phone", () => {
  phoneCall(fresh, 20);
  assert.equal(lapseOf(fresh(), today), null);
  phoneCall(fresh, 10, "embed");
  assert.equal(lapseOf(fresh(), today), "trial_minutes_used");
});

const chatty = await signUp({
  businessName: "Chatty Nails",
  email: "owner@chattynails.test",
  password: "Correct-Horse-Battery-9",
  vertical: "salon",
  timezone: "Asia/Dubai",
});
assert.ok(chatty.ok);
const chattyVenue = () => getLocation(chatty.ok ? chatty.location.id : "")!;

test("fifty text conversations use up the trial's chat, and only its chat — enforced only with card payments on", () => {
  chats(chattyVenue, 49);
  assert.equal(serviceState(chattyVenue(), today, { enforce: true, channel: "chat" }).answering, true);
  chats(chattyVenue, 1);
  const chat = serviceState(chattyVenue(), today, { enforce: true, channel: "chat" });
  assert.equal(chat.answering, false);
  assert.equal(chat.refused, "trial_conversations_used");
  assert.doesNotMatch(chat.callerMessage ?? "", /trial|plan|pay|subscri|charge|AED/i);
  assert.equal(serviceState(chattyVenue(), today, { enforce: true, channel: "phone" }).answering, true, "the phone stopped over chats");
  assert.equal(serviceState(chattyVenue(), today, { channel: "chat" }).answering, true, "stopped with card payments off");
});

test("a trial that began before 2026-10 keeps the cap it was given: phone minutes only, no chat cap", () => {
  const v = chattyVenue();
  upsertLocation({ ...v, subscription: { ...v.subscription!, products: ["everything_starter"], trial: { endsOn: v.subscription!.trial!.endsOn, minutes: 60 } } });
  assert.equal(serviceState(chattyVenue(), today, { enforce: true, channel: "chat" }).answering, true);
  assert.equal(lapseOf(chattyVenue(), today), null);
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
  assert.equal(serviceState(fresh(), today, { enforce: true, channel: "phone" }).answering, true);
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

console.log("\n\x1b[1mWhat each plan answers\x1b[0m\n");

/** A fresh paying venue on this subscription, with the website widget on. */
async function payingOn(name: string, sub: Record<string, unknown>) {
  const created = await signUp({
    businessName: name,
    email: `owner@${name.toLowerCase().replace(/\W+/g, "")}.test`,
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
  });
  assert.ok(created.ok);
  const loc = getLocation(created.ok ? created.location.id : "")!;
  upsertLocation({
    ...loc,
    phone: "+97145550199",
    embed: { enabled: true, key: `k_${loc.id}`, mode: "both", allowedOrigins: ["https://example.test"], maxCallsPerDay: 20, maxCallSeconds: 300 },
    subscription: { market: "AE", cycle: "monthly", startedOn: addDays(today, -3), status: "active", ...sub },
  } as never);
  return () => getLocation(loc.id)!;
}

const busy = await payingOn("Busy Dental", { products: ["v2_starter"] });

test("a plan answers every channel, and opens the website voice button", () => {
  for (const channel of ["phone", "web_voice", "chat", "whatsapp"] as const) {
    assert.equal(serviceState(busy(), today, { enforce: true, channel }).answering, true, channel);
  }
  assert.equal(checkEmbedGate(busy()).allowed, true);
  assert.equal(mayStreamTo(busy()), true);
});

const september = await payingOn("September Spa", { products: ["everything_business"], grandfatheredUntil: addDays(today, -400) });

test("a venue on a September bundle never lapses, even carrying an old end date, and is answered as it was sold", () => {
  assert.equal(lapseOf(september(), addDays(today, 900)), null);
  for (let i = 0; i < 12; i++) phoneCall(september, 60);
  for (const channel of ["phone", "web_voice", "chat", "whatsapp"] as const) {
    assert.equal(serviceState(september(), today, { enforce: true, channel }).answering, true, channel);
  }
});

const pilot = await payingOn("Pilot Clinic", { planId: "business", grandfatheredUntil: addDays(today, 30) });

test("a pilot on the original plan keeps the phone, the voice button and the chat until its date", () => {
  for (const channel of ["phone", "web_voice", "chat"] as const) {
    assert.equal(serviceState(pilot(), today, { enforce: true, channel }).answering, true, channel);
  }
  assert.equal(lapseOf(pilot(), today), null);
});

test("but was never sold WhatsApp, so WhatsApp is not answered — even with card payments off", () => {
  const state = serviceState(pilot(), today, { channel: "whatsapp" });
  assert.equal(state.answering, false);
  assert.equal(state.refused, "not_in_plan");
  assert.doesNotMatch(state.callerMessage ?? "", /trial|plan|pay|subscri/i);
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
