/**
 * Deposits: inert until card payments are on, and never confused with a plan.
 *
 *   npm run check:deposits
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-deposit-"));
delete process.env.STRIPE_SECRET_KEY;

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, saveBooking, getBooking, getLocation, upsertLocation } = await import("../src/lib/store");
const { depositsReady, requestDeposit, settleDeposit, applyDepositEvent } = await import("../src/lib/billing/deposits");
const { applyStripeEvent } = await import("../src/lib/billing/stripe");
const { depositWording } = await import("../src/lib/booking/policy");
type Booking = import("../src/lib/types").Booking;

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
const venue = listLocations().find((l) => l.vertical === "restaurant")!;
const before = venue.subscription;

const b = saveBooking({
  id: "bk_deposit_1",
  ref: "D3P0",
  locationId: venue.id,
  vertical: venue.vertical,
  status: "confirmed",
  date: "2030-05-01",
  startMin: 20 * 60,
  endMin: 22 * 60,
  guestName: "Omar",
  guestPhone: "+971501234567",
  notes: "",
  partySize: 6,
  createdAt: new Date().toISOString(),
  deposit: { amount: 600, currency: "AED", status: "required" },
} as unknown as Booking);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const event = (type: string, object: Record<string, unknown>) => ({ type, data: { object } }) as any;

console.log("\n\x1b[1mOff until it is on\x1b[0m\n");

await test("without Stripe, no venue is ready — even one with an account on file", () => {
  const v = upsertLocation({ ...venue, payments: { stripeAccountId: "acct_1", chargesEnabled: true } });
  assert.equal(depositsReady(v), false);
});

await test("with Stripe, a venue is ready only once Stripe says it can take cards", () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  assert.equal(depositsReady({ ...venue, payments: { stripeAccountId: "acct_1", chargesEnabled: false } }), false);
  assert.equal(depositsReady({ ...venue, payments: { stripeAccountId: "acct_1", chargesEnabled: true } }), true);
  delete process.env.STRIPE_SECRET_KEY;
});

await test("asking for a link when not ready says why and changes nothing", async () => {
  const r = await requestDeposit(getLocation(venue.id)!, b.id);
  assert.equal(r.link, null);
  assert.ok(r.detail);
  assert.equal(getBooking(b.id)?.deposit?.link, undefined);
});

await test("the agent only promises a text when one was sent", () => {
  const deposit = { amount: 600, currency: "AED", status: "required" as const };
  const noRule = { ...venue, policy: undefined };
  assert.match(depositWording(noRule, deposit), /team will send a link/);
  assert.match(depositWording(noRule, deposit, { linkTexted: true }), /on its way/);
});

console.log("\n\x1b[1mWhat Stripe says\x1b[0m\n");

await test("a paid deposit session marks the booking paid", () => {
  const r = applyDepositEvent(event("checkout.session.completed", {
    mode: "payment", payment_status: "paid", metadata: { belline_booking: b.id },
  }));
  assert.equal(r?.applied, "deposit paid");
  assert.equal(getBooking(b.id)?.deposit?.status, "paid");
});

await test("a deposit session is never taken for a subscription", () => {
  const r = applyStripeEvent(event("checkout.session.completed", {
    mode: "payment", payment_status: "paid", metadata: { belline_booking: b.id, belline_location: venue.id },
  }));
  assert.match(r.applied, /deposit, not a subscription/);
  assert.deepEqual(getLocation(venue.id)?.subscription, before);
});

await test("a subscription session is not ours to handle here", () => {
  assert.equal(applyDepositEvent(event("checkout.session.completed", { mode: "subscription", metadata: {} })), null);
});

await test("Stripe finishing onboarding switches card payments on for that venue", () => {
  const r = applyDepositEvent(event("account.updated", { id: "acct_1", charges_enabled: true }));
  assert.ok(r);
  assert.equal(getLocation(venue.id)?.payments?.chargesEnabled, true);
});

await test("the desk can let a deposit off", () => {
  saveBooking({ ...getBooking(b.id)!, deposit: { amount: 600, currency: "AED", status: "required" } });
  assert.equal(settleDeposit(b.id, "waived")?.deposit?.status, "waived");
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
