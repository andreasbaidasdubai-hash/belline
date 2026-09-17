/**
 * What happens at 100% of an allowance — and that nothing is ever charged the
 * owner did not choose.
 *
 * The owner picks one of three: add a pack automatically (up to an optional
 * monthly cap), move up to the next plan, or stop at the allowance. Until they
 * pick, it behaves as a stop, and says "choose what happens at 100%". Alerts
 * go at 70%, 90% and 100%, once per unit per period. Stopping at an allowance
 * is enforced whether or not card payments are on: it is cost protection, not
 * billing. Only date-based lapses wait for card payments.
 *
 *   npm run check:usage-policy
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-policy-"));
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FLAG_BILLING_STRIPE;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { createUser } = await import("../src/lib/auth");
const { getLocation, upsertLocation, saveCall } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { PACKS, formatMoneyFor } = await import("../src/lib/billing/plans").then((m) => ({ ...m, formatMoneyFor: m.money }));
const { accountFor } = await import("../src/lib/billing/usage");
const { serviceState } = await import("../src/lib/billing/entitlement");
const policy = await import("../src/lib/billing/usage-policy");
const { stripeEnabled } = await import("../src/lib/billing/stripe");
const speak = await import("../src/lib/billing/speak");
const { renderPricing } = await import("./site-pricing");

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

const PERIOD = "2026-11-01";
const TODAY = "2026-11-10";
const MONEY = /AED|dirham|\bpay|charge|bill|plan|subscri|trial|pack/i;

let n = 0;
/** A paying v2 venue, its owner, and a way to read it back fresh. */
async function venue(sub: Record<string, unknown> = {}) {
  n++;
  const signed = await signUp({
    businessName: `Policy Venue ${n}`,
    email: `owner${n}@policy.test`,
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
  });
  assert.ok(signed.ok, "signup failed");
  const { location, user } = signed as Extract<typeof signed, { ok: true }>;
  upsertLocation({
    ...getLocation(location.id)!,
    businessPhone: "+97145550100",
    subscription: { products: ["v2_starter"], market: "AE", cycle: "monthly", startedOn: PERIOD, status: "active", ...sub },
  } as never);
  return { id: location.id, owner: user, fresh: () => getLocation(location.id)! };
}

/** `minutes` of completed phone calls on a day inside the period, one minute each. */
function talk(locationId: string, minutes: number, channel: "phone" | "embed" = "phone") {
  for (let i = 0; i < minutes; i++) {
    const c = startCall(getLocation(locationId)!, channel, "+971501234567");
    const start = new Date("2026-11-05T12:00:00Z");
    saveCall({ ...c, channel, startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 60_000).toISOString(), status: "completed" });
  }
}

/** `count` website-chat conversations inside the period. */
function chats(locationId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const c = startCall(getLocation(locationId)!, "webchat", "Website");
    const at = "2026-11-05T12:00:00.000Z";
    saveCall({ ...c, channel: "webchat", startedAt: at, status: "active", transcript: [{ role: "agent", text: "Hi", at }] } as never);
  }
}

const decide = (v: { fresh: () => ReturnType<typeof getLocation> }, stripe = false) =>
  policy.decide(v.fresh()!, TODAY, { stripe });
/** Apply, and mark any alert sent as if the email went. The pending path has its own tests below. */
const apply = (v: { id: string; fresh: () => ReturnType<typeof getLocation> }, stripe = false) => {
  const out = policy.applyUsagePolicy(v.fresh()!, TODAY, { stripe });
  if (out.alerts.length) policy.markAlertsSent(v.id, out.decision.periodStart, out.alerts);
  return out;
};

console.log("\n\x1b[1mAlerts at 70%, 90% and 100%\x1b[0m\n");

await test("nothing below 70%, then 70% once, then 90%, then 100% — each once per unit per period", async () => {
  const v = await venue();
  talk(v.id, 52); // 69% of 75
  assert.deepEqual(decide(v).alerts, []);
  talk(v.id, 1); // 70.7%
  assert.deepEqual(decide(v).alerts, [{ pool: "minutes", threshold: 70 }]);
  apply(v);
  assert.deepEqual(decide(v).alerts, [], "the 70% alert was due twice");
  assert.deepEqual(v.fresh().subscription!.alerts, { periodStart: PERIOD, sent: { minutes: [70] } });
  talk(v.id, 15); // 90.7%
  assert.deepEqual(decide(v).alerts, [{ pool: "minutes", threshold: 90 }]);
  apply(v);
  talk(v.id, 7); // 100%
  assert.deepEqual(decide(v).alerts, [{ pool: "minutes", threshold: 100 }]);
  apply(v);
  assert.deepEqual(decide(v).alerts, []);
});

await test("a jump straight past two thresholds sends both, once", async () => {
  const v = await venue();
  talk(v.id, 70); // 93%
  assert.deepEqual(decide(v).alerts, [{ pool: "minutes", threshold: 70 }, { pool: "minutes", threshold: 90 }]);
  apply(v);
  assert.deepEqual(decide(v).alerts, []);
});

await test("the two units are alerted separately, and a new period starts the count again", async () => {
  const v = await venue();
  chats(v.id, 140); // 70% of 200
  assert.deepEqual(decide(v).alerts, [{ pool: "conversations", threshold: 70 }]);
  apply(v);
  const next = policy.decide(v.fresh(), "2026-12-02", { stripe: false });
  assert.deepEqual(next.alerts, [], "last period's usage alerted in the new one");
  const sub = v.fresh().subscription!;
  upsertLocation({ ...v.fresh(), subscription: { ...sub, alerts: { periodStart: "2026-10-01", sent: { conversations: [70] } } } });
  assert.deepEqual(decide(v).alerts, [{ pool: "conversations", threshold: 70 }], "an old period's record suppressed this one's alert");
});

console.log("\n\x1b[1mNo policy chosen yet\x1b[0m\n");

await test("behaves as a stop at 100%, adds nothing, and asks the owner to choose", async () => {
  const v = await venue();
  talk(v.id, 300);
  const d = decide(v);
  assert.equal(d.pools.minutes.exhausted, true);
  assert.equal(d.pools.minutes.action, "choose_policy");
  assert.deepEqual(d.packs, []);
  apply(v);
  assert.equal(v.fresh().subscription!.packs, undefined, "a pack was added without a chosen policy");
  assert.match(accountFor(v.fresh(), TODAY)!.notes.join(" "), /Choose what happens at 100%/);
});

await test("stops that unit whether or not card payments are on — a cost cap — and never tells the caller about money", async () => {
  const v = await venue();
  talk(v.id, 75);
  const phone = serviceState(v.fresh(), TODAY, { enforce: true, channel: "phone" });
  assert.equal(phone.answering, false);
  assert.equal(phone.refused, "allowance_exhausted");
  assert.doesNotMatch(phone.callerMessage ?? "", MONEY);
  const bell = serviceState(v.fresh(), TODAY, { enforce: true, channel: "web_voice" });
  assert.equal(bell.refused, "allowance_exhausted", "voice minutes are pooled: the voice button shares the stop");
  assert.equal(serviceState(v.fresh(), TODAY, { enforce: true, channel: "chat" }).answering, true, "chat stopped over minutes");
  assert.equal(serviceState(v.fresh(), TODAY, { channel: "phone" }).refused, "allowance_exhausted", "kept answering with card payments off");
  assert.equal(serviceState(v.fresh(), TODAY, { enforce: false, channel: "phone" }).refused, "allowance_exhausted", "enforce:false switched a cap off");
  assert.match(accountFor(v.fresh(), TODAY)!.notes.join(" "), /Belline has stopped answering/);
  assert.doesNotMatch(accountFor(v.fresh(), TODAY)!.notes.join(" "), /nothing has stopped/i);
});

await test("STRIPE OFF: a trial past its minute cap refuses voice, past its conversation cap refuses chat and WhatsApp", async () => {
  const v = await venue({ status: "trialing", trial: { endsOn: "2026-11-30", minutes: 30, conversations: 50 } });
  talk(v.id, 30);
  for (const channel of ["phone", "web_voice"] as const) {
    assert.equal(serviceState(v.fresh(), TODAY, { channel }).refused, "trial_minutes_used", channel);
  }
  assert.equal(serviceState(v.fresh(), TODAY, { channel: "chat" }).answering, true);
  chats(v.id, 50);
  for (const channel of ["chat", "whatsapp"] as const) {
    assert.equal(serviceState(v.fresh(), TODAY, { channel }).refused, "trial_conversations_used", channel);
  }
  assert.match(accountFor(v.fresh(), TODAY)!.notes.join(" "), /Belline has stopped answering/);
  assert.doesNotMatch(accountFor(v.fresh(), TODAY)!.notes.join(" "), /choose a plan/i, "a plan offered with card payments closed");
});

console.log("\n\x1b[1mCap\x1b[0m\n");

await test("a hard stop for the unit at 100%, nothing added", async () => {
  const v = await venue({ usagePolicy: { mode: "cap", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  chats(v.id, 200);
  const d = decide(v);
  assert.equal(d.pools.conversations.exhausted, true);
  assert.equal(d.pools.conversations.action, "cap_reached");
  assert.equal(d.pools.minutes.exhausted, false);
  assert.deepEqual(d.packs, []);
  assert.equal(serviceState(v.fresh(), TODAY, { enforce: true, channel: "chat" }).refused, "allowance_exhausted");
  assert.equal(serviceState(v.fresh(), TODAY, { enforce: true, channel: "phone" }).answering, true);
});

console.log("\n\x1b[1mUpgrade\x1b[0m\n");

await test("recommends the next plan, and behaves as a stop until the owner confirms it", async () => {
  const v = await venue({ usagePolicy: { mode: "upgrade", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  talk(v.id, 80);
  const d = decide(v);
  assert.equal(d.pools.minutes.action, "upgrade_recommended");
  assert.equal(d.pools.minutes.exhausted, true);
  assert.equal(d.pools.minutes.upgradeTo, "v2_growth");
  assert.deepEqual(d.packs, []);
  apply(v);
  assert.deepEqual(v.fresh().subscription!.products, ["v2_starter"], "the plan was changed without the owner confirming");
  assert.equal(serviceState(v.fresh(), TODAY, { enforce: true, channel: "phone" }).refused, "allowance_exhausted");
});

console.log("\n\x1b[1mPacks\x1b[0m\n");

await test("PAYMENTS ON: at 100% a pack is added with an idempotent key, and the unit keeps going", async () => {
  const v = await venue({ usagePolicy: { mode: "packs", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  talk(v.id, 75);
  const d = decide(v, true);
  assert.equal(d.packs.length, 1);
  assert.equal(d.packs[0].key, `${v.id}:${PERIOD}:minutes:1`);
  assert.equal(d.packs[0].units, 100);
  assert.equal(d.packs[0].priceMinor, PACKS.find((p) => p.pool === "minutes")!.prices.AE);
  assert.equal(d.pools.minutes.packsHeld, undefined);
  apply(v, true);
  apply(v, true);
  assert.equal(v.fresh().subscription!.packs!.length, 1, "applying twice added two packs");
  const after = decide(v, true);
  assert.equal(after.pools.minutes.exhausted, false);
  assert.equal(after.pools.minutes.allowance, 175);
  assert.equal(serviceState(v.fresh(), TODAY, { enforce: true, channel: "phone" }).answering, true);
  talk(v.id, 100);
  assert.equal(decide(v, true).packs[0].key, `${v.id}:${PERIOD}:minutes:2`);
});

await test("PAYMENTS OFF: a packs policy at 100% adds no pack, ever, and the pool stops exactly as a cap does", async () => {
  assert.equal(stripeEnabled(), false, "this test must run with card payments off");
  const v = await venue({ usagePolicy: { mode: "packs", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  const capped = await venue({ usagePolicy: { mode: "cap", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  chats(v.id, 200);
  chats(capped.id, 200);
  const d = decide(v, false);
  assert.deepEqual(d.packs, [], "a pack was decided that nobody can be charged for");
  assert.equal(d.pools.conversations.exhausted, true);
  assert.equal(d.pools.conversations.action, "cap_reached");
  assert.equal(d.pools.conversations.packsHeld, true);
  assert.equal(d.pools.minutes.exhausted, false);
  assert.equal(d.pools.minutes.packsHeld, undefined, "a pool inside its allowance was marked held");
  const cap = decide(capped, false);
  assert.deepEqual(
    { exhausted: d.pools.conversations.exhausted, action: d.pools.conversations.action, allowance: d.pools.conversations.allowance },
    { exhausted: cap.pools.conversations.exhausted, action: cap.pools.conversations.action, allowance: cap.pools.conversations.allowance },
    "packs with payments off did not stop the way cap does",
  );
  assert.deepEqual(policy.packsHeldPools(v.fresh(), TODAY, { stripe: false }), ["conversations"]);
  // Every path that could add one: applying, and a live conversation arriving (which applies first).
  apply(v, false);
  apply(v, false);
  const state = serviceState(v.fresh(), TODAY, { channel: "chat" });
  assert.equal(state.answering, false, "chat kept answering past the allowance");
  assert.equal(state.refused, "allowance_exhausted");
  assert.doesNotMatch(state.callerMessage ?? "", MONEY);
  chats(v.id, 500);
  serviceState(v.fresh(), TODAY, { channel: "chat" });
  assert.equal(v.fresh().subscription!.packs, undefined, "a pack was recorded with card payments off");
  assert.equal(serviceState(v.fresh(), TODAY, { channel: "phone" }).answering, true, "the phone stopped over conversations");
  // A spending cap with room in it changes nothing while payments are closed.
  const roomy = await venue({ usagePolicy: { mode: "packs", monthlyCapMinor: 100000, chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  talk(roomy.id, 75);
  apply(roomy, false);
  assert.equal(roomy.fresh().subscription!.packs, undefined);
  assert.equal(serviceState(roomy.fresh(), TODAY, { channel: "phone" }).refused, "allowance_exhausted");
});

await test("PAYMENTS OFF: the billing page says honestly why no pack was added, with no pack or plan to buy", async () => {
  const v = await venue({ usagePolicy: { mode: "packs", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  talk(v.id, 75);
  apply(v, false);
  const notes = accountFor(v.fresh(), TODAY)!.notes.join(" ");
  assert.match(notes, /card payments are not open yet, so no pack can be added/);
  assert.match(notes, /Belline has stopped answering/);
  assert.match(notes, /Belline team has been told/);
  assert.doesNotMatch(notes, /is added on the next|buy a pack|choose a plan|Added .* not charged/i);
});

await test("PAYMENTS ON: the same venue that was held gets its pack as before, recorded to be invoiced", async () => {
  const v = await venue({ usagePolicy: { mode: "packs", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  chats(v.id, 200);
  assert.deepEqual(decide(v, false).packs, []);
  const on = decide(v, true);
  assert.equal(on.packs.length, 1);
  assert.equal(on.pools.conversations.action, "pack_added");
  assert.equal(on.pools.conversations.exhausted, false);
  assert.deepEqual(policy.packsHeldPools(v.fresh(), TODAY, { stripe: true }), []);
  apply(v, true);
  const [pack] = v.fresh().subscription!.packs!;
  assert.equal(pack.pool, "conversations");
  assert.equal(pack.pending, undefined, "a pack added with payments on was marked uncharged");
});

await test("with card payments on, a pack is recorded to be invoiced — the invoice item itself is Stripe's job, not this check's", async () => {
  const v = await venue({ usagePolicy: { mode: "packs", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  talk(v.id, 75);
  apply(v, true);
  const [pack] = v.fresh().subscription!.packs!;
  assert.equal(pack.pending, undefined);
  assert.equal(pack.invoiceItemId, undefined);
});

await test("the monthly spending cap stops packs, and then the unit stops like a cap", async () => {
  const v = await venue({ usagePolicy: { mode: "packs", monthlyCapMinor: 15000, chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  talk(v.id, 75);
  apply(v, true);
  assert.equal(v.fresh().subscription!.packs!.length, 1);
  talk(v.id, 100); // the second minutes pack (AED 99) would take the month to AED 198
  const d = decide(v, true);
  assert.deepEqual(d.packs, []);
  assert.equal(d.pools.minutes.exhausted, true);
  assert.equal(d.pools.minutes.action, "cap_reached");
  assert.equal(serviceState(v.fresh(), TODAY, { enforce: true, channel: "phone" }).refused, "allowance_exhausted");
});

await test("the cap counts every pack this period, across both units", async () => {
  const v = await venue({ usagePolicy: { mode: "packs", monthlyCapMinor: 15000, chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  talk(v.id, 75);
  chats(v.id, 200);
  const d = decide(v, true);
  assert.deepEqual(d.packs.map((p) => p.pool).sort(), ["conversations", "minutes"], "AED 99 + AED 49 fits under AED 150");
  talk(v.id, 100);
  apply(v, true);
  assert.equal(v.fresh().subscription!.packs!.length, 2);
});

await test("packs from a previous period neither count against this month's cap nor extend this month's allowance", async () => {
  const v = await venue({ usagePolicy: { mode: "packs", monthlyCapMinor: 9900, chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  const sub = v.fresh().subscription!;
  upsertLocation({
    ...v.fresh(),
    subscription: { ...sub, packs: [{ periodStart: "2026-10-01", pool: "minutes", units: 100, priceMinor: 9900, key: `${v.id}:2026-10-01:minutes:1`, at: "2026-10-20T00:00:00Z" }] },
  });
  talk(v.id, 75);
  const d = decide(v, true);
  assert.equal(d.pools.minutes.packUnits, 0, "last period's pack extended this period");
  assert.equal(d.pools.minutes.base, 75);
  assert.equal(d.packs.length, 1, "last period's pack used up this month's cap");
  assert.equal(d.pools.minutes.allowance, 175, "the allowance after this decision is the plan plus the one new pack");
});

console.log("\n\x1b[1mNothing charged without a choice\x1b[0m\n");

await test("far past every allowance with no policy, no pack is ever recorded", async () => {
  const v = await venue();
  talk(v.id, 400);
  chats(v.id, 900);
  apply(v, true);
  apply(v, true);
  assert.equal(v.fresh().subscription!.packs, undefined);
});

await test("the policy leaves older products and trials alone: a September bundle is answered as sold", async () => {
  const v = await venue({ products: ["everything_starter"], usagePolicy: { mode: "cap", chosenAt: "2026-11-01T09:00:00Z", chosenBy: "usr_x" } });
  talk(v.id, 400);
  const d = decide(v);
  assert.equal(d.applies, false);
  assert.equal(serviceState(v.fresh(), TODAY, { enforce: true, channel: "phone" }).answering, true);
});

console.log("\n\x1b[1mOnly the owner chooses\x1b[0m\n");

const home = await venue();
const other = await venue();
const staff = createUser({
  email: "staff@policy.test",
  name: "Staff",
  password: "Correct-Horse-Battery-9",
  role: "staff",
  tenantId: home.owner.tenantId,
  locationIds: [home.id],
});
assert.ok(staff.ok);

await test("refused: nobody signed in, a member of staff, and an owner of another business", () => {
  const body = { locationId: home.id, mode: "packs" };
  assert.equal(policy.setUsagePolicyRequest(null, body).status, 401);
  assert.equal(policy.setUsagePolicyRequest(staff.ok ? staff.user : null, body).status, 403);
  const foreign = policy.setUsagePolicyRequest(other.owner, body);
  assert.equal(foreign.status, 404);
  assert.equal(home.fresh().subscription!.usagePolicy, undefined, "someone else's request changed the policy");
});

await test("refused: a mode that does not exist, and a cap that is not a whole, non-negative number of dirhams", () => {
  for (const body of [
    { locationId: home.id, mode: "unlimited" },
    { locationId: home.id, mode: "packs", monthlyCapAed: -5 },
    { locationId: home.id, mode: "packs", monthlyCapAed: 12.5 },
    { locationId: home.id, mode: "packs", monthlyCapAed: "lots" },
  ]) {
    assert.equal(policy.setUsagePolicyRequest(home.owner, body).status, 400, JSON.stringify(body));
  }
});

await test("the owner sets it: the choice, the cap in fils, who chose and when", () => {
  const res = policy.setUsagePolicyRequest(home.owner, { locationId: home.id, mode: "packs", monthlyCapAed: 300 }, new Date("2026-11-03T08:00:00Z"));
  assert.equal(res.status, 200);
  assert.deepEqual(home.fresh().subscription!.usagePolicy, {
    mode: "packs",
    monthlyCapMinor: 30000,
    chosenAt: "2026-11-03T08:00:00.000Z",
    chosenBy: home.owner.id,
  });
  const cap = policy.setUsagePolicyRequest(home.owner, { locationId: home.id, mode: "cap" });
  assert.equal(cap.status, 200);
  assert.equal(home.fresh().subscription!.usagePolicy!.mode, "cap");
  assert.equal(home.fresh().subscription!.usagePolicy!.monthlyCapMinor, undefined, "a spending cap survived a switch away from packs");
});

console.log("\n\x1b[1mOne set of sentences\x1b[0m\n");

await test("the over-limit sentence names the three choices, the alerts, the pack prices, and what is never done", () => {
  const s = speak.overLimitSentence();
  for (const pack of PACKS) assert.ok(s.includes(formatMoneyFor(pack.prices.AE!, "AE")), `${pack.name} price missing`);
  assert.match(s, /70%, 90% and 100%/);
  assert.match(s, /upgrade|move up/i);
  assert.match(s, /stop/i);
  assert.match(s, /Nothing is added to your bill unless you chose it/);
  assert.doesNotMatch(s, /keeps answering|no per-minute|unlimited/i);
});

await test("packs, trial and volume sentences are read from the catalogue", () => {
  assert.equal(speak.packsSentence(), "100 extra voice minutes for AED 99, or 150 extra text conversations for AED 49.");
  assert.match(speak.trialSentence(), /30 days free: 30 voice minutes and 50 text conversations/);
  // A trial answers every channel (entitlement.channelIncluded), WhatsApp too.
  assert.match(speak.trialSentence(), /your website chat and WhatsApp all switched on/);
  assert.match(speak.volumeSentence(), /separate subscription/);
  assert.match(speak.volumeSentence(), /5 to 19 locations: 10% off/);
  assert.match(speak.volumeSentence(), /20 or more/);
});

console.log("\n\x1b[1mAn alert is sent only when the email went\x1b[0m\n");

delete process.env.RESEND_API_KEY;
delete process.env.FLAG_EMAIL_TRANSACTIONAL;
const PENDING_NOTE = /could not email you about your usage/;

const quiet = await venue();
talk(quiet.id, 53); // 70.7% of 75

await test("a raised alert is recorded as pending, not sent, and is not raised again meanwhile", () => {
  const out = policy.applyUsagePolicy(quiet.fresh(), TODAY, { stripe: false });
  assert.deepEqual(out.alerts, [{ pool: "minutes", threshold: 70 }]);
  const record = quiet.fresh().subscription!.alerts!;
  assert.deepEqual(record.sent, {}, "marked sent before any email was tried");
  assert.deepEqual(record.pending, { minutes: [70] });
  assert.ok(record.pendingSince);
  assert.deepEqual(decide(quiet).alerts, [], "a pending alert was raised a second time");
});

await test("with email off the alert is not delivered, stays pending, and the billing page says so", async () => {
  const delivered = await policy.notifyAlerts(quiet.fresh(), [{ pool: "minutes", threshold: 70 }]);
  assert.equal(delivered, false);
  assert.deepEqual(quiet.fresh().subscription!.alerts!.pending, { minutes: [70] });
  assert.ok(accountFor(quiet.fresh(), TODAY)!.notes.some((n) => PENDING_NOTE.test(n)), "no pending note on the page");
});

await test("the sweep retries: a failure keeps it pending, a success marks it sent once and clears the note", async () => {
  await policy.retryPendingAlerts(async () => false, { today: TODAY });
  assert.deepEqual(quiet.fresh().subscription!.alerts!.pending, { minutes: [70] });

  const tried: string[] = [];
  const ok = async (loc: { id: string }) => {
    tried.push(loc.id);
    return true;
  };
  await policy.retryPendingAlerts(ok, { today: TODAY });
  assert.deepEqual(quiet.fresh().subscription!.alerts, { periodStart: PERIOD, sent: { minutes: [70] } });
  assert.ok(!accountFor(quiet.fresh(), TODAY)!.notes.some((n) => PENDING_NOTE.test(n)), "the note outlived the email");
  tried.length = 0;
  await policy.retryPendingAlerts(ok, { today: TODAY });
  assert.ok(!tried.includes(quiet.id), "a sent alert was sent again");
});

await test("a call that raises an alert with email off leaves it pending", async () => {
  const v = await venue();
  talk(v.id, 53);
  serviceState(v.fresh(), TODAY, { channel: "phone" });
  await new Promise((r) => setTimeout(r, 50));
  const record = v.fresh().subscription!.alerts!;
  assert.deepEqual(record.sent, {});
  assert.deepEqual(record.pending, { minutes: [70] });
});

await test("an alert from an earlier period is not sent late", async () => {
  const v = await venue();
  const sub = v.fresh().subscription!;
  upsertLocation({ ...v.fresh(), subscription: { ...sub, alerts: { periodStart: "2026-10-01", sent: {}, pending: { minutes: [90] }, pendingSince: "2026-10-20T10:00:00Z" } } });
  const tried: string[] = [];
  await policy.retryPendingAlerts(async (loc) => (tried.push(loc.id), true), { today: TODAY });
  assert.ok(!tried.includes(v.id));
});

console.log("\n\x1b[1mThe choice is there during the trial\x1b[0m\n");

await test("an owner on a trial can choose what happens at 100%, and nothing acts on it until a plan", async () => {
  const v = await venue({ status: "trialing", trial: { endsOn: "2026-11-15", minutes: 30, conversations: 50 } });
  const out = policy.setUsagePolicyRequest(v.owner, { locationId: v.id, mode: "cap" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(v.fresh().subscription!.usagePolicy?.mode, "cap");
  assert.equal(policy.governs(v.fresh()), false, "the policy acted during the trial");
});

await test("the billing page shows the chooser for a trial, not only for a paid plan", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/billing/page.tsx"), "utf8");
  assert.doesNotMatch(page, /!trialing && isPooled\(products\)/, "the chooser is still hidden in the trial");
  assert.match(page, /isPooledTrial\(subscription\)/);
  const form = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/billing/UsagePolicy.tsx"), "utf8");
  assert.match(form, /applies from your first plan/);
});

await test("the chooser's radios are real radios, and its options are not in capitals", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const form = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/billing/UsagePolicy.tsx"), "utf8");
  // The text-field rule (width 100%, padding, background, box-shadow focus)
  // reaches every <input>; radios and checkboxes must be given all of it back.
  const reset = css.match(/input\[type="radio"\],\s*input\[type="checkbox"\]\s*\{([^}]*)\}/);
  assert.ok(reset, "no radio/checkbox reset after the text-field rule");
  for (const undo of [/width:\s*16px/, /padding:\s*0/, /background:\s*none/, /box-shadow:\s*none/, /border:\s*0/]) {
    assert.match(reset![1], undo, `the reset does not undo ${undo}`);
  }
  assert.ok(css.indexOf(reset![0]) > css.search(/\ninput,\s*textarea,\s*select\s*\{/), "the reset must come after the rule it undoes");
  // Keyboard focus survives `input:focus { outline: none }`.
  assert.match(css, /input\[type="radio"\]:focus-visible,\s*input\[type="checkbox"\]:focus-visible\s*\{[^}]*outline:\s*2px/);
  // The labels: sentence case, by a class that says so.
  const plain = css.match(/label\.label-plain,\s*label\.choice\s*\{([^}]*)\}/);
  assert.ok(plain, "no sentence-case label class");
  assert.match(plain![1], /text-transform:\s*none/);
  assert.match(form, /className="choice"/);
  assert.doesNotMatch(form, /type="radio"[^>]*style=\{\{[^}]*width/, "a radio styled like a text field");
  assert.doesNotMatch(form, /textTransform:\s*"uppercase"/);
  // The names the end-to-end test clicks by.
  assert.match(form, /title: "Stop at the allowance"/);
  assert.match(form, /"Save choice"/);
  assert.match(form, /text: "Saved\."/);
});

await test("packs are live in the catalogue now that the policy works", () => {
  for (const pack of PACKS) assert.equal(pack.status, "live", pack.id);
});

await test("the website's generated pricing quotes the same sentence", () => {
  assert.ok(renderPricing(["AE"]).includes(speak.overLimitSentence()));
});

console.log("\n\x1b[1mVideo counts at 2.5 voice minutes a minute\x1b[0m\n");

/** One completed website video call of `seconds`, inside the period. */
function video(locationId: string, seconds: number) {
  const c = startCall(getLocation(locationId)!, "embed", "website");
  const start = new Date("2026-11-05T12:00:00Z");
  saveCall({
    ...c,
    channel: "embed",
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + seconds * 1000).toISOString(),
    status: "completed",
    video: { provider: "tavus", sessionId: `vs_${Math.random().toString(36).slice(2)}`, seconds },
  });
}

await test("video raises the 70%, 90% and 100% alerts on the voice pool at 2.5x", async () => {
  const v = await venue();
  video(v.id, 21 * 60); // 21 video minutes = 52.5 → 53 voice minutes: 70.7% of 75
  assert.equal(accountFor(v.fresh()!, TODAY)!.usage.meters.find((m) => m.id === "minutes")!.used, 53);
  assert.deepEqual(apply(v).alerts, [{ pool: "minutes", threshold: 70 }]);
  video(v.id, 6 * 60); // +15 → 68 = 90.7%
  assert.deepEqual(apply(v).alerts, [{ pool: "minutes", threshold: 90 }]);
  video(v.id, 3 * 60); // +7.5 → 8 = 76 ≥ 75
  assert.deepEqual(apply(v).alerts, [{ pool: "minutes", threshold: 100 }]);
});

await test("a cap policy stops the voice button when video used the pool, and a pack of 100 voice minutes is 40 video minutes", async () => {
  const { videoMinutesFor, packFor } = await import("../src/lib/billing/plans");
  const v = await venue({ usagePolicy: { mode: "cap", chosenAt: "2026-11-01T00:00:00.000Z", chosenBy: "usr_owner" } });
  video(v.id, 30 * 60); // 75 voice minutes: the whole Starter pool
  assert.equal(decide(v).pools.minutes.exhausted, true);
  assert.equal(serviceState(v.fresh()!, TODAY, { channel: "web_voice" }).answering, false);
  assert.equal(serviceState(v.fresh()!, TODAY, { channel: "chat" }).answering, true);
  assert.equal(packFor("minutes").units, 100);
  assert.equal(videoMinutesFor(packFor("minutes").units), 40);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
