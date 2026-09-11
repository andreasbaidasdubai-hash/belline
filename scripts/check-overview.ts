/**
 * The home page's arithmetic.
 *
 * Two things here would embarrass us if they were wrong in front of an
 * operator: claiming a call came in after hours when the venue was open, and
 * showing a money figure nobody entered. Both are tested hardest.
 *
 *   npm run check:overview
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-over-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, saveCall, upsertLocation, getLocation } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { overviewFor, summarise } = await import("../src/lib/overview");

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
const salon = listLocations().find((l) => l.vertical === "salon")!;

/** A completed call at a given hour today, in the venue's own timezone. */
function callAt(hour: number, outcome: Parameters<typeof saveCall>[0]["outcome"]) {
  const call = startCall(salon, "phone", "+441234567890");
  const now = new Date();
  const local = new Date(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: salon.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now) + `T${String(hour).padStart(2, "0")}:30:00`,
  );
  return saveCall({
    ...call,
    startedAt: local.toISOString(),
    endedAt: local.toISOString(),
    status: "completed",
    outcome,
  });
}

console.log("\nWhat it did today\n");

callAt(11, "booking_created");
callAt(12, "booking_created");
callAt(13, "booking_changed");
callAt(14, "answered_question");
callAt(15, "message_taken");

test("outcomes are counted, not just calls", () => {
  const { did } = overviewFor(salon);
  assert.equal(did.booked, 2, `booked: ${did.booked}`);
  assert.equal(did.moved, 1);
  assert.equal(did.questions, 1);
  assert.equal(did.messages, 1);
  assert.ok(did.answered >= 5);
});

test("the sentence leads with what was taken, not the call count alone", () => {
  const { did } = overviewFor(salon);
  const line = summarise(salon, did);
  assert.match(line, /answered/);
  assert.match(line, /appointments? taken|2 appointments/i, `got: ${line}`);
});

test("an empty day says so plainly rather than showing zeroes", () => {
  const empty = listLocations().find((l) => l.vertical === "clinic")!;
  const line = summarise(empty, overviewFor(empty).did);
  assert.match(line, /Nothing yet today/);
});

console.log("\nAfter hours is a claim we have to be right about\n");

/** Whether the venue's own opening hours cover this hour, today. */
function openAt(hour: number): boolean {
  const weekday = new Date(
    new Intl.DateTimeFormat("en-CA", { timeZone: salon.timezone }).format(new Date()) + "T12:00:00Z",
  ).getUTCDay();
  return (salon.hours[weekday] ?? []).some(
    (r) => hour * 60 + 30 >= r.start && hour * 60 + 30 < r.end,
  );
}

test("the after-hours count follows the venue's own opening hours", () => {
  // Not a hardcoded "midday is open" — that is only true on the days the salon
  // trades, and a test that passes six days in seven is worse than no test.
  const before = overviewFor(salon).did.outsideHours;
  callAt(12, "answered_question");
  const after = overviewFor(salon).did.outsideHours;
  assert.equal(
    after,
    openAt(12) ? before : before + 1,
    `a 12:30 call was counted wrongly (venue ${openAt(12) ? "open" : "shut"} at that hour today)`,
  );
});

test("a call at three in the morning is after hours", () => {
  const before = overviewFor(salon).did.outsideHours;
  callAt(3, "answered_question");
  const after = overviewFor(salon).did.outsideHours;
  assert.equal(after, before + 1, "a 3am call was not counted as out of hours");
});

test("a demo call is never counted at all", () => {
  const before = overviewFor(salon).did.answered;
  const call = callAt(12, "booking_created");
  saveCall({ ...call, isDemo: true });
  assert.equal(
    overviewFor(salon).did.answered,
    before,
    "a demo-line call was counted as the venue's own work",
  );
});

console.log("\nMoney is only ever the venue's own number\n");

test("no estimate is shown when none was entered", () => {
  const { worth } = overviewFor(salon);
  assert.equal(worth.estimate, null, "an estimate appeared from nowhere");
});

test("an estimate appears once the venue enters a value", () => {
  const fresh = getLocation(salon.id)!;
  upsertLocation({ ...fresh, averageBookingValue: 80 });
  const { worth } = overviewFor(getLocation(salon.id)!);
  if (worth.bookings === 0) {
    assert.equal(worth.estimate, 0);
    return;
  }
  assert.equal(worth.estimate, worth.bookings * 80);
});

test("zero is never shown in place of unknown", () => {
  const fresh = getLocation(salon.id)!;
  upsertLocation({ ...fresh, averageBookingValue: 0 });
  assert.equal(
    overviewFor(getLocation(salon.id)!).worth.estimate,
    null,
    "a venue with no value entered was shown a figure",
  );
});

console.log("\nHealth\n");

test("silence is reported, because nobody notices it otherwise", () => {
  const { health } = overviewFor(salon);
  const arriving = health.find((h) => h.label === "Calls arriving");
  assert.ok(arriving, "nothing checks whether calls are still coming in");
});

test("every check says what is wrong, not just that something is", () => {
  for (const h of overviewFor(salon).health) {
    assert.ok(h.detail.length > 3, `${h.label} has no detail`);
  }
});

test("a run of hang-ups is flagged, not reported as healthy", () => {
  const quiet = listLocations().find((l) => l.vertical === "clinic")!;
  const find = () => overviewFor(quiet).health.find((h) => h.label === "Calls completing")!;

  // Below the floor we say nothing — one hang-up out of two is noise.
  const call = startCall(quiet, "phone", "+441234000001");
  saveCall({ ...call, status: "completed", outcome: "abandoned", endedAt: new Date().toISOString() });
  assert.equal(find().ok, true, "flagged a pattern from a single call");

  for (let i = 0; i < 6; i++) {
    const c = startCall(quiet, "phone", `+44123400001${i}`);
    saveCall({ ...c, status: "completed", outcome: "abandoned", endedAt: new Date().toISOString() });
  }
  const bad = find();
  assert.equal(bad.ok, false, "seven callers in a row rang off and nothing was flagged");
  assert.match(bad.detail, /rang off/);
});

test("hang-ups are said out loud in the summary, not hidden in the total", () => {
  const quiet = listLocations().find((l) => l.vertical === "clinic")!;
  const line = summarise(quiet, overviewFor(quiet).did);
  assert.match(line, /rang off/, `got: ${line}`);
});

console.log("\nWhat needs a person\n");

test("the count is one venue's, and says so", () => {
  const { needsYou } = overviewFor(salon);
  assert.equal(typeof needsYou.total, "number");
  for (const item of [needsYou.top].filter(Boolean)) {
    assert.equal(item!.locationId, salon.id, "an item from another venue was counted");
  }
});

test("the most urgent item comes with something to do about it", () => {
  const { needsYou } = overviewFor(salon);
  if (!needsYou.top) return;
  assert.ok(needsYou.top.todo.length > 3, "the top item has no action");
  assert.ok(needsYou.top.who.length > 0, "the top item has nobody attached");
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
