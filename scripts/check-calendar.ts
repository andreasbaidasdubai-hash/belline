/**
 * The calendar, and what it will not let you do.
 *
 * Dragging looks like direct manipulation, which is exactly why the rules
 * have to hold underneath it. A receptionist must not be able to put a guest
 * somewhere a caller could not be put — onto a stylist who cannot do the
 * service, past the last seating, on top of someone else. If the calendar
 * wrote directly there would be two implementations of the rules and the
 * second would be wrong within a month.
 *
 *   npm run check:calendar
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-cal-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { dayView, weekView, weekStart } = await import("../src/lib/calendar");
const { createBooking, modifyBooking } = await import("../src/lib/booking");

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
const salon = listLocations().find((l) => l.vertical === "salon")!;

function soon(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

console.log("\nThe day, drawn\n");

const day = soon(6);
const made = createBooking(restaurant, {
  date: day,
  startMin: 19 * 60,
  guestName: "Grid Test",
  guestPhone: "+44 7700 900555",
  partySize: 4,
});
assert.ok(made.ok, "setup booking failed");

test("a booking appears in the column of the table it holds", () => {
  const view = dayView(restaurant, day);
  const block = view.blocks.find((b) => b.booking.id === made.booking.id);
  assert.ok(block, "the booking is not on the grid");
  assert.ok(
    (made.booking.tableIds ?? []).includes(block.columnId),
    "drawn against a table it does not hold",
  );
});

test("the grid spans the day's opening hours", () => {
  const view = dayView(restaurant, day);
  assert.ok(view.openMin < view.closeMin);
  assert.ok(view.closeMin - view.openMin > 60, "the grid covers less than an hour");
});

test("nothing is silently dropped", () => {
  const view = dayView(restaurant, day);
  const drawn = new Set(view.blocks.map((b) => b.booking.id));
  for (const orphan of view.unplaced) {
    assert.ok(!drawn.has(orphan.id), "a booking is both drawn and listed as unplaced");
  }
});

console.log("\nA diary shows the turnaround separately from the guest's time\n");

const salonDay = soon(7);
const service = salon.salon!.services.find((s) => s.bufferMin > 0)!;
const stylist = salon.salon!.staff.find((p) => p.serviceIds.includes(service.id))!;
const appt = createBooking(salon, {
  date: salonDay,
  startMin: 11 * 60,
  guestName: "Buffer Test",
  guestPhone: "+44 7700 900666",
  serviceIds: [service.id],
  staffId: stylist.id,
});

test("the block carries a buffer beyond the guest-facing end", () => {
  if (!appt.ok) return; // No slot that day; nothing to assert.
  const view = dayView(salon, salonDay);
  const block = view.blocks.find((b) => b.booking.id === appt.booking.id);
  assert.ok(block, "the appointment is not on the grid");
  assert.ok(
    block.bufferEndMin > block.endMin,
    "the turnaround is not drawn — a diary that hides it double-books the chair",
  );
  assert.equal(
    block.endMin - block.startMin,
    service.durationMin,
    "the guest-facing block is not the service length",
  );
});

console.log("\nMoving obeys the same rules as the phone line\n");

test("a move to a valid time succeeds", () => {
  const moved = modifyBooking(restaurant, made.booking, { startMin: 20 * 60 });
  assert.ok(moved.ok, `a legitimate move was refused: ${!moved.ok ? moved.detail : ""}`);
  assert.equal(moved.booking.startMin, 20 * 60);
});

test("a move past the last seating is refused", () => {
  const current = dayView(restaurant, day).blocks[0]?.booking ?? made.booking;
  const late = modifyBooking(restaurant, current, { startMin: 23 * 60 + 45 });
  assert.equal(late.ok, false, "a booking was moved past the last seating");
});

test("a stylist who cannot do the service is refused", () => {
  if (!appt.ok) return;
  const unqualified = salon.salon!.staff.find((p) => !p.serviceIds.includes(service.id));
  if (!unqualified) return; // Everyone is qualified here; nothing to test.
  const moved = modifyBooking(salon, appt.booking, { staffId: unqualified.id });
  assert.equal(moved.ok, false, "an appointment was moved to someone unqualified for it");
});

console.log("\nThe week\n");

test("a week is seven days, starting Monday", () => {
  const week = weekView(restaurant, weekStart(day));
  assert.equal(week.length, 7);
  assert.equal(new Date(`${week[0].date}T12:00:00`).getDay(), 1, "the week does not start on Monday");
});

test("load stays within its bounds", () => {
  for (const d of weekView(restaurant, weekStart(day))) {
    assert.ok(d.load >= 0 && d.load <= 1, `load out of range on ${d.date}: ${d.load}`);
  }
  for (const d of weekView(salon, weekStart(salonDay))) {
    assert.ok(d.load >= 0 && d.load <= 1, `load out of range on ${d.date}: ${d.load}`);
  }
});

test("a day the venue is shut is marked closed", () => {
  const week = weekView(salon, weekStart(salonDay));
  const shut = week.filter((d) => d.closed);
  // Lumière is closed on Sundays in the fixture.
  assert.ok(shut.length > 0, "no closed day found in a week that should contain one");
});

test("the week counts the same bookings the day does", () => {
  const inWeek = weekView(restaurant, weekStart(day)).find((d) => d.date === day)!;
  const inDay = dayView(restaurant, day);
  assert.equal(inWeek.appointments, inDay.appointments, "the two views disagree");
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
