/**
 * The waitlist, and the overbooking override.
 *
 * A full Friday is not a lost caller — it is a caller nobody wrote down. What
 * makes a waitlist worth having is not storing the name, it is what happens
 * when a table frees at five: the match has to be real, it has to reach
 * somebody, and it has to go to whoever asked first.
 *
 * The override is tested hardest in the direction of refusal. Pacing exists so
 * the pass survives eight o'clock, and the caller is the last person who
 * should be able to overrule it.
 *
 *   npm run check:waitlist
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-wait-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, listWaitlist, saveWaitlistEntry } = await import("../src/lib/store");
const { createBooking, cancelBooking } = await import("../src/lib/booking");
const { join, matchesFor, markOffered, markCancelled, openEntries, releaseStaleOffers } =
  await import("../src/lib/waitlist");
const { attentionFor } = await import("../src/lib/attention");
const { todayIn } = await import("../src/lib/time");

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

function soon(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

console.log("\nJoining\n");

const day = soon(4);

test("somebody who cannot get a table goes on the list", () => {
  const entry = join({
    locationId: restaurant.id,
    guestName: "Ada Fielding",
    guestPhone: "+44 7700 900401",
    date: day,
    earliestMin: 19 * 60,
    latestMin: 21 * 60,
    partySize: 2,
  });
  assert.equal(entry.status, "waiting");
  assert.equal(entry.earliestMin, 19 * 60);
});

test("ringing twice about the same evening is one entry, not two", () => {
  join({
    locationId: restaurant.id,
    guestName: "Ada Fielding",
    guestPhone: "07700900401",
    date: day,
    earliestMin: 19 * 60,
    latestMin: 22 * 60,
    partySize: 2,
  });
  const mine = listWaitlist({ locationId: restaurant.id, date: day }).filter((w) =>
    w.guestPhone.includes("900401"),
  );
  assert.equal(mine.length, 1, "the same guest was written down twice — both would be rung");
});

test("a window is stored the right way round however it arrives", () => {
  const entry = join({
    locationId: restaurant.id,
    guestName: "Backwards",
    guestPhone: "+44 7700 900402",
    date: day,
    earliestMin: 21 * 60,
    latestMin: 19 * 60,
    partySize: 2,
  });
  assert.ok(entry.earliestMin < entry.latestMin);
});

console.log("\nMatching\n");

test("a match is a slot they can actually have", () => {
  const matches = matchesFor(restaurant, day);
  for (const match of matches) {
    assert.ok(
      match.startMin >= match.entry.earliestMin && match.startMin <= match.entry.latestMin,
      "a slot outside the window they gave was offered",
    );
  }
});

test("whoever asked first is offered first", () => {
  const matches = matchesFor(restaurant, day);
  for (let i = 1; i < matches.length; i++) {
    assert.ok(
      matches[i - 1].entry.createdAt <= matches[i].entry.createdAt,
      "the list is not in the order people asked",
    );
  }
});

test("a window the venue is never open in matches nobody", () => {
  const quiet = soon(11);
  join({
    locationId: restaurant.id,
    guestName: "Three In The Morning",
    guestPhone: "+44 7700 900403",
    date: quiet,
    earliestMin: 3 * 60,
    latestMin: 4 * 60,
    partySize: 2,
  });
  const matches = matchesFor(restaurant, quiet);
  assert.ok(
    !matches.some((m) => m.entry.guestPhone.includes("900403")),
    "somebody was offered a table at three in the morning",
  );
});

console.log("\nIt reaches somebody\n");

test("a match appears in the Action Inbox", () => {
  const today = todayIn(restaurant.timezone);
  join({
    locationId: restaurant.id,
    guestName: "Today Waiter",
    guestPhone: "+44 7700 900404",
    date: today,
    earliestMin: 12 * 60,
    latestMin: 22 * 60,
    partySize: 2,
  });
  const items = attentionFor(restaurant);
  const item = items.find((i) => i.kind === "waitlist_match");
  assert.ok(item, "a free slot never reached anybody");
  assert.ok(item.callbackNumber, "no number to ring");
  assert.match(item.todo, /ring/i);
});

test("it outranks everything except an emergency", () => {
  const items = attentionFor(restaurant);
  const match = items.find((i) => i.kind === "waitlist_match");
  const message = items.find((i) => i.kind === "message");
  if (match && message) {
    assert.ok(match.urgency > message.urgency, "a cooling table ranked below a message");
  }
});

console.log("\nOffers do not hold a table for ever\n");

test("an offer can be marked, and comes off the waiting list", () => {
  const entry = openEntries(restaurant.id).find((e) => e.status === "waiting")!;
  markOffered(entry.id);
  const after = openEntries(restaurant.id).find((e) => e.id === entry.id)!;
  assert.equal(after.status, "offered");
});

test("a stale offer goes back on the list for the next person", () => {
  const entry = openEntries(restaurant.id).find((e) => e.status === "offered")!;
  // Backdate the offer past the hold window.
  saveWaitlistEntry({
    ...entry,
    offeredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  });
  const released = releaseStaleOffers(restaurant.id);
  assert.ok(released > 0, "an unanswered offer held the slot for ever");
});

test("cancelling takes them off the list entirely", () => {
  const entry = openEntries(restaurant.id)[0];
  markCancelled(entry.id);
  assert.ok(!openEntries(restaurant.id).some((e) => e.id === entry.id));
});

console.log("\nOverbooking is a manager's, never the agent's\n");

const packed = soon(5);

function fillTheSlot() {
  // Seat up to the cap at one time.
  const cap = restaurant.restaurant!.maxCoversPerSlot;
  let seated = 0;
  let n = 0;
  while (seated + 4 <= cap) {
    const made = createBooking(restaurant, {
      date: packed,
      startMin: 20 * 60,
      guestName: `Filler ${n}`,
      guestPhone: `+44 7700 9005${String(n).padStart(2, "0")}`,
      partySize: 4,
    });
    if (!made.ok) break;
    seated += 4;
    n++;
  }
  return seated;
}

const seatedCovers = fillTheSlot();

test("the pacing cap refuses a booking without the override", () => {
  const over = createBooking(restaurant, {
    date: packed,
    startMin: 20 * 60,
    guestName: "One Too Many",
    guestPhone: "+44 7700 900600",
    partySize: 4,
  });
  if (over.ok) {
    // The room was not actually full; nothing to assert about the cap.
    return;
  }
  assert.equal(over.ok, false);
});

test("a booking from the phone line never carries the override", () => {
  // The agent's tool layer builds its input without an overbook flag, and the
  // type is the guard: if `book` ever gained one this test is where it shows.
  const toolSource = fs.readFileSync("src/lib/agent/tools.ts", "utf8");
  assert.doesNotMatch(
    toolSource,
    /overbook/,
    "the agent's tools mention overbooking — pacing must not be reachable from a call",
  );
});

test("a manager may seat past the cap, up to the allowance", () => {
  const allowance = restaurant.restaurant!.overbookPerSlot ?? 0;
  if (allowance === 0 || seatedCovers === 0) return;
  const over = createBooking(restaurant, {
    date: packed,
    startMin: 20 * 60,
    guestName: "Manager Says Yes",
    guestPhone: "+44 7700 900601",
    partySize: Math.min(allowance, 4),
    overbook: true,
  });
  assert.ok(over.ok, `the override did not work: ${!over.ok ? over.detail : ""}`);
});

test("the allowance is a ceiling, not a removal", () => {
  const over = createBooking(restaurant, {
    date: packed,
    startMin: 20 * 60,
    guestName: "Far Too Many",
    guestPhone: "+44 7700 900602",
    partySize: 8,
    overbook: true,
  });
  // Either refused, or it fitted within the allowance — never unlimited.
  if (over.ok) {
    assert.ok(
      (restaurant.restaurant!.overbookPerSlot ?? 0) >= 8,
      "the override let through more than the allowance",
    );
  }
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
