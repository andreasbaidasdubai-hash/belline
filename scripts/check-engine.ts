/**
 * Booking engine v2 — the parts a demo will never exercise.
 *
 * `npm run check` holds down the original engine: tables, turns, pacing,
 * qualified staff, buffers. This file holds down everything added to make it
 * stand next to SevenRooms, Fresha and a real clinic diary — processing gaps,
 * level pricing, second practitioners, reset times, section limits, the house
 * rules, deposits, quote holds and recall.
 *
 * Every one of these is a rule somebody will discover is wrong on a Saturday
 * night, in front of a guest, if it is not checked here.
 *
 *   npm run check:engine
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Booking, Location, Minutes } from "../src/lib/types";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "belline-engine-"));
process.env.DATA_DIR = scratch;

const { checkRestaurantSlot } = await import("../src/lib/booking/restaurant");
const staffHelpers = await import("../src/lib/booking/salon");
const { checkSalonSlot, searchSalon, quoteFor } = staffHelpers;
const { serviceShape } = await import("../src/lib/booking/services");
const { createBooking, cancelBooking, findAvailability } = await import("../src/lib/booking");
const { checkPolicy, depositFor, isLateCancel, noticeMinutes } = await import(
  "../src/lib/booking/policy"
);
const { holdSlot, releaseCall, clearHolds } = await import("../src/lib/booking/holds");
const { rankSlots } = await import("../src/lib/booking/ranking");
const { recallDue, recallSummary } = await import("../src/lib/booking/recall");
const { dayView } = await import("../src/lib/calendar");
const { addDays, todayIn } = await import("../src/lib/time");
const store = await import("../src/lib/store");

const { restaurant, salon, clinic } = await loadFixtures();

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

const H = (h: number, m = 0) => h * 60 + m;

// A Wednesday, far enough out that nothing is in the past.
const WED = "2026-09-16";

function booking(location: Location, over: Partial<Booking>): Booking {
  return {
    id: `bk_${Math.random().toString(16).slice(2)}`,
    ref: "TEST",
    locationId: location.id,
    vertical: location.vertical,
    status: "confirmed",
    date: WED,
    startMin: H(12),
    endMin: H(14),
    guestName: "Test",
    guestPhone: "+100",
    notes: "",
    source: "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * A real future date the venue is actually open on, and on which the named
 * person is working.
 *
 * "Today plus fourteen" drifts across the week as the calendar turns, so a
 * test written against it passes in September and fails in October when that
 * offset lands on the clinic's Friday. This walks forward until the diary can
 * take it.
 */
function workingDay(location: Location, staffId: string, from = 10): string {
  const { staffWorkingRanges } = staffHelpers;
  const staff = location.salon!.staff.find((s) => s.id === staffId)!;
  let date = addDays(todayIn(location.timezone), from);
  for (let i = 0; i < 14; i++) {
    const open = (location.hours[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? []).length > 0;
    if (open && !location.closures.includes(date) && staffWorkingRanges(staff, date).length > 0) {
      return date;
    }
    date = addDays(date, 1);
  }
  throw new Error(`${staff.name} never works in the next fortnight`);
}

/** A venue with one field changed, for testing a setting against its absence. */
function tweak(location: Location, patch: (l: Location) => Location): Location {
  return patch(structuredClone(location));
}

// ---------------------------------------------------------------------------
console.log("\nProcessing time — the gap inside an appointment");
// ---------------------------------------------------------------------------

test("a phased service frees the stylist while the colour develops", () => {
  const shape = serviceShape(salon.salon!, ["colour_root"]);
  assert.equal(shape.durationMin, 90);
  assert.deepEqual(
    shape.staffBusy,
    [
      { start: 0, end: 30 },
      { start: 70, end: 110 },
    ],
    "the developing stretch is still being charged to the stylist",
  );
});

test("an ordinary service is still one solid block", () => {
  const shape = serviceShape(salon.salon!, ["blowdry"]);
  assert.deepEqual(shape.staffBusy, [{ start: 0, end: 55 }]);
});

test("a second guest goes into the gap when the salon allows it", () => {
  const existing = [
    booking(salon, {
      startMin: H(10),
      endMin: H(11, 50),
      staffId: "st_aisha",
      resourceId: "cs1",
      serviceIds: ["colour_root"],
    }),
  ];
  const result = checkSalonSlot(salon, existing, {
    date: WED,
    startMin: H(10, 30),
    serviceIds: ["consult"],
    staffId: "st_aisha",
  });
  assert(result.ok, `the gap was not sold: ${JSON.stringify(result)}`);
  assert.equal(result.assignment.staffId, "st_aisha");
});

test("with dovetailing off the gap belongs to nobody", () => {
  const strict = tweak(salon, (l) => {
    l.salon!.dovetail = false;
    return l;
  });
  const existing = [
    booking(strict, {
      startMin: H(10),
      endMin: H(11, 50),
      staffId: "st_aisha",
      resourceId: "cs1",
      serviceIds: ["colour_root"],
    }),
  ];
  const result = checkSalonSlot(strict, existing, {
    date: WED,
    startMin: H(10, 30),
    serviceIds: ["consult"],
    staffId: "st_aisha",
  });
  assert(!result.ok, "double-booked a stylist who had not opted in");
});

test("the chair is held through the gap even though the stylist is not", () => {
  // Both colour stations busy through the developing stretch; a third colour
  // must fail on the room, not succeed because somebody looked free.
  const existing = [
    booking(salon, { startMin: H(10), endMin: H(11, 50), staffId: "st_aisha", resourceId: "cs1", serviceIds: ["colour_root"] }),
    booking(salon, { startMin: H(10), endMin: H(11, 50), staffId: "st_marie", resourceId: "cs2", serviceIds: ["colour_root"] }),
  ];
  const result = checkSalonSlot(salon, existing, {
    date: WED,
    startMin: H(10, 45),
    serviceIds: ["colour_root"],
  });
  assert(!result.ok, "a third client was sat at a station that is in use");
});

test("the calendar draws the gap rather than one solid bar", () => {
  const day = addDays(todayIn(salon.timezone), 9);
  const made = createBooking(salon, {
    date: day,
    startMin: H(10),
    guestName: "Gap Test",
    guestPhone: "+41 79 000 0001",
    serviceIds: ["colour_root"],
    staffId: "st_aisha",
    staffOverride: true,
  });
  if (!made.ok) return; // Aisha may not work that weekday; nothing to assert.
  const block = dayView(salon, day).blocks.find((b) => b.booking.id === made.booking.id);
  assert.ok(block, "the appointment is not on the grid");
  assert.ok(block.busy && block.busy.length === 2, "the processing gap is not drawn");
});

// ---------------------------------------------------------------------------
console.log("\nLevel pricing — the same service is not the same service");
// ---------------------------------------------------------------------------

test("a senior stylist's own timing and price are used", () => {
  const senior = quoteFor(salon.salon!, salon.salon!.services.find((s) => s.id === "cut_w")!, "st_marie");
  const list = quoteFor(salon.salon!, salon.salon!.services.find((s) => s.id === "cut_w")!, "st_jonas");
  assert.equal(senior.durationMin, 45);
  assert.equal(senior.price, 165);
  assert.equal(list.durationMin, 60);
  assert.equal(list.price, 130);
});

test("the quoted price follows whoever is actually assigned", () => {
  const result = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["cut_w"],
    staffId: "st_marie",
  });
  assert(result.ok);
  assert.equal(result.assignment.price, 165, "quoted the wall price for a senior");
  assert.equal(result.assignment.endMin - result.assignment.startMin, 45);
});

test("a first visit gets the longer appointment", () => {
  const returning = checkSalonSlot(clinic, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["dent_consult"],
    staffId: "dr_haddad",
  });
  const first = checkSalonSlot(clinic, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["dent_consult"],
    staffId: "dr_haddad",
    newGuest: true,
  });
  assert(returning.ok && first.ok);
  assert.equal(returning.assignment.durationMin, 30);
  assert.equal(first.assignment.durationMin, 45, "a new patient was booked as a returning one");
});

// ---------------------------------------------------------------------------
console.log("\nShifts, breaks and the rota");
// ---------------------------------------------------------------------------

test("an appointment may not run through somebody's lunch", () => {
  // Marie breaks 13:00–13:45; her cut is 45 minutes.
  const result = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(12, 45),
    serviceIds: ["cut_w"],
    staffId: "st_marie",
  });
  assert(!result.ok, "booked straight through a break");
});

test("the same appointment is fine the moment the break ends", () => {
  const result = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(13, 45),
    serviceIds: ["cut_w"],
    staffId: "st_marie",
  });
  assert(result.ok, `refused a slot right after the break: ${JSON.stringify(result)}`);
});

test("a rota entry beats the weekly pattern", () => {
  const rota = tweak(salon, (l) => {
    const marie = l.salon!.staff.find((s) => s.id === "st_marie")!;
    marie.shifts = [{ date: WED, ranges: [{ start: H(16), end: H(19) }] }];
    return l;
  });
  const morning = checkSalonSlot(rota, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["cut_w"],
    staffId: "st_marie",
  });
  const evening = checkSalonSlot(rota, [], {
    date: WED,
    startMin: H(16, 30),
    serviceIds: ["cut_w"],
    staffId: "st_marie",
  });
  assert(!morning.ok, "ignored the rota and used the weekly pattern");
  assert(evening.ok, `refused a slot inside the rostered shift: ${JSON.stringify(evening)}`);
});

test("an empty rota entry is a day off, not a missing pattern", () => {
  const off = tweak(salon, (l) => {
    l.salon!.staff.find((s) => s.id === "st_marie")!.shifts = [{ date: WED, ranges: [] }];
    return l;
  });
  const result = checkSalonSlot(off, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["cut_w"],
    staffId: "st_marie",
  });
  assert(!result.ok, "booked somebody who was rostered off");
});

// ---------------------------------------------------------------------------
console.log("\nRooms, machines and second practitioners");
// ---------------------------------------------------------------------------

test("a treatment needing two things holds both", () => {
  const shape = serviceShape(clinic.salon!, ["whitening"]);
  assert.deepEqual(shape.resourceTypes.sort(), ["surgery", "whitening_lamp"]);
});

test("the scarcer of the two is the one that binds", () => {
  // Two surgeries, one lamp. The second whitening must fail even though a
  // surgery is free — the bug the old single-resource field could not see.
  const existing = [
    booking(clinic, {
      startMin: H(11, 30),
      endMin: H(13),
      staffId: "dr_haddad",
      resourceIds: ["surg1", "lamp1"],
      resourceId: "surg1",
      serviceIds: ["whitening"],
    }),
  ];
  const result = checkSalonSlot(clinic, existing, {
    date: WED,
    startMin: H(11, 30),
    serviceIds: ["whitening"],
    staffId: "dr_novak",
  });
  assert(!result.ok && result.reason === "no_resource", `expected no_resource, got ${JSON.stringify(result)}`);
});

test("a hygiene visit pulls a dentist in for the exam", () => {
  const result = checkSalonSlot(clinic, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["hygiene"],
    staffId: "nurse_rana",
  });
  assert(result.ok, `hygiene not bookable: ${JSON.stringify(result)}`);
  assert.ok(result.assignment.secondaryStaffId, "nobody was assigned to the exam");
  const dentist = clinic.salon!.staff.find((s) => s.id === result.assignment.secondaryStaffId);
  assert.equal(dentist?.role, "dentist", "the exam was given to somebody who cannot do it");
});

test("the exam is ten minutes of the dentist, not the whole hour", () => {
  const shape = serviceShape(clinic.salon!, ["hygiene"]);
  assert.equal(shape.secondary.length, 1);
  assert.equal(shape.secondary[0].end - shape.secondary[0].start, 10);
});

test("no dentist free means no hygiene appointment", () => {
  // Dr Novak starts at 11:00, so at 10:00 Dr Haddad is the only dentist —
  // occupy him and the slot has nobody to do the exam.
  const existing = [
    booking(clinic, {
      startMin: H(9, 30),
      endMin: H(11, 30),
      staffId: "dr_haddad",
      resourceId: "surg1",
      serviceIds: ["root_canal"],
    }),
  ];
  const result = checkSalonSlot(clinic, existing, {
    date: WED,
    startMin: H(10),
    serviceIds: ["hygiene"],
    staffId: "nurse_rana",
  });
  assert(
    !result.ok && result.reason === "no_secondary",
    `expected no_secondary, got ${JSON.stringify(result)}`,
  );
});

test("a dentist running the appointment does their own exam", () => {
  const result = checkSalonSlot(clinic, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["hygiene"],
    staffId: "dr_haddad",
  });
  assert(result.ok, `a dentist could not take a hygiene appointment: ${JSON.stringify(result)}`);
  assert.equal(
    result.assignment.secondaryStaffId,
    undefined,
    "took a second dentist out for an exam the first one was already doing",
  );
});

test("a role on a service is harder than the qualification list", () => {
  // Rana is trained on skin treatments but injectables are prescription-only.
  const result = checkSalonSlot(clinic, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["injectables"],
    staffId: "nurse_rana",
  });
  assert(!result.ok && result.reason === "no_staff");
});

// ---------------------------------------------------------------------------
console.log("\nWhat the agent may not sell");
// ---------------------------------------------------------------------------

test("an add-on cannot be booked as a visit on its own", () => {
  const alone = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["gloss"],
    staffId: "st_aisha",
  });
  assert(!alone.ok && alone.reason === "not_bookable");
});

test("the same add-on is fine attached to something", () => {
  const attached = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["colour_root", "gloss"],
    staffId: "st_aisha",
  });
  assert(attached.ok, `refused a colour with a gloss: ${JSON.stringify(attached)}`);
  assert.equal(attached.assignment.price, 235);
});

test("a request-only stylist is invisible until asked for by name", () => {
  const guarded = tweak(salon, (l) => {
    for (const person of l.salon!.staff) person.requestOnly = person.id !== "st_marie";
    return l;
  });
  const anyone = checkSalonSlot(guarded, [], { date: WED, startMin: H(10), serviceIds: ["cut_w"] });
  assert(anyone.ok && anyone.assignment.staffId === "st_marie", "offered somebody request-only");

  const byName = checkSalonSlot(guarded, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["cut_w"],
    staffId: "st_aisha",
  });
  assert(byName.ok, "refused a stylist the guest asked for by name");
});

// ---------------------------------------------------------------------------
console.log("\nThe restaurant floor");
// ---------------------------------------------------------------------------

test("a table is not promised before it has been cleared", () => {
  // Lunch: a party of eight on the only 8-top, 12:00 to 13:45, plus ten
  // minutes to reset.
  const existing = [
    booking(restaurant, { startMin: H(12), endMin: H(13, 45), partySize: 8, tableIds: ["t8"] }),
  ];
  const tooSoon = checkRestaurantSlot(restaurant, existing, {
    date: WED,
    startMin: H(13, 45),
    partySize: 8,
  });
  assert(
    !tooSoon.ok || !tooSoon.assignment.tableIds.includes("t8"),
    "seated a party at a table still being cleared",
  );

  const clear = checkRestaurantSlot(restaurant, existing, {
    date: WED,
    startMin: H(13, 55),
    partySize: 8,
  });
  assert(clear.ok && clear.assignment.tableIds.includes("t8"), "the table never came back");
});

test("three tables are pushed together when two will not do", () => {
  const blockers = ["t8", "t7", "t5", "t6"].map((id) =>
    booking(restaurant, { startMin: H(12), endMin: H(14), partySize: 1, tableIds: [id] }),
  );
  const result = checkRestaurantSlot(restaurant, blockers, {
    date: WED,
    startMin: H(13),
    partySize: 8,
  });
  assert(result.ok, `no combination found: ${JSON.stringify(result)}`);
  assert.equal(result.assignment.tableIds.length, 3);
});

test("a venue that only pushes two together is not given three", () => {
  const pairsOnly = tweak(restaurant, (l) => {
    l.restaurant!.maxCombine = 2;
    return l;
  });
  const blockers = ["t8", "t7", "t5", "t6"].map((id) =>
    booking(pairsOnly, { startMin: H(12), endMin: H(14), partySize: 1, tableIds: [id] }),
  );
  const result = checkRestaurantSlot(pairsOnly, blockers, {
    date: WED,
    startMin: H(13),
    partySize: 8,
  });
  assert(!result.ok && result.reason === "no_table");
});

test("only tables that actually push together are combined", () => {
  // Everything gone but the two terrace tables that do not join.
  const free = ["t20", "t22"];
  const blockers = restaurant
    .restaurant!.tables.filter((t) => !free.includes(t.id))
    .map((t) => booking(restaurant, { startMin: H(12), endMin: H(14), partySize: 1, tableIds: [t.id] }));
  const result = checkRestaurantSlot(restaurant, blockers, {
    date: WED,
    startMin: H(13),
    partySize: 4,
  });
  // t22 seats four on its own, so this must be the single, never the pair.
  assert(result.ok && result.assignment.tableIds.length === 1, "pushed two tables that do not meet");
});

test("a section may run out before the room does", () => {
  // The terrace paces at eight covers a slot; the ninth goes inside.
  const existing = [
    booking(restaurant, { startMin: H(20), endMin: H(22), partySize: 4, tableIds: ["t23"] }),
    booking(restaurant, { startMin: H(20), endMin: H(22), partySize: 4, tableIds: ["t22"] }),
  ];
  const result = checkRestaurantSlot(restaurant, existing, {
    date: WED,
    startMin: H(20),
    partySize: 2,
  });
  assert(result.ok);
  assert.notEqual(result.assignment.section, "Terrace", "seated past the terrace's own cap");
});

test("the chef's counter is never given away by the agent", () => {
  const blockers = restaurant
    .restaurant!.tables.filter((t) => t.section !== "Counter")
    .map((t) => booking(restaurant, { startMin: H(12), endMin: H(14), partySize: 1, tableIds: [t.id] }));
  const agent = checkRestaurantSlot(restaurant, blockers, {
    date: WED,
    startMin: H(13),
    partySize: 4,
  });
  assert(!agent.ok, "the agent sold the counter");

  const manager = checkRestaurantSlot(restaurant, blockers, {
    date: WED,
    startMin: H(13),
    partySize: 4,
    staffOverride: true,
  });
  assert(manager.ok && manager.assignment.section === "Counter", "a manager could not seat it either");
});

test("the dining room is filled before the terrace", () => {
  const result = checkRestaurantSlot(restaurant, [], { date: WED, startMin: H(20), partySize: 2 });
  assert(result.ok);
  assert.equal(result.assignment.section, "Main");
});

test("a table out of play is not offered", () => {
  const withBlock = tweak(restaurant, (l) => {
    l.restaurant!.blocks = [
      { id: "blk1", date: WED, tableIds: ["t8"], startMin: H(12), endMin: H(16), reason: "Wobbly leg" },
    ];
    return l;
  });
  const result = checkRestaurantSlot(withBlock, [], { date: WED, startMin: H(13), partySize: 8 });
  assert(
    !result.ok || !result.assignment.tableIds.includes("t8"),
    "seated a party at a table taken out of service",
  );
});

test("covers held back for walk-ins are invisible to the phone", () => {
  const holdback = tweak(restaurant, (l) => {
    const dinner = l.restaurant!.services.find((s) => s.id === "dinner")!;
    dinner.maxCoversPerSlot = 6;
    dinner.walkInHoldback = 4;
    return l;
  });
  const agent = checkRestaurantSlot(holdback, [], { date: WED, startMin: H(20), partySize: 4 });
  assert(!agent.ok && agent.reason === "pacing", "the agent ate into the walk-in allowance");

  const manager = checkRestaurantSlot(holdback, [], {
    date: WED,
    startMin: H(20),
    partySize: 4,
    staffOverride: true,
  });
  assert(manager.ok, "a manager could not use the covers being held at the door");
});

// ---------------------------------------------------------------------------
console.log("\nThe house rules");
// ---------------------------------------------------------------------------

const NOW = { date: WED, min: H(12) };

test("notice is measured in the venue's own clock", () => {
  assert.equal(noticeMinutes(NOW, WED, H(14)), 120);
  assert.equal(noticeMinutes(NOW, addDays(WED, 1), H(12)), 1440);
  assert.equal(noticeMinutes(NOW, WED, H(11)), -60);
});

test("a time that has already passed is refused", () => {
  const refusal = checkPolicy(restaurant, { date: WED, startMin: H(11), now: NOW });
  assert(refusal && refusal.reason === "past");
});

test("a clinic's two hours of notice are enforced", () => {
  const inside = checkPolicy(clinic, { date: WED, startMin: H(13), now: NOW });
  assert(inside && inside.reason === "too_soon", `expected too_soon, got ${JSON.stringify(inside)}`);
  assert(inside.detail.includes("2 hours"), `the caller is not told how much notice: ${inside.detail}`);

  const outside = checkPolicy(clinic, { date: WED, startMin: H(15), now: NOW });
  assert.equal(outside, null, "refused a booking with three hours' notice");
});

test("the refusal names the earliest time that would work", () => {
  const refusal = checkPolicy(clinic, { date: WED, startMin: H(13), now: NOW });
  assert(refusal);
  assert(refusal.detail.includes("2 PM"), `no earliest time offered: ${refusal.detail}`);
});

test("a booking beyond the horizon is not taken", () => {
  const refusal = checkPolicy(restaurant, {
    date: addDays(WED, 400),
    startMin: H(20),
    now: NOW,
  });
  assert(refusal && refusal.reason === "too_far");
});

test("a same-day cutoff is not the same thing as a notice period", () => {
  const withCutoff = tweak(restaurant, (l) => {
    l.policy = { sameDayCutoffMin: H(11) };
    return l;
  });
  const today = checkPolicy(withCutoff, { date: WED, startMin: H(20), now: NOW });
  assert(today && today.reason === "cutoff", `expected cutoff, got ${JSON.stringify(today)}`);

  const tomorrow = checkPolicy(withCutoff, { date: addDays(WED, 1), startMin: H(20), now: NOW });
  assert.equal(tomorrow, null, "the cutoff leaked into tomorrow");
});

test("a manager is not argued with", () => {
  const refusal = checkPolicy(clinic, {
    date: WED,
    startMin: H(11),
    now: NOW,
    staffOverride: true,
  });
  assert.equal(refusal, null, "the calendar refused a booking a person was making by hand");
});

test("a patient who has missed twice is handed to a person, not refused", () => {
  const history = [
    booking(clinic, { guestPhone: "+971 50 111 2222", status: "no_show", date: "2026-08-01" }),
    booking(clinic, { guestPhone: "+971 50 111 2222", status: "no_show", date: "2026-08-20" }),
  ];
  const refusal = checkPolicy(clinic, {
    date: WED,
    startMin: H(16),
    guestPhone: "0501112222",
    history,
    now: NOW,
  });
  assert(refusal && refusal.reason === "needs_review");
  assert(
    !/no.show|missed|turn up/i.test(refusal.detail),
    `the agent tells the patient why: "${refusal.detail}"`,
  );
});

test("somebody else's no-shows are not held against this caller", () => {
  const history = [
    booking(clinic, { guestPhone: "+971 50 111 2222", status: "no_show", date: "2026-08-01" }),
    booking(clinic, { guestPhone: "+971 50 111 2222", status: "no_show", date: "2026-08-20" }),
  ];
  const refusal = checkPolicy(clinic, {
    date: WED,
    startMin: H(16),
    guestPhone: "+971 50 999 8888",
    history,
    now: NOW,
  });
  assert.equal(refusal, null);
});

test("a caller cannot fill the diary with open bookings", () => {
  const history = [1, 2, 3].map((i) =>
    booking(clinic, {
      guestPhone: "+971 50 333 4444",
      status: "confirmed",
      date: addDays(WED, i),
    }),
  );
  const refusal = checkPolicy(clinic, {
    date: addDays(WED, 5),
    startMin: H(16),
    guestPhone: "+971 50 333 4444",
    history,
    now: NOW,
  });
  assert(refusal && refusal.reason === "too_many_open");
});

// ---------------------------------------------------------------------------
console.log("\nDeposits and late cancellations");
// ---------------------------------------------------------------------------

test("a deposit applies to the parties it was written for", () => {
  const four = depositFor(restaurant, { date: WED, partySize: 4 });
  const six = depositFor(restaurant, { date: WED, partySize: 6 });
  assert.equal(four, undefined, "asked a table of four for a deposit");
  assert.deepEqual(six, { amount: 600, currency: "AED", status: "required" });
});

test("a deposit is worked out, never taken", () => {
  const six = depositFor(restaurant, { date: WED, partySize: 6 })!;
  assert.equal(six.status, "required", "a booking claimed money had been collected");
});

test("a booking carries its own deposit", () => {
  const made = createBooking(restaurant, {
    date: addDays(todayIn(restaurant.timezone), 10),
    startMin: H(20),
    guestName: "Deposit Test",
    guestPhone: "+971 50 777 0001",
    partySize: 6,
  });
  assert(made.ok, `booking refused: ${JSON.stringify(made)}`);
  assert.equal(made.booking.deposit?.amount, 600);
});

test("a cancellation inside the window is marked, not charged", () => {
  const today = todayIn(clinic.timezone);
  const soon = booking(clinic, { date: today, startMin: H(23, 30) });
  assert(isLateCancel(clinic, soon), "a cancellation half an hour out was not late");

  const far = booking(clinic, { date: addDays(today, 20), startMin: H(10) });
  assert(!isLateCancel(clinic, far), "a cancellation three weeks out was called late");
});

test("cancelling records which side of the window it fell on", () => {
  const made = createBooking(clinic, {
    date: workingDay(clinic, "dr_haddad", 14),
    startMin: H(10),
    guestName: "Cancel Test",
    guestPhone: "+971 50 777 0002",
    serviceIds: ["dent_consult"],
    staffId: "dr_haddad",
    staffOverride: true,
  });
  assert(made.ok, `booking refused: ${JSON.stringify(made)}`);
  const cancelled = cancelBooking(made.booking, clinic, "Changed their mind");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.lateCancel, false);
  assert.equal(cancelled.cancelReason, "Changed their mind");
  assert.ok(cancelled.cancelledAt);
});

// ---------------------------------------------------------------------------
console.log("\nTwo lines at once");
// ---------------------------------------------------------------------------

test("a slot quoted on one call is not offered on another", () => {
  clearHolds();
  const day = addDays(todayIn(restaurant.timezone), 12);
  const before = findAvailability(restaurant, {
    locationId: restaurant.id,
    date: day,
    preferredMin: H(20),
    partySize: 2,
  });
  assert(before.some((s) => s.startMin === H(20)), "8pm was not free to begin with");

  // A busy Friday: every table at eight is quoted on some other line. One call
  // per table, because a single call holds a single slot — re-quoting on the
  // same call moves that call's hold rather than adding another.
  for (const table of restaurant.restaurant!.tables) {
    holdSlot({
      locationId: restaurant.id,
      date: day,
      startMin: H(20),
      endMin: H(21, 30),
      tableIds: [table.id],
      callId: `call_other_${table.id}`,
    });
  }

  const after = findAvailability(restaurant, {
    locationId: restaurant.id,
    date: day,
    preferredMin: H(20),
    partySize: 2,
  });
  assert(!after.some((s) => s.startMin === H(20)), "offered a table another call was holding");
  clearHolds();
});

test("a call is never blocked by its own hold", () => {
  clearHolds();
  const day = addDays(todayIn(restaurant.timezone), 13);
  holdSlot({
    locationId: restaurant.id,
    date: day,
    startMin: H(20),
    endMin: H(21, 30),
    tableIds: restaurant.restaurant!.tables.map((t) => t.id),
    callId: "call_mine",
  });
  const mine = findAvailability(
    restaurant,
    { locationId: restaurant.id, date: day, preferredMin: H(20), partySize: 2 },
    { callId: "call_mine" },
  );
  assert(mine.some((s) => s.startMin === H(20)), "a caller was refused the table it was quoted");
  clearHolds();
});

test("an expired hold lets the table go", () => {
  clearHolds();
  const day = addDays(todayIn(restaurant.timezone), 14);
  holdSlot({
    locationId: restaurant.id,
    date: day,
    startMin: H(20),
    endMin: H(21, 30),
    tableIds: ["t3"],
    callId: "call_gone",
    seconds: -1,
  });
  const slots = findAvailability(restaurant, {
    locationId: restaurant.id,
    date: day,
    preferredMin: H(20),
    partySize: 2,
  });
  assert(slots.some((s) => s.startMin === H(20)), "a lapsed hold was still holding");
});

test("a dropped call releases everything it held", () => {
  clearHolds();
  holdSlot({
    locationId: restaurant.id,
    date: WED,
    startMin: H(20),
    endMin: H(21),
    tableIds: ["t1"],
    callId: "call_drop",
  });
  holdSlot({
    locationId: restaurant.id,
    date: WED,
    startMin: H(21),
    endMin: H(22),
    tableIds: ["t2"],
    callId: "call_drop",
  });
  assert.equal(releaseCall("call_drop"), 2);
});

test("re-quoting the same time extends the hold rather than stacking one", () => {
  clearHolds();
  const first = holdSlot({
    locationId: restaurant.id,
    date: WED,
    startMin: H(20),
    endMin: H(21),
    tableIds: ["t1"],
    callId: "call_repeat",
  });
  const again = holdSlot({
    locationId: restaurant.id,
    date: WED,
    startMin: H(20),
    endMin: H(21, 30),
    tableIds: ["t1"],
    callId: "call_repeat",
  });
  assert.equal(again.id, first.id);
  assert.equal(releaseCall("call_repeat"), 1);
});

// ---------------------------------------------------------------------------
console.log("\nWhich times to offer");
// ---------------------------------------------------------------------------

test("the caller's own time still comes first", () => {
  const slots: { date: string; startMin: Minutes; endMin: Minutes }[] = [
    { date: WED, startMin: H(19), endMin: H(20, 30) },
    { date: WED, startMin: H(20), endMin: H(21, 30) },
    { date: WED, startMin: H(21, 30), endMin: H(23) },
  ];
  const ranked = rankSlots(restaurant, slots, { preferredMin: H(20), bookings: [], partySize: 2 });
  assert.equal(ranked[0].startMin, H(20), "the time the caller asked for was not offered first");
});

test("every ranked slot carries a score and none is dropped", () => {
  const slots = [
    { date: WED, startMin: H(19), endMin: H(20, 30) },
    { date: WED, startMin: H(20), endMin: H(21, 30) },
  ];
  const ranked = rankSlots(restaurant, slots, { preferredMin: H(20), bookings: [] });
  assert.equal(ranked.length, 2, "ranking withheld a slot the engine had said yes to");
  assert(ranked.every((s) => typeof s.score === "number"));
});

test("search finds the exact minute a stylist comes free", () => {
  const existing = [
    booking(salon, { startMin: H(10), endMin: H(11, 5), staffId: "st_jonas", serviceIds: ["blowdry"] }),
  ];
  const slots = searchSalon(salon, existing, {
    locationId: salon.id,
    date: WED,
    preferredMin: H(11),
    serviceIds: ["blowdry"],
    staffId: "st_jonas",
  });
  assert(
    slots.some((s) => s.startMin === H(11, 5)),
    "the grid missed the five minutes past — a diary fragments exactly here",
  );
});

// ---------------------------------------------------------------------------
console.log("\nRecall — who is due back");
// ---------------------------------------------------------------------------

test("a hygiene visit writes the six-month recall onto the booking", () => {
  const day = workingDay(clinic, "nurse_rana", 20);
  const made = createBooking(clinic, {
    date: day,
    startMin: H(10),
    guestName: "Recall Test",
    guestPhone: "+971 50 888 0001",
    serviceIds: ["hygiene"],
    staffId: "nurse_rana",
    staffOverride: true,
  });
  assert(made.ok, `hygiene not bookable: ${JSON.stringify(made)}`);
  assert.equal(made.booking.recallServiceId, "hygiene");
  assert.equal(made.booking.recallDueOn, addDays(day, 182));
});

test("a patient whose recall has come round is on the list", () => {
  const today = todayIn(clinic.timezone);
  store.saveBooking(
    booking(clinic, {
      id: "bk_recall_overdue",
      guestName: "Overdue Patient",
      guestPhone: "+971 50 888 0002",
      date: addDays(today, -200),
      status: "completed",
      serviceIds: ["hygiene"],
      recallServiceId: "hygiene",
      recallDueOn: addDays(today, -18),
    }),
  );
  const item = recallDue(clinic).find((i) => i.guestPhone === "+971 50 888 0002");
  assert.ok(item, "an overdue patient is not on the recall list");
  assert.equal(item.status, "overdue");
  assert.equal(item.overdueDays, 18);
  assert.equal(item.value, 550);
});

test("a patient who has rebooked is closed out, not chased", () => {
  const today = todayIn(clinic.timezone);
  store.saveBooking(
    booking(clinic, {
      id: "bk_recall_answered",
      guestName: "Answered Patient",
      guestPhone: "+971 50 888 0003",
      date: addDays(today, -190),
      status: "completed",
      serviceIds: ["hygiene"],
      recallServiceId: "hygiene",
      recallDueOn: addDays(today, -8),
    }),
  );
  store.saveBooking(
    booking(clinic, {
      id: "bk_recall_answer",
      guestName: "Answered Patient",
      guestPhone: "+971 50 888 0003",
      date: addDays(today, 3),
      status: "confirmed",
      serviceIds: ["hygiene"],
    }),
  );
  const item = recallDue(clinic).find((i) => i.guestPhone === "+971 50 888 0003");
  assert.ok(item);
  assert.equal(item.status, "booked", "a patient who had already rebooked would have been rung");
});

test("a cancellation does not start the clock on coming back", () => {
  const today = todayIn(clinic.timezone);
  store.saveBooking(
    booking(clinic, {
      id: "bk_recall_cancelled",
      guestName: "Never Came",
      guestPhone: "+971 50 888 0004",
      date: addDays(today, -190),
      status: "cancelled",
      serviceIds: ["hygiene"],
      recallServiceId: "hygiene",
      recallDueOn: addDays(today, -8),
    }),
  );
  const item = recallDue(clinic).find((i) => i.guestPhone === "+971 50 888 0004");
  assert.equal(item, undefined, "chased somebody for a visit they never made");
});

test("the summary is a number an owner reacts to", () => {
  const summary = recallSummary(clinic);
  assert(summary.overdue >= 1);
  assert(summary.outstandingValue >= 550, "the list is not priced");
});

// ---------------------------------------------------------------------------
console.log("\nThe day, measured");
// ---------------------------------------------------------------------------

test("a column knows its own shift, not the venue's opening hours", () => {
  const view = dayView(salon, WED);
  const marie = view.columns.find((c) => c.id === "st_marie");
  assert.ok(marie);
  // Nine to six with lunch taken out: two ranges, not one.
  assert.equal(marie.shift.length, 2, "the break is not drawn out of the column");
});

test("an empty day is nought per cent sold, not a division by zero", () => {
  const view = dayView(salon, addDays(WED, 400));
  assert.equal(view.utilisation, 0);
  assert(Number.isFinite(view.utilisation));
});

test("gaps in the day are found, measured and priced", () => {
  const day = addDays(todayIn(salon.timezone), 16);
  const made = createBooking(salon, {
    date: day,
    startMin: H(10),
    guestName: "Gaps Test",
    guestPhone: "+41 79 000 0009",
    serviceIds: ["cut_w"],
    staffId: "st_jonas",
    staffOverride: true,
  });
  if (!made.ok) return; // Jonas may be off that weekday.
  const view = dayView(salon, day);
  const jonas = view.gaps.filter((g) => g.columnId === "st_jonas");
  assert(jonas.length > 0, "a day with one booking in it has no sellable time");
  assert(jonas.every((g) => g.minutes >= 20), "a turnaround was sold as an opportunity");
  assert(jonas.some((g) => g.value > 0), "the gaps are not priced");
});

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed\n`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);

// ---------------------------------------------------------------------------

async function loadFixtures(): Promise<{
  restaurant: Location;
  salon: Location;
  clinic: Location;
}> {
  process.env.BELLINE_FIXTURE = "1";
  const { seedIfEmpty } = await import("../src/lib/seed");
  const { listLocations } = await import("../src/lib/store");
  seedIfEmpty();
  const locations = listLocations();
  const restaurant = locations.find((l) => l.vertical === "restaurant");
  const salon = locations.find((l) => l.vertical === "salon");
  const clinic = locations.find((l) => l.vertical === "clinic");
  if (!restaurant || !salon || !clinic) throw new Error("Seed data missing a venue");
  return { restaurant, salon, clinic };
}
