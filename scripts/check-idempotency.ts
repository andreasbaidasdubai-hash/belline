/**
 * Booking twice.
 *
 * The failure this prevents is unforgiving: a restaurant that finds two
 * tables held for the same six people at eight o'clock stops trusting the
 * system, and unlike most bugs it cannot be apologised away afterwards
 * because the table was already gone.
 *
 * As with the authority rules, half of these tests are the cases that must
 * NOT be blocked. A guard that refuses a guest their second genuine booking
 * is a worse bug than the one it prevents.
 *
 *   npm run check:idempotency
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the store before anything imports it: these write real bookings,
// and a test that consumes the demo diary would poison the next run.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-idem-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, listBookings } = await import("../src/lib/store");
const { createBooking, modifyBooking, cancelBooking } = await import("../src/lib/booking");
const { bookingKey, describeWhat } = await import("../src/lib/booking/idempotency");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  [32m✓[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

seedIfEmpty();
const restaurant = listLocations().find((l) => l.vertical === "restaurant")!;
const clinic = listLocations().find((l) => l.vertical === "clinic")!;

/** A date far enough out that the seeded diary is empty. */
function futureDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

console.log("\nThe same booking arriving twice\n");

const guest = { guestName: "Andreas Baidas", guestPhone: "+44 7700 900123" };
const day = futureDate(9);

const first = createBooking(restaurant, { ...guest, date: day, startMin: 19 * 60, partySize: 4 });
test("the first request books", () => {
  assert.ok(first.ok, "first booking failed");
  assert.ok(!("duplicate" in first) || !first.duplicate);
});

test("an identical retry returns the same booking, not a second one", () => {
  const again = createBooking(restaurant, { ...guest, date: day, startMin: 19 * 60, partySize: 4 });
  assert.ok(again.ok);
  assert.equal(again.duplicate, true, "not flagged as a duplicate");
  assert.equal(again.booking.id, first.ok ? first.booking.id : "", "a second booking was created");
});

test("only one booking is on the book", () => {
  const held = listBookings({ locationId: restaurant.id }).filter(
    (b) => b.date === day && b.startMin === 19 * 60 && b.status === "confirmed",
  );
  assert.equal(held.length, 1, `expected 1 booking, found ${held.length}`);
});

test("a formatted phone number is the same phone number", () => {
  const again = createBooking(restaurant, {
    guestName: "andreas baidas",
    guestPhone: "07700900123",
    date: day,
    startMin: 19 * 60,
    partySize: 4,
  });
  assert.ok(again.ok);
  assert.equal(again.duplicate, true, "normalisation failed — a second table was held");
});

console.log("\nWhat must still go through\n");

test("a different time is a different booking", () => {
  const other = createBooking(restaurant, { ...guest, date: day, startMin: 20 * 60, partySize: 4 });
  assert.ok(other.ok);
  assert.ok(!other.duplicate, "a genuinely different time was refused");
});

test("a different party size is a different booking", () => {
  const other = createBooking(restaurant, {
    ...guest,
    date: futureDate(10),
    startMin: 19 * 60,
    partySize: 2,
  });
  assert.ok(other.ok);
  assert.ok(!other.duplicate);
});

test("a different guest at the same time is a different booking", () => {
  const other = createBooking(restaurant, {
    guestName: "Someone Else",
    guestPhone: "+44 7700 900999",
    date: futureDate(11),
    startMin: 19 * 60,
    partySize: 4,
  });
  assert.ok(other.ok);
  assert.ok(!other.duplicate);
});

test("after cancelling, the same guest can rebook the same slot", () => {
  const d = futureDate(12);
  const made = createBooking(restaurant, { ...guest, date: d, startMin: 19 * 60, partySize: 4 });
  assert.ok(made.ok);
  cancelBooking(made.booking);
  const again = createBooking(restaurant, { ...guest, date: d, startMin: 19 * 60, partySize: 4 });
  assert.ok(again.ok);
  assert.ok(!again.duplicate, "a cancelled booking blocked a genuine rebooking");
});

test("moving a booking frees its old slot for someone else's fingerprint", () => {
  const d = futureDate(13);
  const made = createBooking(restaurant, { ...guest, date: d, startMin: 19 * 60, partySize: 4 });
  assert.ok(made.ok);
  const moved = modifyBooking(restaurant, made.booking, { startMin: 21 * 60 });
  assert.ok(moved.ok, "move failed");
  assert.notEqual(
    moved.booking.idempotencyKey,
    made.booking.idempotencyKey,
    "the fingerprint did not follow the booking to its new time",
  );

  // The same guest genuinely wanting the vacated slot must not be refused.
  const back = createBooking(restaurant, { ...guest, date: d, startMin: 19 * 60, partySize: 4 });
  assert.ok(back.ok);
  assert.ok(!back.duplicate, "the vacated slot was still guarded by a stale fingerprint");
});

console.log("\nDiary verticals\n");

test("a repeated clinic appointment is caught too", () => {
  const d = futureDate(14);
  const services = clinic.salon!.services.slice(0, 1).map((s) => s.id);
  const made = createBooking(clinic, {
    guestName: "Sara Meyer",
    guestPhone: "+44 7700 900222",
    date: d,
    startMin: 10 * 60,
    serviceIds: services,
  });
  if (!made.ok) return; // No slot that day; nothing to assert about duplicates.
  const again = createBooking(clinic, {
    guestName: "Sara Meyer",
    guestPhone: "+44 7700 900222",
    date: d,
    startMin: 10 * 60,
    serviceIds: services,
  });
  assert.ok(again.ok);
  assert.equal(again.duplicate, true, "a clinic appointment was booked twice");
});

console.log("\nThe fingerprint itself\n");

test("is stable across formatting and case", () => {
  const a = bookingKey({
    locationId: "x",
    date: "2026-10-01",
    startMin: 600,
    guestPhone: "+44 7700 900123",
    guestName: "Andreas Baidas",
    what: describeWhat({ partySize: 4 }),
  });
  const b = bookingKey({
    locationId: "x",
    date: "2026-10-01",
    startMin: 600,
    guestPhone: "07700900123",
    guestName: "  andreas   baidas ",
    what: describeWhat({ partySize: 4 }),
  });
  assert.equal(a, b);
});

test("service order does not change it", () => {
  assert.equal(
    describeWhat({ serviceIds: ["b", "a"] }),
    describeWhat({ serviceIds: ["a", "b"] }),
  );
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
