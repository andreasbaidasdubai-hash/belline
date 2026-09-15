/**
 * Belline numbers from the pool, and the codes that forward to them.
 *
 * A signup that asks for a number gets one in the same request, or an honest
 * "being prepared" and a ticket for the team. What is worth pinning is the
 * way this fails: two venues answering on one number (the webhook routes by
 * number, so one of them answers as the other), a number handed out while a
 * previous customer's callers still ring it, and a forwarding code printed
 * with a placeholder in it that an owner dials exactly as shown.
 *
 *   npm run check:pool
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-pool-"));
delete process.env.DATABASE_URL;
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.NUMBER_POOL_LOW_WATER = "0";

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listPoolRows, upsertLocation, listLocations } = await import("../src/lib/store");
const { signUp } = await import("../src/lib/onboarding");
const { addPoolNumbers, assignNumber, releaseNumber, recordManualAssignment, poolSummary, QUARANTINE_DAYS } = await import("../src/lib/telephony/pool");
const { listExceptions } = await import("../src/lib/exceptions");
const { forwardingCodes, uaeCarriers, telLink, DIAGNOSIS } = await import("../src/lib/telephony/forwarding");

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

/** Exceptions log a line each; keep the output readable. */
function quiet<T>(fn: () => T): T {
  const error = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = error;
  }
}

const ROOT = process.cwd();
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

seedIfEmpty();

let seq = 0;
async function newVenue(name: string) {
  const out = await signUp({
    businessName: name,
    email: `owner${++seq}@pooltest.test`,
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
  });
  assert.ok(out.ok, `could not sign up ${name}`);
  return out.ok ? out.location : null!;
}

const on = () => (process.env.FLAG_NUMBERS_POOL = "on");
const off = () => delete process.env.FLAG_NUMBERS_POOL;

console.log("\n\x1b[1mWith the pool off\x1b[0m\n");

await test("the owner is told the number is being prepared and the team gets a ticket", async () => {
  off();
  const venue = await newVenue("Pool Off Salon");
  const out = quiet(() => assignNumber(venue));
  assert.equal(out.state, "preparing");
  assert.equal(out.state === "preparing" && out.reason, "flag_off");
  assert.equal(getLocation(venue.id)!.phone, "", "a number appeared with the pool off");
  assert.equal(listExceptions({ locationId: venue.id, kind: "pool_empty" }).length, 1);
  quiet(() => assignNumber(venue));
  assert.equal(listExceptions({ locationId: venue.id, kind: "pool_empty" }).length, 1, "asking twice opened two tickets");
});

console.log("\n\x1b[1mTwo numbers, three signups\x1b[0m\n");

const first = await newVenue("Pool First");
const second = await newVenue("Pool Second");
const third = await newVenue("Pool Third");

await test("two signups get two different numbers, and the third gets 'being prepared' and a ticket", () => {
  on();
  const added = addPoolNumbers(["+97140000001", "+97140000002"]);
  assert.deepEqual(added.added, ["+97140000001", "+97140000002"]);
  const a = quiet(() => assignNumber(first));
  const b = quiet(() => assignNumber(second));
  const c = quiet(() => assignNumber(third));
  assert.equal(a.state, "assigned");
  assert.equal(b.state, "assigned");
  assert.notEqual(a.state === "assigned" && a.number, b.state === "assigned" && b.number);
  assert.equal(c.state, "preparing");
  assert.equal(c.state === "preparing" && c.reason, "pool_empty");
  assert.match(c.state === "preparing" ? c.ticket : "", /^B-[2-9A-Z]{4}$/);
  assert.equal(getLocation(third.id)!.phone, "");
  assert.equal(listExceptions({ locationId: third.id, kind: "pool_empty" }).length, 1);
});

await test("the number is written on the venue, with when, and the webhook can route by it", () => {
  const venue = getLocation(first.id)!;
  assert.match(venue.phone, /^\+9714000000[12]$/);
  assert.ok(venue.onboarding?.channels.phone?.numberAssignedAt);
  const row = listPoolRows().find((r) => r.number === venue.phone)!;
  assert.equal(row.status, "assigned");
  assert.equal(row.locationId, first.id);
});

await test("asking again returns the same number and claims nothing", () => {
  const before = poolSummary();
  const again = assignNumber(getLocation(first.id)!);
  assert.equal(again.state === "assigned" && again.created, false);
  assert.equal(again.state === "assigned" && again.number, getLocation(first.id)!.phone);
  assert.deepEqual(poolSummary(), before);
});

await test("duplicates and malformed numbers are not added", () => {
  const out = addPoolNumbers(["+97140000001", "0501234567", "+12", "+971 4 000 0009"]);
  assert.deepEqual(out.added, ["+97140000009"]);
  assert.equal(out.skipped.length, 3);
});

await test("a pool number somebody already answers on is never handed out", async () => {
  // +97140000009 is free in the pool, but staff put it on a venue by hand.
  const holder = await newVenue("Pool Holder");
  upsertLocation({ ...getLocation(holder.id)!, phone: "+97140000009" });
  const out = quiet(() => assignNumber(getLocation(third.id)!));
  assert.equal(out.state, "preparing", "a number another venue holds was given out");
});

await test("a number set by hand is marked taken in the pool", async () => {
  const venue = await newVenue("Pool Manual");
  addPoolNumbers(["+97140000010"]);
  recordManualAssignment(venue.id, "+97140000010", "usr_staff");
  const row = listPoolRows().find((r) => r.number === "+97140000010")!;
  assert.equal(row.status, "assigned");
  assert.equal(row.assignedBy, "usr_staff");
  assert.equal(quiet(() => assignNumber(getLocation(third.id)!)).state, "preparing");
});

console.log("\n\x1b[1mMany at once\x1b[0m\n");

await test("20 parallel claims on 10 numbers: 10 distinct numbers, 10 'being prepared', no number twice", async () => {
  on();
  addPoolNumbers(Array.from({ length: 10 }, (_, i) => `+9714100000${String(i).padStart(2, "0")}`));
  const base = getLocation(third.id)!;
  const venues = Array.from({ length: 20 }, (_, i) =>
    upsertLocation({ ...base, id: `loc_pool_parallel_${i}`, name: `Parallel ${i}`, phone: "", onboarding: { version: 1, channels: {} } }),
  );
  const results = await Promise.all(venues.map((v) => Promise.resolve().then(() => quiet(() => assignNumber(v)))));
  const numbers = results.flatMap((r) => (r.state === "assigned" ? [r.number] : []));
  assert.equal(numbers.length, 10);
  assert.equal(new Set(numbers).size, 10, "a number was given to two venues");
  assert.equal(results.filter((r) => r.state === "preparing").length, 10);
  const phones = listLocations({ includeInternal: true }).map((l) => l.phone).filter(Boolean);
  assert.equal(new Set(phones).size, phones.length, "two venues answer on one number");
  const assigned = listPoolRows().filter((r) => r.status === "assigned");
  assert.equal(new Set(assigned.map((r) => r.locationId)).size, assigned.length);
});

console.log("\n\x1b[1mGiving a number back\x1b[0m\n");

await test("a released number is quarantined for 30 days, then goes to the next venue", async () => {
  on();
  const leaving = await newVenue("Pool Leaving");
  addPoolNumbers(["+97140000077"]);
  const got = quiet(() => assignNumber(leaving));
  assert.equal(got.state === "assigned" && got.number, "+97140000077");
  const now = new Date();
  assert.equal(releaseNumber(leaving.id, now), "+97140000077");
  upsertLocation({ ...getLocation(leaving.id)!, phone: "" });

  const next = await newVenue("Pool Next");
  const soon = quiet(() => assignNumber(next, new Date(now.getTime() + 24 * 3600_000)));
  assert.equal(soon.state, "preparing", "a released number was reused the next day");
  const later = quiet(() => assignNumber(getLocation(next.id)!, new Date(now.getTime() + (QUARANTINE_DAYS + 1) * 24 * 3600_000)));
  assert.equal(later.state === "assigned" && later.number, "+97140000077");
});

await test("the team is told when the pool runs low, before it is empty", async () => {
  on();
  process.env.NUMBER_POOL_LOW_WATER = "5";
  const venue = await newVenue("Pool Low");
  addPoolNumbers(["+97140000088", "+97140000089"]);
  quiet(() => assignNumber(venue));
  process.env.NUMBER_POOL_LOW_WATER = "0";
  assert.ok(listExceptions({ kind: "vendor_balance_low" }).some((r) => /number pool is running low/.test(r.reason)));
});

console.log("\n\x1b[1mForwarding codes\x1b[0m\n");

await test("no number means no codes at all, never a placeholder", () => {
  assert.deepEqual(forwardingCodes(""), []);
  assert.deepEqual(forwardingCodes("<your Belline number>"), []);
  for (const carrier of uaeCarriers("")) assert.deepEqual(carrier.mobile, []);
});

await test("codes carry the real number and a tel: link with # escaped", () => {
  const codes = forwardingCodes("+97140000001");
  assert.equal(codes.find((c) => c.mode === "noanswer")!.dial, "**61*+97140000001#");
  assert.equal(codes.find((c) => c.mode === "noanswer")!.tel, "tel:**61*+97140000001%23");
  assert.ok(codes.every((c) => c.tel.startsWith("tel:") && !c.tel.includes("#")));
  assert.equal(telLink("##004#"), "tel:%23%23004%23");
});

await test("Virgin Mobile appears only with its flag, and unverified codes say so", () => {
  assert.deepEqual(uaeCarriers("+97140000001", { virgin: false }).map((c) => c.id), ["du", "eand"]);
  const withVirgin = uaeCarriers("+97140000001", { virgin: true });
  assert.deepEqual(withVirgin.map((c) => c.id), ["du", "eand", "virgin"]);
  assert.equal(withVirgin[2].landline, null);
  assert.ok(withVirgin.every((c) => c.verified === false), "a carrier was marked verified without a real-line test");
  assert.ok(DIAGNOSIS.length >= 3);
});

await test("the Go live page renders no placeholder, links every code and offers 'Get my number' only with the pool on", () => {
  const page = source("src/app/(app)/golive/page.tsx");
  const phone = source("src/app/(app)/golive/PhoneSetup.tsx");
  assert.ok(!/<your Belline number>/.test(page + phone), "placeholder text is still rendered");
  assert.ok(!/mailto:|hello@/.test(page + phone));
  assert.match(phone, /href=\{code\.tel\}/);
  assert.match(phone, /Get my number/);
  assert.match(phone, /poolOn/);
  assert.match(phone, /being prepared/);
});

await test("the owner route assigns through the pool; the staff override closes the ticket with a note", () => {
  assert.match(source("src/app/api/phone/number/route.ts"), /assignNumber\(/);
  const staff = source("src/app/api/sales/clients/number/route.ts");
  assert.match(staff, /recordManualAssignment\(/);
  assert.match(staff, /releaseNumber\(/);
  assert.match(staff, /kind: "pool_empty"/);
  assert.match(staff, /kind: "resolve", note:/);
});

await test("nothing tried to reach a real provider", () => {
  assert.deepEqual(blockedFetches(), []);
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
