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
import { format } from "node:util";

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

/** The boot log, collected rather than printed. */
function quietLog<T>(fn: () => T, into: string[] = []): T {
  const log = console.log;
  console.log = (...args: unknown[]) => {
    into.push(format(...args));
  };
  try {
    return fn();
  } finally {
    console.log = log;
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
  assert.equal(getLocation(venue.id)!.bellineNumber, undefined, "a number appeared with the pool off");
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
  assert.equal(getLocation(third.id)!.bellineNumber, undefined);
  assert.equal(listExceptions({ locationId: third.id, kind: "pool_empty" }).length, 1);
});

await test("the number is written on the venue, with when, and the webhook can route by it", () => {
  const venue = getLocation(first.id)!;
  assert.match(venue.bellineNumber!.number, /^\+9714000000[12]$/);
  assert.equal(venue.bellineNumber!.via, "pool");
  assert.ok(venue.onboarding?.channels.phone?.numberAssignedAt);
  const row = listPoolRows().find((r) => r.number === venue.bellineNumber!.number)!;
  assert.equal(row.status, "assigned");
  assert.equal(row.locationId, first.id);
});

await test("asking again returns the same number and claims nothing", () => {
  const before = poolSummary();
  const again = assignNumber(getLocation(first.id)!);
  assert.equal(again.state === "assigned" && again.created, false);
  assert.equal(again.state === "assigned" && again.number, getLocation(first.id)!.bellineNumber!.number);
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
  upsertLocation({ ...getLocation(holder.id)!, bellineNumber: { number: "+97140000009", via: "staff", assignedAt: "2026-09-16T08:00:00.000Z" } });
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
    upsertLocation({ ...base, id: `loc_pool_parallel_${i}`, name: `Parallel ${i}`, bellineNumber: undefined, onboarding: { version: 1, channels: {} } }),
  );
  const results = await Promise.all(venues.map((v) => Promise.resolve().then(() => quiet(() => assignNumber(v)))));
  const numbers = results.flatMap((r) => (r.state === "assigned" ? [r.number] : []));
  assert.equal(numbers.length, 10);
  assert.equal(new Set(numbers).size, 10, "a number was given to two venues");
  assert.equal(results.filter((r) => r.state === "preparing").length, 10);
  const phones = listLocations({ includeInternal: true }).map((l) => l.bellineNumber?.number).filter(Boolean);
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
  upsertLocation({ ...getLocation(leaving.id)!, bellineNumber: undefined });

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
  const route = source("src/app/api/sales/clients/number/route.ts");
  assert.match(route, /recordStaffNumber\(/);
  // The route's work lives in pool.ts, where a check can run it.
  const staff = source("src/lib/telephony/pool.ts").split("export function recordStaffNumber")[1].split("\nexport function ")[0];
  assert.match(staff, /recordManualAssignment\(/);
  assert.match(staff, /releaseNumber\(/);
  assert.match(staff, /kind: "pool_empty"/);
  assert.match(staff, /kind: "resolve", note:/);
});

console.log("\n\x1b[1mThe owner's own phone is never a forwarding target\x1b[0m\n");

await test("the business phone saved on review is not a Belline number: no target, 'being prepared', and the pool still gives a real one", async () => {
  // Only what the product has always had, up to the pool assignment, so this
  // fails on the build that showed the bug rather than failing to load there.
  const { applyDraft } = await import("../src/lib/onboarding");
  const { openWindow } = await import("../src/lib/telephony/verify");
  const { channelStatuses } = await import("../src/lib/onboarding/journey");
  const owner = await newVenue("Pool Own Line");
  // What the founder saw: 0502992339 typed on the review step as the business's
  // own number, then shown on the channels step as the number to forward to.
  applyDraft(getLocation(owner.id)!, { phone: "+971502992339" });
  const v = () => getLocation(owner.id)!;
  const phone = channelStatuses(v())[0];
  assert.equal(phone.state, "not_set_up", `the channels step treats the owner's own phone as a Belline number: ${phone.detail}`);
  assert.match(phone.detail, /Your Belline number is being prepared/);
  assert.equal(openWindow(v(), "du").ok, false, "a forwarding test was opened against the owner's own phone");
  off();
  assert.equal(quiet(() => assignNumber(v())).state, "preparing", "assignNumber returned the owner's own phone as assigned");
  on();
  addPoolNumbers(["+97140000088"]);
  const got = quiet(() => assignNumber(v()));
  assert.equal(got.state, "assigned");
  const number = got.state === "assigned" ? got.number : "";
  assert.ok(listPoolRows().some((r) => r.number === number && r.locationId === owner.id), `${number} is not a pool number assigned to the venue`);
  assert.notEqual(number.replace(/\D/g, "").slice(-9), "502992339");

  const { bellineNumberOf } = await import("../src/lib/telephony/number");
  assert.equal(bellineNumberOf(v()), number);
  assert.deepEqual(forwardingCodes(bellineNumberOf(v())).filter((c) => c.dial.includes("502992339")), [], "forwarding codes were built for the owner's own phone");
  assert.equal(v().businessPhone, "+971502992339", "assigning a Belline number changed the business's own phone");
});

await test("assigning a Belline number never changes the business phone: pool, staff, re-assigning and clearing", async () => {
  const { bellineNumberOf } = await import("../src/lib/telephony/number");
  const { recordStaffNumber } = await import("../src/lib/telephony/pool");
  on();
  const venue = await newVenue("Pool Keeps Own Line");
  const own = "+971502992339";
  upsertLocation({ ...getLocation(venue.id)!, businessPhone: own });
  const v = () => getLocation(venue.id)!;

  addPoolNumbers(["+97140000301"]);
  const got = quiet(() => assignNumber(v()));
  assert.equal(got.state === "assigned" && got.number, "+97140000301");
  assert.equal(v().businessPhone, own, "the pool changed the business phone");
  assert.equal(v().bellineNumber?.via, "pool");

  const staff = quiet(() => recordStaffNumber(venue.id, "+971 4 000 0302", "usr_staff"));
  assert.ok(staff.ok, staff.ok ? "" : staff.error);
  assert.equal(bellineNumberOf(v()), "+97140000302", "the staff number was not stored E.164");
  assert.deepEqual({ via: v().bellineNumber?.via, by: v().bellineNumber?.by }, { via: "staff", by: "usr_staff" });
  assert.equal(v().businessPhone, own, "recording a number by hand changed the business phone");
  assert.equal(listPoolRows().find((r) => r.number === "+97140000301")?.status, "quarantine", "the pool number replaced by hand was not given back");

  const cleared = quiet(() => recordStaffNumber(venue.id, "", "usr_staff"));
  assert.ok(cleared.ok);
  assert.equal(v().bellineNumber, undefined);
  assert.equal(v().businessPhone, own, "clearing the Belline number cleared the business phone");

  // E.164 on the server, and one number per venue.
  const local = recordStaffNumber(venue.id, "04 000 0303", "usr_staff");
  assert.equal(!local.ok && local.status, 422, "a number without its country code was stored");
  const taken = recordStaffNumber(venue.id, bellineNumberOf(getLocation("loc_belline")!), "usr_staff");
  assert.equal(!taken.ok && taken.status, 409, "a number another venue answers on was recorded");
  assert.equal(v().businessPhone, own);
});

await test("the voice webhook routes by the Belline number, never by the business phone", async () => {
  const { venueForDialledNumber } = await import("../src/lib/telephony/number");
  const a = { id: "a", businessPhone: "+97140000401", bellineNumber: { number: "+97140000402", via: "pool" as const, assignedAt: "2026-09-16T08:00:00.000Z" } };
  const b: { id: string; businessPhone: string; bellineNumber?: typeof a.bellineNumber } = { id: "b", businessPhone: "+97140000402" };
  assert.equal(venueForDialledNumber([b, a], "+97140000402")?.id, "a", "a venue whose own phone matched took the call");
  assert.equal(venueForDialledNumber([a, b], "+97140000401"), undefined, "the business's own phone routed a call");
  assert.equal(venueForDialledNumber([a, b], ""), undefined);
  assert.match(source("src/app/api/twilio/voice/route.ts"), /const dialled = venueForDialledNumber\(locations, to\)/);
  assert.doesNotMatch(source("src/app/api/twilio/voice/route.ts"), /\.phone\b|businessPhone/);
});

await test("a number staff set by hand, or one our own venues always had, is Belline's", async () => {
  const { bellineNumberOf } = await import("../src/lib/telephony/number");
  const hand = await newVenue("Pool Hand Set");
  const { recordStaffNumber } = await import("../src/lib/telephony/pool");
  assert.ok(quiet(() => recordStaffNumber(hand.id, "+97140000099", "usr_staff")).ok);
  assert.equal(bellineNumberOf(getLocation(hand.id)!), "+97140000099");
  // Still stamped, so a rollback past the split reads the number as Belline's.
  assert.ok(getLocation(hand.id)!.onboarding?.channels.phone?.numberAssignedAt);
  for (const [id, number] of [["loc_azure", "+97145550142"], ["loc_lumiere", "+41445552180"], ["loc_meridian", "+97145550390"], ["loc_belline", "+15717785920"]]) {
    assert.equal(bellineNumberOf(getLocation(id)!), number, id);
    assert.equal(getLocation(id)!.bellineNumber?.via, "legacy", id);
  }
  // A field read, not a guess: nothing in number.ts reads a `phone` any more, except the one-off split.
  const reader = source("src/lib/telephony/number.ts").split("export function hasBellineNumber")[0];
  assert.doesNotMatch(reader, /\.phone\b|listPoolRows|onboarding/);
});

await test("the channels step, Go live and Belle read only the Belline number", () => {
  const step = source("src/app/setup/[step]/page.tsx");
  assert.doesNotMatch(step, /forwards the calls you miss to \$\{venue\.phone\}/, "the channels card still forwards to venue.phone");
  assert.match(step, /const belline = bellineNumberOf\(venue\)/);
  assert.match(step, /Your Belline number is being prepared/);
  assert.match(source("src/app/(app)/golive/page.tsx"), /const number = bellineNumberOf\(location\)/);
  assert.match(source("src/lib/onboarding/assistant.ts"), /const number = bellineNumberOf\(location\)/);
  assert.match(source("src/lib/telephony/verify.ts"), /bellineNumberOf\(location\)/);
});

console.log("\n\x1b[1mSplitting the old phone field on boot\x1b[0m\n");

/** Ring the voice webhook, signed as Twilio signs, and see which venue it streams to. */
let sid = 0;
async function whoAnswers(to: string): Promise<string | null> {
  const crypto = await import("node:crypto");
  const { POST } = await import("../src/app/api/twilio/voice/route");
  const { verifyStreamToken } = await import("../src/lib/auth");
  const url = "https://app.belline.ai/api/twilio/voice";
  const form = { To: to, From: "+15551230000", CallSid: `CA_split_${++sid}` };
  const payload = url + Object.keys(form).sort().map((k) => k + form[k as keyof typeof form]).join("");
  const signature = crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!).update(payload, "utf8").digest("base64");
  const res = await POST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature, host: "app.belline.ai", "x-forwarded-proto": "https" },
      body: new URLSearchParams(form).toString(),
    }),
  );
  const token = (await res.text()).match(/name="token" value="([^"]+)"/)?.[1];
  return token ? verifyStreamToken(token) : null;
}

/** A venue as production stores it before the split: one `phone`, neither new field. */
function legacy(id: string, phone: string, change: (l: Record<string, unknown>) => Record<string, unknown> = (l) => l): Record<string, unknown> {
  const { businessPhone: _b, bellineNumber: _n, ...rest } = getLocation(id)!;
  void _b;
  void _n;
  return change({ ...rest, phone });
}

// Production's own venues, with the numbers seeded on them: Twilio routes these today.
const PRODUCTION = [
  { id: "loc_belline", phone: "+1 571 778 5920", to: "+15717785920" },
  { id: "loc_azure", phone: "+971 4 555 0142", to: "+97145550142" },
  { id: "loc_lumiere", phone: "+41 44 555 21 80", to: "+41445552180" },
  { id: "loc_meridian", phone: "+971 4 555 0390", to: "+97145550390" },
];

await test("our own venue and the three demo lines answer on exactly the numbers they did before the split", async () => {
  const { splitVenuePhones } = await import("../src/lib/seed");
  for (const v of PRODUCTION) upsertLocation(legacy(v.id, v.phone) as never);
  for (const v of PRODUCTION) {
    const stored = getLocation(v.id) as unknown as { phone: string; businessPhone?: string };
    assert.equal(stored.businessPhone, undefined, `${v.id} is not shaped like production's`);
    // How the webhook matched before: the digits of `phone`.
    const before = listLocations({ includeInternal: true }).find((l) => (l as unknown as { phone?: string }).phone?.replace(/\D/g, "") === v.to.replace(/\D/g, ""));
    assert.equal(before?.id, v.id, `${v.to} did not route to ${v.id} before the split`);
  }
  const decided = quietLog(() => splitVenuePhones());
  for (const v of PRODUCTION) {
    assert.deepEqual(decided.find((d) => d.id === v.id), { id: v.id, rule: "ours_or_legacy" }, v.id);
    const after = getLocation(v.id)!;
    assert.equal(after.bellineNumber?.number, v.to, `${v.id} lost its Twilio number`);
    assert.equal(after.bellineNumber?.via, "legacy");
    assert.equal(after.businessPhone, v.phone, `${v.id} gives out a different number now`);
    assert.equal(await quiet(() => whoAnswers(v.to)), v.id, `${v.to} no longer reaches ${v.id}`);
  }
});

await test("customer venues: a pool record, the staff marker or evidence of calls keep routing; a typed number becomes the business phone", async () => {
  const { splitVenuePhones } = await import("../src/lib/seed");
  const { venueForDialledNumber } = await import("../src/lib/telephony/number");
  on();
  // Assigned from the pool, then the review step wrote the owner's own mobile over it: the bug.
  const pooled = await newVenue("Split Pooled");
  addPoolNumbers(["+97140000501"]);
  quiet(() => assignNumber(pooled));
  upsertLocation(legacy(pooled.id, "+971502992339") as never);
  // Recorded by staff, stamped.
  const stamped = await newVenue("Split Stamped");
  upsertLocation(legacy(stamped.id, "+97140000502", (l) => ({ ...l, onboarding: { ...(l.onboarding as object), channels: { phone: { numberAssignedAt: "2026-09-10T08:00:00.000Z" } } } })) as never);
  // Recorded by staff before the stamp existed, with a passed forwarding test.
  const tested = await newVenue("Split Tested");
  upsertLocation(legacy(tested.id, "+97140000503", (l) => ({ ...l, onboarding: { ...(l.onboarding as object), channels: { phone: { forwardingVerifiedAt: "2026-09-10T08:00:00.000Z" } } } })) as never);
  // Only ever typed by the owner.
  const typed = await newVenue("Split Typed");
  upsertLocation(legacy(typed.id, "0502992339") as never);
  // Nothing at all.
  const empty = await newVenue("Split Empty");
  upsertLocation(legacy(empty.id, "") as never);

  const decided = quietLog(() => splitVenuePhones());
  const rule = (id: string) => decided.find((d) => d.id === id)?.rule;
  const all = () => listLocations({ includeInternal: true });

  assert.equal(rule(pooled.id), "pool_record");
  assert.equal(getLocation(pooled.id)!.bellineNumber?.number, "+97140000501");
  assert.equal(getLocation(pooled.id)!.bellineNumber?.via, "pool");
  assert.equal(getLocation(pooled.id)!.businessPhone, "+971502992339", "the owner's own phone was lost");
  assert.equal(venueForDialledNumber(all(), "+97140000501")?.id, pooled.id);

  assert.equal(rule(stamped.id), "staff_marker");
  assert.deepEqual([getLocation(stamped.id)!.bellineNumber?.number, getLocation(stamped.id)!.bellineNumber?.via, getLocation(stamped.id)!.businessPhone], ["+97140000502", "staff", ""]);
  assert.equal(venueForDialledNumber(all(), "+97140000502")?.id, stamped.id, "a staff-recorded number stopped routing");

  assert.equal(rule(tested.id), "routed_evidence");
  assert.equal(venueForDialledNumber(all(), "+97140000503")?.id, tested.id, "a number with a passed forwarding test stopped routing");

  assert.equal(rule(typed.id), "business_phone");
  assert.equal(getLocation(typed.id)!.businessPhone, "0502992339");
  assert.equal(getLocation(typed.id)!.bellineNumber, undefined, "the owner's own phone became a forwarding target");

  assert.equal(rule(empty.id), "empty");
  assert.deepEqual([getLocation(empty.id)!.businessPhone, getLocation(empty.id)!.bellineNumber], ["", undefined]);
});

await test("the split is idempotent, logs each decision without the number, and keeps the old field on disk for a rollback", async () => {
  const { splitVenuePhones } = await import("../src/lib/seed");
  const { splitLegacyPhone } = await import("../src/lib/telephony/number");
  const before = JSON.stringify(listLocations({ includeInternal: true, includeArchived: true }));
  const lines: string[] = [];
  const again = quietLog(() => splitVenuePhones(), lines);
  assert.deepEqual(again, [], "a second boot decided again");
  assert.equal(JSON.stringify(listLocations({ includeInternal: true, includeArchived: true })), before, "a second boot changed a venue");

  const venue = await newVenue("Split Log");
  upsertLocation(legacy(venue.id, "+97140000601", (l) => ({ ...l, onboarding: { ...(l.onboarding as object), channels: { phone: { numberAssignedAt: "2026-09-10T08:00:00.000Z" } } } })) as never);
  quietLog(() => splitVenuePhones(), lines);
  const line = lines.find((l) => l.includes(venue.id)) ?? "";
  assert.match(line, /staff_marker/);
  assert.doesNotMatch(line, /40000601/, "the boot log printed a phone number");

  // What a build from before the split reads on disk: `phone`, the routed number.
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR!, "locations.json"), "utf8")) as { id: string; phone?: string }[];
  assert.equal(disk.find((l) => l.id === venue.id)?.phone, "+97140000601");
  assert.equal(disk.find((l) => l.id === "loc_belline")?.phone, "+15717785920");
  assert.ok(disk.every((l) => typeof l.phone === "string"), "a venue on disk has no `phone` for a rollback to read");

  // Pure: the same stored venue always splits the same way.
  const raw = legacy("loc_azure", "+971 4 555 0142") as never;
  assert.deepEqual(splitLegacyPhone(raw, [], { phoneCalls: 0 }, new Date(0)), splitLegacyPhone(raw, [], { phoneCalls: 0 }, new Date(0)));
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
