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
const { lapseOf, lapseSentence, ownerNotice, serviceState } = await import("../src/lib/billing/entitlement");
const { extendTrialIfPaymentsClosed, paymentsSoonSentence, raiseTrialCapIfPaymentsClosed, sweepTrialEnds, TRIAL_EXTENSION_DAYS } = await import(
  "../src/lib/billing/trial-end"
);
const { stripeEnabled } = await import("../src/lib/billing/stripe");
const { listExceptions } = await import("../src/lib/exceptions");
const { accountFor } = await import("../src/lib/billing/usage");
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
  // Started now and ended `minutes` later, rather than ending now: minutes
  // belong to the day a call started, and back-dating the start put a call
  // made just after midnight in Dubai on the day before the trial began.
  const start = Date.now();
  call.startedAt = new Date(start).toISOString();
  call.endedAt = new Date(start + minutes * 60_000).toISOString();
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

console.log("\n\x1b[1mA trial ends while card payments are closed\x1b[0m\n");

delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.FLAG_BILLING_STRIPE;

async function trialVenue(name: string, email: string) {
  const out = await signUp({ businessName: name, email, password: "Correct-Horse-Battery-9", vertical: "salon", timezone: "Asia/Dubai" });
  assert.ok(out.ok, "signup failed");
  const id = out.ok ? out.location.id : "";
  return { id, get: () => getLocation(id)!, endsOn: getLocation(id)!.subscription!.trial!.endsOn };
}

const closed = await trialVenue("Marina Nails", "owner@marina-nails.test");
const openPay = await trialVenue("Creek Barbers", "owner@creek-barbers.test");
const lateTrial = await trialVenue("Late Lashes", "owner@late-lashes.test");
const tickets = (id: string) => listExceptions({ kind: "stripe_off_trial_end", locationId: id });

test("the day before a trial's last day, nothing is extended or raised", () => {
  const out = extendTrialIfPaymentsClosed(closed.get(), addDays(closed.endsOn, -1), { payments: false });
  assert.equal(out.action, "none");
  assert.equal(closed.get().subscription!.trial!.endsOn, closed.endsOn);
  assert.equal(tickets(closed.id).length, 0);
});

test("on day 14 with payments closed, the trial ends 14 days later and one exception is opened", () => {
  const out = extendTrialIfPaymentsClosed(closed.get(), closed.endsOn, { payments: false });
  assert.equal(out.action, "extended");
  const trial = closed.get().subscription!.trial!;
  assert.equal(TRIAL_EXTENSION_DAYS, 14);
  assert.equal(trial.endsOn, addDays(closed.endsOn, 14));
  assert.equal(trial.extendedFrom, closed.endsOn);
  assert.equal(tickets(closed.id).length, 1);
  assert.equal(tickets(closed.id)[0].count, 1);
});

test("running it again the same day, or the whole sweep, changes nothing more", () => {
  assert.equal(extendTrialIfPaymentsClosed(closed.get(), closed.endsOn, { payments: false }).action, "none");
  sweepTrialEnds();
  assert.equal(closed.get().subscription!.trial!.endsOn, addDays(closed.endsOn, 14));
  assert.equal(tickets(closed.id).length, 1);
  assert.equal(tickets(closed.id)[0].count, 1);
});

test("the owner is told the new date, and never given an email address or a plan they cannot buy", () => {
  const notes = accountFor(closed.get(), closed.endsOn)!.notes;
  const date = new Date(`${addDays(closed.endsOn, 14)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  assert.equal(notes[0], `Payments open soon — you're covered until ${date}.`);
  assert.equal(paymentsSoonSentence(closed.get()), notes[0]);
  for (const line of [...notes, lapseSentence("trial_ended", false), paymentsSoonSentence(undefined)]) {
    assert.doesNotMatch(line, /@|mailto|email us/i, line);
  }
  assert.doesNotMatch(lapseSentence("trial_ended", false), /Choose a plan/);
});

test("past the extension with payments still closed: not extended again, still answered, raised once more that day", () => {
  const ended = addDays(closed.endsOn, 15);
  assert.equal(extendTrialIfPaymentsClosed(closed.get(), ended, { payments: false }).action, "raised");
  assert.equal(extendTrialIfPaymentsClosed(closed.get(), ended, { payments: false }).action, "none");
  assert.equal(closed.get().subscription!.trial!.endsOn, addDays(closed.endsOn, 14), "extended twice");
  assert.equal(tickets(closed.id).length, 1);
  assert.equal(tickets(closed.id)[0].count, 2);
  const state = serviceState(closed.get(), ended);
  assert.equal(state.answering, true);
  assert.equal(state.lapsed, "trial_ended");
});

test("with card payments open, nothing is extended and the ended trial stops", () => {
  assert.equal(extendTrialIfPaymentsClosed(openPay.get(), openPay.endsOn, { payments: true }).action, "none");
  assert.equal(openPay.get().subscription!.trial!.extendedFrom, undefined);
  assert.equal(tickets(openPay.id).length, 0);
  assert.equal(serviceState(openPay.get(), addDays(openPay.endsOn, 1), { enforce: true }).refused, "trial_ended");
});

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

test("fifty text conversations use up the trial's chat and WhatsApp, and only those — with card payments on", () => {
  chats(chattyVenue, 49);
  assert.equal(serviceState(chattyVenue(), today, { enforce: true, channel: "chat" }).answering, true);
  chats(chattyVenue, 1);
  const chat = serviceState(chattyVenue(), today, { enforce: true, channel: "chat" });
  assert.equal(chat.answering, false);
  assert.equal(chat.refused, "trial_conversations_used");
  assert.doesNotMatch(chat.callerMessage ?? "", /trial|plan|pay|subscri|charge|AED/i);
  assert.equal(serviceState(chattyVenue(), today, { enforce: true, channel: "whatsapp" }).refused, "trial_conversations_used");
  assert.equal(serviceState(chattyVenue(), today, { enforce: true, channel: "phone" }).answering, true, "the phone stopped over chats");
});

test("STRIPE OFF: a trial past its conversation cap refuses chat and WhatsApp — a cost cap, not billing", () => {
  assert.equal(stripeEnabled(), false, "this test must run with card payments off");
  for (const channel of ["chat", "whatsapp"] as const) {
    const state = serviceState(chattyVenue(), today, { channel });
    assert.equal(state.answering, false, `${channel} still answered with card payments off`);
    assert.equal(state.refused, "trial_conversations_used", channel);
    assert.doesNotMatch(state.callerMessage ?? "", /trial|plan|pay|subscri|charge|AED/i);
  }
  // An explicit enforce:false governs only the end date, never a cap.
  assert.equal(serviceState(chattyVenue(), today, { enforce: false, channel: "chat" }).answering, false);
  assert.equal(serviceState(chattyVenue(), today, { channel: "phone" }).answering, true, "the phone stopped over chats");
  assert.equal(serviceState(chattyVenue(), today, { channel: "web_voice" }).answering, true, "the voice button stopped over chats");
});

test("STRIPE OFF: the owner is told what stopped and what happens next, with no plan button and no email address", () => {
  const notice = ownerNotice(chattyVenue(), today)!;
  assert.ok(notice, "no notice for a trial whose chat stopped");
  assert.equal(notice.stopped, true);
  assert.equal(notice.choosePlan, false, "a Choose a plan button that cannot be pressed");
  assert.match(notice.sentence, /text conversations are used up/);
  assert.match(notice.sentence, /website chat and WhatsApp/);
  assert.match(notice.sentence, /Belline team has been told/);
  assert.doesNotMatch(notice.sentence, /Choose a plan|@|mailto|email us|keeps answering/i);
});

test("STRIPE OFF: the team is told once a day when a trial cap stops a channel — which is what makes that sentence true", () => {
  const capTickets = () => listExceptions({ kind: "trial_cap_reached", locationId: chattyVenue().id });
  assert.equal(raiseTrialCapIfPaymentsClosed(chattyVenue(), today, { payments: true }), false, "raised with card payments open");
  assert.equal(capTickets().length, 0);
  assert.equal(raiseTrialCapIfPaymentsClosed(chattyVenue(), today, { payments: false }), true);
  assert.equal(raiseTrialCapIfPaymentsClosed(chattyVenue(), today, { payments: false }), false, "raised twice in a day");
  assert.equal(capTickets().length, 1);
  assert.equal(capTickets()[0].count, 1);
  assert.equal(raiseTrialCapIfPaymentsClosed(openPay.get(), today, { payments: false }), false, "raised for a trial inside its caps");
});

test("a trial that began before 2026-10 keeps the cap it was given: phone minutes only, no chat cap", () => {
  const v = chattyVenue();
  upsertLocation({ ...v, subscription: { ...v.subscription!, products: ["everything_starter"], trial: { endsOn: v.subscription!.trial!.endsOn, minutes: 60 } } });
  assert.equal(serviceState(chattyVenue(), today, { enforce: true, channel: "chat" }).answering, true);
  assert.equal(lapseOf(chattyVenue(), today), null);
});

test("STRIPE OFF: a trial past its minute cap refuses the phone and the voice button, and chat still answers", () => {
  assert.equal(stripeEnabled(), false, "this test must run with card payments off");
  for (const channel of ["phone", "web_voice"] as const) {
    const state = serviceState(fresh(), today, { channel });
    assert.equal(state.answering, false, `${channel} still answered with card payments off`);
    assert.equal(state.refused, "trial_minutes_used", channel);
    assert.doesNotMatch(state.callerMessage ?? "", /trial|plan|pay|subscri|charge|AED/i);
  }
  assert.equal(serviceState(fresh(), today, { enforce: false, channel: "phone" }).answering, false, "enforce:false switched a cap off");
  assert.equal(serviceState(fresh(), today, { channel: "chat" }).answering, true, "chat stopped over minutes");
  // With payments open, the end date still stops chat of a trial whose minutes went first.
  const past = addDays(fresh().subscription!.trial!.endsOn, 1);
  assert.equal(serviceState(fresh(), past, { enforce: true, channel: "chat" }).refused, "trial_ended");
  const v = fresh();
  upsertLocation({ ...v, embed: { enabled: true, key: `k_${v.id}`, mode: "both", allowedOrigins: ["https://example.test"], maxCallsPerDay: 20, maxCallSeconds: 300 } } as never);
  const gate = checkEmbedGate(fresh());
  assert.equal(gate.allowed, false, "the voice button still opened");
  assert.doesNotMatch(gate.message ?? "", /trial|plan|pay|subscri|charge|AED/i);
  const said = lapseSentence("trial_minutes_used", true);
  assert.match(said, /voice minutes are used up/);
  assert.match(said, /Belline team has been told/);
  assert.doesNotMatch(said, /Choose a plan|@|mailto|keeps answering/i);
  const notice = ownerNotice(fresh(), today)!;
  assert.equal(notice.choosePlan, false);
  assert.equal(notice.stopped, true);
});

test("STRIPE OFF: a trial past its end date but inside its caps still answers on every channel", () => {
  const out = lateTrial;
  const after = addDays(out.endsOn, 60);
  const v = out.get();
  // Past even the one extension: nothing about the date stops it.
  upsertLocation({ ...v, subscription: { ...v.subscription!, trial: { ...v.subscription!.trial!, endsOn: out.endsOn, extendedFrom: addDays(out.endsOn, -14) } } });
  assert.equal(lapseOf(out.get(), after), "trial_ended");
  for (const channel of ["phone", "web_voice", "chat", "whatsapp"] as const) {
    assert.equal(serviceState(out.get(), after, { channel }).answering, true, channel);
  }
  const notice = ownerNotice(out.get(), after)!;
  assert.equal(notice.stopped, false);
  assert.equal(notice.choosePlan, false);
  assert.doesNotMatch(notice.sentence, /Choose a plan/);
  assert.match(notice.sentence, /voice minutes or text conversations/);
});

console.log("\n\x1b[1mAnd when nothing stops\x1b[0m\n");

test("with card payments off, a lapsed trial still says it lapsed", () => {
  const state = serviceState(fresh(), today);
  assert.equal(state.answering, false);
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

test("STRIPE OFF: Belline's own line and the three demo lines keep answering on every channel, however far past any trial cap", () => {
  assert.equal(stripeEnabled(), false);
  for (const id of ["loc_belline", "loc_azure", "loc_lumiere", "loc_meridian"]) {
    const stored = getLocation(id);
    assert.ok(stored, `${id} is not seeded`);
    // The worst case: a pooled trial that ended long ago, with its minutes and
    // conversations used many times over.
    upsertLocation({
      ...stored,
      subscription: {
        products: ["v2_starter"],
        market: "AE",
        cycle: "monthly",
        startedOn: addDays(today, -40),
        status: "trialing",
        trial: { endsOn: addDays(today, -20), minutes: 30, conversations: 50 },
      },
    } as never);
    const venue = () => getLocation(id)!;
    phoneCall(venue, 90);
    chats(venue, 120);
    assert.equal(lapseOf(venue(), today), null, id);
    for (const channel of ["phone", "web_voice", "chat", "whatsapp"] as const) {
      const state = serviceState(venue(), today, { channel });
      assert.equal(state.answering, true, `${id} stopped on ${channel}`);
      assert.equal(serviceState(venue(), today, { enforce: true, channel }).answering, true, `${id} stopped on ${channel} with payments on`);
    }
    assert.equal(ownerNotice(venue(), today), null, id);
    assert.equal(raiseTrialCapIfPaymentsClosed(venue(), today, { payments: false }), false, id);
  }
  assert.equal(mayStreamTo(getLocation("loc_belline")!), true, "the website's Speak to Belline was refused");
});

console.log("\n\x1b[1mA paid plan that chose packs, while card payments are closed\x1b[0m\n");

const { applyUsagePolicy, decide: decidePolicy } = await import("../src/lib/billing/usage-policy");
const { raisePacksHeldIfPaymentsClosed } = await import("../src/lib/billing/trial-end");
const { packsHeld } = await import("../src/lib/billing/entitlement");

/** A venue on a paid 2026-10 plan, owner chose "add a pack automatically", voice minutes used past the allowance. */
async function packsVenue(name: string, email: string) {
  const out = await signUp({ businessName: name, email, password: "Correct-Horse-Battery-9", vertical: "salon", timezone: "Asia/Dubai" });
  assert.ok(out.ok, "signup failed");
  const id = out.ok ? out.location.id : "";
  upsertLocation({
    ...getLocation(id)!,
    phone: "+97145550188",
    subscription: {
      products: ["v2_starter"],
      market: "AE",
      cycle: "monthly",
      startedOn: addDays(today, -2),
      status: "active",
      usagePolicy: { mode: "packs", chosenAt: new Date().toISOString(), chosenBy: "usr_owner" },
    },
  } as never);
  const get = () => getLocation(id)!;
  phoneCall(get, 90);
  return get;
}

const packsOff = await packsVenue("Palm Brows", "owner@palm-brows.test");

test("PAYMENTS OFF: packs policy at 100% refuses the pool's channels and adds no pack", () => {
  assert.equal(stripeEnabled(), false, "this test must run with card payments off");
  for (const channel of ["phone", "web_voice"] as const) {
    const state = serviceState(packsOff(), today, { channel });
    assert.equal(state.answering, false, `${channel} kept answering on a pack nobody can be charged for`);
    assert.equal(state.refused, "allowance_exhausted", channel);
    assert.doesNotMatch(state.callerMessage ?? "", /trial|plan|pay|subscri|charge|AED|pack/i);
  }
  assert.equal(serviceState(packsOff(), today, { channel: "chat" }).answering, true, "chat stopped over voice minutes");
  applyUsagePolicy(packsOff(), today, { stripe: false });
  assert.equal(packsOff().subscription!.packs, undefined, "a pack was added with card payments off");
  assert.deepEqual(packsHeld(packsOff(), today), ["minutes"]);
});

test("PAYMENTS OFF: the owner is told why, with no plan or pack button, and that the team has been told", () => {
  const notice = ownerNotice(packsOff(), today);
  assert.ok(notice, "no notice for a paid pool that stopped");
  assert.equal(notice.stopped, true);
  assert.equal(notice.choosePlan, false, "a Choose a plan button that cannot be pressed");
  assert.match(notice.sentence, /voice minutes are used up/);
  assert.match(notice.sentence, /card payments are not open yet, so no pack can be added/);
  assert.match(notice.sentence, /Belline has stopped answering on/);
  assert.match(notice.sentence, /Belline team has been told/);
  assert.doesNotMatch(notice.sentence, /Choose a plan|buy a pack|@|mailto|keeps answering/i);
});

test("PAYMENTS OFF: a ticket is raised for the team once a day per pool, like trial_cap_reached", () => {
  const tickets = () => listExceptions({ kind: "packs_held_payments_off", locationId: packsOff().id });
  assert.equal(raisePacksHeldIfPaymentsClosed(packsOff(), today, { payments: true }), false, "raised with card payments open");
  assert.equal(tickets().length, 0);
  assert.equal(raisePacksHeldIfPaymentsClosed(packsOff(), today, { payments: false }), true);
  assert.equal(raisePacksHeldIfPaymentsClosed(packsOff(), today, { payments: false }), false, "raised twice in a day");
  assert.equal(tickets().length, 1);
  assert.equal(tickets()[0].count, 1);
  assert.equal(tickets()[0].context.pool, "minutes");
  // The sweep reaches it too, and does not add to the day's row.
  sweepTrialEnds();
  assert.equal(tickets().length, 1);
  assert.equal(tickets()[0].count, 1);
  // A venue on packs still inside its allowance raises nothing.
  assert.equal(raisePacksHeldIfPaymentsClosed(fresh(), today, { payments: false }), false);
  assert.equal(packsOff().subscription!.packs, undefined);
});

test("PAYMENTS ON: the same venue gets its pack as before, and nothing is held or raised", () => {
  const d = decidePolicy(packsOff(), today, { stripe: true });
  assert.equal(d.packs.length, 1, "no pack with card payments open");
  assert.equal(d.pools.minutes.action, "pack_added");
  assert.equal(d.pools.minutes.exhausted, false);
  assert.deepEqual(packsHeld(packsOff(), today, { payments: true }), []);
  const applied = applyUsagePolicy(packsOff(), today, { stripe: true });
  assert.equal(applied.added.length, 1);
  assert.equal(applied.added[0].pending, undefined);
  assert.equal(decidePolicy(packsOff(), today, { stripe: true }).pools.minutes.exhausted, false);
});

// Each exempt kind of venue, set up exactly like Palm Brows (packs, minutes past the allowance).
const packsProspect = await packsVenue("Prospect Brows", "owner@prospect-brows.test");
upsertLocation({ ...packsProspect(), prospect: { id: "prs_test" } } as never);
const packsInternal = await packsVenue("Internal Brows", "owner@internal-brows.test");
upsertLocation({ ...packsInternal(), internal: true } as never);
const packsDemo = await packsVenue("Demo Brows", "owner@demo-brows.test");
upsertLocation({ ...packsDemo(), demo: { ...(getLocation("loc_azure")!.demo ?? {}), enabled: true } } as never);
for (const id of ["loc_belline", "loc_azure"]) {
  upsertLocation({
    ...getLocation(id)!,
    subscription: {
      products: ["v2_starter"],
      market: "AE",
      cycle: "monthly",
      startedOn: addDays(today, -2),
      status: "active",
      usagePolicy: { mode: "packs", chosenAt: new Date().toISOString(), chosenBy: "usr_owner" },
    },
  } as never);
  phoneCall(() => getLocation(id)!, 200);
}

test("PAYMENTS OFF: internal, demo and prospect venues on packs are never held, stopped or ticketed", () => {
  const venues: Array<[string, () => ReturnType<typeof fresh>]> = [
    ["prospect", packsProspect],
    ["internal venue", packsInternal],
    ["demo", packsDemo],
    ["loc_belline", () => getLocation("loc_belline")!],
    ["loc_azure", () => getLocation("loc_azure")!],
  ];
  for (const [label, venue] of venues) {
    assert.deepEqual(packsHeld(venue(), today), [], label);
    for (const channel of ["phone", "web_voice"] as const) {
      assert.equal(serviceState(venue(), today, { channel }).answering, true, `${label} stopped on ${channel}`);
    }
    assert.equal(ownerNotice(venue(), today), null, label);
    assert.equal(raisePacksHeldIfPaymentsClosed(venue(), today, { payments: false }), false, label);
    assert.equal(listExceptions({ kind: "packs_held_payments_off", locationId: venue().id }).length, 0, label);
    assert.equal(venue().subscription!.packs, undefined, `${label} got a pack`);
  }
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
