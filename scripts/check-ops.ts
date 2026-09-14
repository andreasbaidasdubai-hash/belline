/**
 * Running the floor and the week: the restaurant floor plan, reports and CSV
 * exports, and the staff rota.
 *
 *   npm run check:ops
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-ops-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listLocations, saveBooking, upsertLocation } = await import("../src/lib/store");
const { applyLayout, defaultLayout, floorState } = await import("../src/lib/floor");
const { coerceRestaurant } = await import("../src/lib/booking/config");
const { buildReport, csv, exportCsv } = await import("../src/lib/reports");
const { applyRotaChange, strandedBookings, weekRota } = await import("../src/lib/rota");
const { staffWorkingRanges } = await import("../src/lib/booking/salon");
const { addDays, todayIn } = await import("../src/lib/time");

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

const restaurant = listLocations().find((l) => l.restaurant && l.restaurant.tables.length >= 3)!;
const [t1, t2, t3, t4] = restaurant.restaurant!.tables;
const day = "2027-03-10";
let seq = 0;

function booking(extra: Record<string, unknown>) {
  seq++;
  return saveBooking({
    id: `bk_ops_${seq}`, ref: `OPS${seq}`, locationId: restaurant.id, vertical: "restaurant", status: "confirmed",
    date: day, startMin: 19 * 60, endMin: 20 * 60 + 30, guestName: `Guest ${seq}`, guestPhone: `+97150000${String(seq).padStart(4, "0")}`,
    notes: "", partySize: 2, source: "voice", createdAt: new Date().toISOString(), ...extra,
  } as never);
}

console.log("\n\x1b[1mFloor plan\x1b[0m\n");

await test("unplaced tables get distinct default positions", () => {
  const layout = defaultLayout(restaurant.restaurant!.tables);
  const spots = new Set([...layout.values()].map((p) => `${p.x},${p.y}`));
  assert.equal(spots.size, restaurant.restaurant!.tables.length);
});

await test("each table says what is happening at it: seated, arrived, late, due soon, free", () => {
  booking({ tableIds: [t1.id], startMin: 18 * 60 + 30, service: { arrivedAt: "x", seatedAt: "y" } });
  booking({ tableIds: [t2.id], startMin: 19 * 60, service: { arrivedAt: "x" } });
  booking({ tableIds: [t3.id], startMin: 18 * 60 + 30 });
  if (t4) booking({ tableIds: [t4.id], startMin: 19 * 60 + 20 });
  const state = floorState(getLocation(restaurant.id)!, day, 19 * 60);
  const of = (id: string) => state.find((t) => t.id === id)!;
  assert.equal(of(t1.id).status, "seated");
  assert.equal(of(t2.id).status, "arrived");
  assert.equal(of(t3.id).status, "late");
  assert.match(of(t3.id).label, /30 min late/);
  if (t4) assert.equal(of(t4.id).status, "soon");
  const free = state.find((t) => ![t1.id, t2.id, t3.id, t4?.id].includes(t.id));
  if (free) assert.equal(free.status, "free");
});

await test("a party that has left frees the table", () => {
  const spare = restaurant.restaurant!.tables.at(-1)!;
  const other = "2027-03-12";
  booking({ date: other, tableIds: [spare.id], startMin: 17 * 60, endMin: 18 * 60, status: "completed", service: { arrivedAt: "a", seatedAt: "b", leftAt: "c" } });
  assert.equal(floorState(getLocation(restaurant.id)!, other, 17 * 60 + 30).find((t) => t.id === spare.id)!.status, "free");
});

await test("an arranged layout is saved and survives a normal save of the room", () => {
  const arranged = applyLayout(getLocation(restaurant.id)!, [{ id: t1.id, x: 420, y: 260, shape: "round" }]);
  const kept = coerceRestaurant(arranged.restaurant, arranged.restaurant!);
  const table = kept.tables.find((t) => t.id === t1.id)!;
  assert.deepEqual(table.layout, { x: 420, y: 260, shape: "round" });
  upsertLocation({ ...arranged, restaurant: kept });
  const state = floorState(getLocation(restaurant.id)!, day, 12 * 60).find((t) => t.id === t1.id)!;
  assert.equal(state.x, 420);
  assert.equal(state.placed, true);
});

console.log("\n\x1b[1mReports and exports\x1b[0m\n");

await test("a report splits bookings by Belle and the desk, and counts covers and no-shows", () => {
  booking({ tableIds: [t2.id], startMin: 13 * 60, source: "manual", partySize: 4 });
  booking({ tableIds: [t3.id], startMin: 13 * 60, status: "no_show" });
  const report = buildReport(getLocation(restaurant.id)!, day, day, "2027-03-11");
  assert.equal(report.bookings.total, t4 ? 6 : 5);
  assert.ok(report.bookings.atDesk >= 1);
  assert.equal(report.bookings.byBelle, report.bookings.total - report.bookings.atDesk);
  assert.equal(report.bookings.noShows, 1);
  assert.ok(report.bookings.noShowRate !== null && report.bookings.noShowRate > 0);
  assert.ok(report.bookings.covers >= 4);
  assert.equal(report.byWeekday.reduce((a, b) => a + b, 0), report.bookings.total - report.bookings.noShows - report.bookings.cancelled);
});

await test("CSV cells with commas, quotes or formulas are escaped", () => {
  assert.equal(csv([["a,b", 'say "hi"', "=1+1", 5]]), `"a,b","say ""hi""",'=1+1,5\r\n`);
});

await test("the bookings export has one row per booking in the range, and nothing outside it", () => {
  const out = exportCsv(getLocation(restaurant.id)!, "bookings", day, day);
  const lines = out.trim().split("\r\n");
  assert.match(lines[0], /^reference,date,time,guest/);
  assert.ok(lines.slice(1).every((l) => l.includes(day)));
  assert.equal(exportCsv(getLocation(restaurant.id)!, "bookings", "2030-01-01", "2030-01-02").trim().split("\r\n").length, 1);
});

console.log("\n\x1b[1mRota\x1b[0m\n");

const salon = listLocations().find((l) => l.salon && l.salon.staff.length >= 1 && l.salon.services.length >= 1)!;
const person = salon.salon!.staff[0];
const monday = addDays(todayIn(salon.timezone), 14);

await test("the week shows everyone's usual hours until a day is changed", () => {
  const rows = weekRota(salon, monday);
  assert.equal(rows.length, salon.salon!.staff.length);
  assert.equal(rows[0].days.length, 7);
});

await test("a different shift replaces the usual hours for that day only", () => {
  const out = applyRotaChange(salon, { kind: "shift", staffId: person.id, date: monday, ranges: [{ start: 12 * 60, end: 16 * 60 }] });
  assert.ok(out.ok);
  const changed = out.ok ? out.person : person;
  assert.deepEqual(staffWorkingRanges(changed, monday), [{ start: 720, end: 960 }]);
  assert.deepEqual(staffWorkingRanges(changed, addDays(monday, 7)), staffWorkingRanges(person, addDays(monday, 7)));
});

await test("a day off is an empty shift, and 'usual' removes it again", () => {
  const off = applyRotaChange(salon, { kind: "shift", staffId: person.id, date: monday, ranges: [] });
  assert.ok(off.ok);
  assert.deepEqual(staffWorkingRanges(off.ok ? off.person : person, monday), []);
  const back = applyRotaChange(off.ok ? off.location : salon, { kind: "usual", staffId: person.id, date: monday });
  assert.ok(back.ok);
  assert.deepEqual(staffWorkingRanges(back.ok ? back.person : person, monday), staffWorkingRanges(person, monday));
});

await test("time off takes a stretch out of the day", () => {
  const shift = applyRotaChange(salon, { kind: "shift", staffId: person.id, date: monday, ranges: [{ start: 540, end: 1080 }] });
  assert.ok(shift.ok);
  const off = applyRotaChange(shift.ok ? shift.location : salon, { kind: "time_off", staffId: person.id, date: monday, start: 780, end: 840 });
  assert.ok(off.ok);
  assert.deepEqual(staffWorkingRanges(off.ok ? off.person : person, monday), [{ start: 540, end: 780 }, { start: 840, end: 1080 }]);
});

await test("bad hours are refused", () => {
  assert.equal(applyRotaChange(salon, { kind: "shift", staffId: person.id, date: monday, ranges: [{ start: 900, end: 600 }] }).ok, false);
  assert.equal(applyRotaChange(salon, { kind: "shift", staffId: "nobody", date: monday, ranges: [] }).ok, false);
});

await test("a booking left outside the new hours is reported, not moved", () => {
  saveBooking({
    id: "bk_rota_1", ref: "ROTA1", locationId: salon.id, vertical: salon.vertical, status: "confirmed", date: monday,
    startMin: 10 * 60, endMin: 11 * 60, guestName: "Stranded Sara", guestPhone: "+971500001234", notes: "",
    serviceIds: [salon.salon!.services[0].id], staffId: person.id, source: "manual", createdAt: new Date().toISOString(),
  } as never);
  const out = applyRotaChange(salon, { kind: "shift", staffId: person.id, date: monday, ranges: [{ start: 14 * 60, end: 18 * 60 }] });
  assert.ok(out.ok);
  const stranded = strandedBookings(out.ok ? out.location : salon, out.ok ? out.person : person, monday);
  assert.deepEqual(stranded.map((b) => b.id), ["bk_rota_1"]);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
