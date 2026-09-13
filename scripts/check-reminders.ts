/**
 * The text the day before — when it goes, and every case where it must not.
 *
 *   npm run check:reminders
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-remind-"));
delete process.env.TWILIO_SMS_FROM;

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, saveBooking, getBooking } = await import("../src/lib/store");
const { instantOf, dueReminders, reminderMessage, sendDueReminders } = await import("../src/lib/reminders");
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
const DAY = "2030-03-12";
const START = 19 * 60 + 30;
const HOUR = 60 * 60 * 1000;
const at = instantOf(DAY, START, venue.timezone);

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: `bk_${Math.random().toString(36).slice(2)}`,
    ref: "R7K2",
    locationId: venue.id,
    vertical: venue.vertical,
    status: "confirmed",
    date: DAY,
    startMin: START,
    endMin: START + 90,
    guestName: "Layla",
    guestPhone: "+971501234567",
    notes: "",
    partySize: 4,
    createdAt: new Date(at - 5 * 24 * HOUR).toISOString(),
    ...over,
  } as Booking;
}

console.log("\n\x1b[1mWhen a booking actually happens\x1b[0m\n");

await test("half past seven in Dubai is half past three UTC", () => {
  assert.equal(instantOf("2026-09-14", 19 * 60 + 30, "Asia/Dubai"), Date.UTC(2026, 8, 14, 15, 30));
});

await test("the day Zurich changes its clocks is not an hour out", () => {
  assert.equal(instantOf("2026-03-29", 12 * 60, "Europe/Zurich"), Date.UTC(2026, 2, 29, 10, 0));
  assert.equal(instantOf("2026-03-28", 12 * 60, "Europe/Zurich"), Date.UTC(2026, 2, 28, 11, 0));
});

console.log("\n\x1b[1mWho gets one\x1b[0m\n");

await test("a booking made days ago is reminded twenty hours out", () => {
  assert.equal(dueReminders(venue, [booking()], at - 20 * HOUR).length, 1);
});

await test("not two days out", () => {
  assert.equal(dueReminders(venue, [booking()], at - 30 * HOUR).length, 0);
});

await test("not in the last hour", () => {
  assert.equal(dueReminders(venue, [booking()], at - 30 * 60 * 1000).length, 0);
});

await test("not for a booking made inside the window — the confirmation was the reminder", () => {
  const b = booking({ createdAt: new Date(at - 6 * HOUR).toISOString() });
  assert.equal(dueReminders(venue, [b], at - 3 * HOUR).length, 0);
});

await test("never twice, and not after a failure", () => {
  const sent = booking({ reminder: { sentAt: new Date().toISOString() } });
  const failedOne = booking({ reminder: { failedAt: new Date().toISOString(), reason: "x" } });
  assert.equal(dueReminders(venue, [sent, failedOne], at - 20 * HOUR).length, 0);
});

await test("not for a cancelled booking, or one with no number", () => {
  const cancelled = booking({ status: "cancelled" });
  const noNumber = booking({ guestPhone: "" });
  assert.equal(dueReminders(venue, [cancelled, noNumber], at - 20 * HOUR).length, 0);
});

await test("not when the venue switched them off", () => {
  assert.equal(dueReminders({ ...venue, reminders: { enabled: false, hoursBefore: 24 } }, [booking()], at - 20 * HOUR).length, 0);
});

await test("a venue that chose four hours is reminded at three, not at twenty", () => {
  const v = { ...venue, reminders: { enabled: true, hoursBefore: 4 } };
  assert.equal(dueReminders(v, [booking()], at - 20 * HOUR).length, 0);
  assert.equal(dueReminders(v, [booking()], at - 3 * HOUR).length, 1);
});

console.log("\n\x1b[1mWhat it says\x1b[0m\n");

await test("the venue, the reference and the number to change it", () => {
  const text = reminderMessage(venue, booking());
  assert.match(text, new RegExp(venue.name));
  assert.match(text, /R7K2/);
  assert.match(text, /table for 4/);
  if (venue.phone) assert.ok(text.includes(venue.phone));
});

await test("an unpaid deposit link rides along; a paid one does not", () => {
  const owed = booking({ deposit: { amount: 400, currency: "AED", status: "required", link: "https://pay.example/x" } });
  const paid = booking({ deposit: { amount: 400, currency: "AED", status: "paid", link: "https://pay.example/x" } });
  assert.match(reminderMessage(venue, owed), /pay\.example/);
  assert.doesNotMatch(reminderMessage(venue, paid), /pay\.example/);
});

await test("with texts not configured, the sweep sends nothing and marks nothing", async () => {
  const b = booking({ date: "2030-01-01" });
  saveBooking(b);
  const result = await sendDueReminders(instantOf("2030-01-01", START, venue.timezone) - 20 * HOUR);
  assert.deepEqual(result, { sent: 0, failed: 0 });
  assert.equal(getBooking(b.id)?.reminder, undefined);
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
