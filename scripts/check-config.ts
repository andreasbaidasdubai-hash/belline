/**
 * The settings page's safety net.
 *
 * Making the engine configurable added a failure mode it never had: a venue
 * can now describe a diary that cannot work. Phases that do not add up. A
 * stylist qualified for a service deleted this morning. A treatment needing a
 * room nobody owns. None of those throw — they produce an engine that quietly
 * refuses every booking, and the venue finds out on a Friday.
 *
 * So the save path is a gate, and this is what holds the gate shut. The other
 * half is coercion: everything arriving over HTTP is rebuilt field by field,
 * because the terse version of that is what writes `durationMin: "60"` into
 * the book and turns an hour into six thousand minutes.
 *
 *   npm run check:config
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Booking, Location } from "../src/lib/types";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "belline-config-"));
process.env.DATA_DIR = scratch;

const {
  coercePolicy,
  coerceRestaurant,
  coerceSalon,
  isBlocking,
  validatePolicy,
  validateRestaurant,
  validateSalon,
  validateVenue,
} = await import("../src/lib/booking/config");
const { recallDue, recallSummary, markRecall } = await import("../src/lib/booking/recall");
const { snapshotOf, changedSections } = await import("../src/lib/brain");
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

/** A venue with one thing changed, so a rule is tested against its absence. */
function tweak(location: Location, patch: (l: Location) => void): Location {
  const copy = structuredClone(location);
  patch(copy);
  return copy;
}

const errors = (findings: { level: string; message: string }[]) =>
  findings.filter((f) => f.level === "error").map((f) => f.message);
const warnings = (findings: { level: string; message: string }[]) =>
  findings.filter((f) => f.level === "warning").map((f) => f.message);

// ---------------------------------------------------------------------------
console.log("\nThe seeded venues are valid, or nothing below means anything");
// ---------------------------------------------------------------------------

for (const venue of [restaurant, salon, clinic]) {
  test(`${venue.name} has no blocking problems`, () => {
    const findings = validateVenue(venue);
    assert(!isBlocking(findings), `blocked by: ${errors(findings).join(" / ")}`);
  });
}

// ---------------------------------------------------------------------------
console.log("\nA diary that cannot work is refused");
// ---------------------------------------------------------------------------

test("stages that do not add up to the service are refused", () => {
  const broken = tweak(salon, (l) => {
    const colour = l.salon!.services.find((s) => s.id === "colour_root")!;
    colour.phases = [
      { name: "Apply", durationMin: 30 },
      { name: "Develop", durationMin: 20, staffFree: true },
    ];
  });
  const found = errors(validateSalon(broken.salon!));
  assert(found.some((m) => /come to 50 minutes and the service is 90/.test(m)), found.join(" / "));
});

test("a service where nobody is ever present is refused", () => {
  const broken = tweak(salon, (l) => {
    l.salon!.services.find((s) => s.id === "colour_root")!.phases = [
      { name: "Develop", durationMin: 90, staffFree: true },
    ];
  });
  assert(isBlocking(validateSalon(broken.salon!)));
});

test("a qualification pointing at a deleted service is refused", () => {
  const broken = tweak(salon, (l) => {
    l.salon!.services = l.salon!.services.filter((s) => s.id !== "blowdry");
  });
  const found = errors(validateSalon(broken.salon!));
  assert(found.some((m) => /blowdry/.test(m)), found.join(" / "));
});

test("a treatment needing a room nobody owns is refused", () => {
  const broken = tweak(clinic, (l) => {
    l.salon!.resources = l.salon!.resources.filter((r) => r.type !== "whitening_lamp");
  });
  const found = errors(validateSalon(broken.salon!));
  assert(found.some((m) => /whitening_lamp/.test(m)), found.join(" / "));
});

test("a second person nobody can be is refused, by name", () => {
  const broken = tweak(clinic, (l) => {
    for (const person of l.salon!.staff) {
      if (person.role === "dentist") person.role = "hygienist";
    }
  });
  const found = errors(validateSalon(broken.salon!));
  assert(found.some((m) => /"dentist"/.test(m)), found.join(" / "));
});

test("a second person needed after the appointment has ended is refused", () => {
  const broken = tweak(clinic, (l) => {
    l.salon!.services.find((s) => s.id === "hygiene")!.secondary = {
      role: "dentist",
      atMin: 40,
      durationMin: 30,
    };
  });
  assert(isBlocking(validateSalon(broken.salon!)));
});

test("two services sharing an id are refused", () => {
  const broken = tweak(salon, (l) => {
    l.salon!.services.push({ ...l.salon!.services[0] });
  });
  assert(isBlocking(validateSalon(broken.salon!)));
});

test("a break that ends before it starts is refused", () => {
  const broken = tweak(salon, (l) => {
    l.salon!.staff.find((s) => s.id === "st_marie")!.breaks = { 3: [{ start: H(14), end: H(13) }] };
  });
  assert(isBlocking(validateSalon(broken.salon!)));
});

// ---------------------------------------------------------------------------
console.log("\nA diary that is merely odd is saved, and said out loud");
// ---------------------------------------------------------------------------

test("a service nobody can do is a warning, not a refusal", () => {
  const odd = tweak(salon, (l) => {
    for (const person of l.salon!.staff) {
      person.serviceIds = person.serviceIds.filter((id) => id !== "treatment");
    }
  });
  const findings = validateSalon(odd.salon!);
  assert(!isBlocking(findings), `should not block: ${errors(findings).join(" / ")}`);
  assert(
    warnings(findings).some((m) => /Keratin treatment/.test(m)),
    warnings(findings).join(" / "),
  );
});

test("a break outside the shift is a warning, because it does nothing", () => {
  const odd = tweak(salon, (l) => {
    l.salon!.staff.find((s) => s.id === "st_marie")!.breaks = { 3: [{ start: H(21), end: H(22) }] };
  });
  const findings = validateSalon(odd.salon!);
  assert(!isBlocking(findings));
  assert(warnings(findings).some((m) => /outside their shift/.test(m)));
});

test("dovetailing with nothing to dovetail into is a warning", () => {
  const odd = tweak(salon, (l) => {
    l.salon!.dovetail = true;
    for (const service of l.salon!.services) delete service.phases;
  });
  assert(warnings(validateSalon(odd.salon!)).some((m) => /never do anything/.test(m)));
});

// ---------------------------------------------------------------------------
console.log("\nThe room");
// ---------------------------------------------------------------------------

test("a table set to join one that does not exist is refused", () => {
  const broken = tweak(restaurant, (l) => {
    l.restaurant!.tables.find((t) => t.id === "t20")!.combinesWith = ["t99"];
  });
  assert(isBlocking(validateRestaurant(broken.restaurant!)));
});

test("turn times out of order are refused, because the first match wins", () => {
  const broken = tweak(restaurant, (l) => {
    l.restaurant!.services.find((s) => s.id === "dinner")!.turnTimes = [
      { upTo: 8, minutes: 135 },
      { upTo: 2, minutes: 90 },
    ];
  });
  const found = errors(validateRestaurant(broken.restaurant!));
  assert(found.some((m) => /go up by party size/.test(m)), found.join(" / "));
});

test("a last seating outside its own sitting is refused", () => {
  const broken = tweak(restaurant, (l) => {
    l.restaurant!.services.find((s) => s.id === "dinner")!.lastSeating = H(2);
  });
  assert(isBlocking(validateRestaurant(broken.restaurant!)));
});

test("holding back every cover from the phone is refused", () => {
  const broken = tweak(restaurant, (l) => {
    const dinner = l.restaurant!.services.find((s) => s.id === "dinner")!;
    dinner.maxCoversPerSlot = 6;
    dinner.walkInHoldback = 6;
  });
  const found = errors(validateRestaurant(broken.restaurant!));
  assert(found.some((m) => /leaves nothing for the phone/.test(m)), found.join(" / "));
});

test("a party size the room cannot seat is a warning with the arithmetic", () => {
  const odd = tweak(restaurant, (l) => {
    l.restaurant!.maxPartySize = 40;
  });
  const found = warnings(validateRestaurant(odd.restaurant!));
  assert(found.some((m) => /the largest table is 8/.test(m)), found.join(" / "));
});

// ---------------------------------------------------------------------------
console.log("\nHouse rules that would refuse everything");
// ---------------------------------------------------------------------------

test("notice longer than the booking window is refused", () => {
  const found = errors(validatePolicy({ minNoticeMin: 60 * 24 * 10, maxHorizonDays: 3 }));
  assert(found.some((m) => /nothing would ever be bookable/.test(m)), found.join(" / "));
});

test("a same-day cutoff that is not a time of day is refused", () => {
  assert(isBlocking(validatePolicy({ sameDayCutoffMin: 2000 })));
});

test("a deposit of nothing is refused rather than stored", () => {
  const found = errors(validatePolicy({ deposit: { amount: 0, per: "booking" } }));
  assert(found.some((m) => /above zero/.test(m)), found.join(" / "));
});

test("an empty policy is no policy, and fine", () => {
  assert.deepEqual(validatePolicy({}), []);
  assert.deepEqual(validatePolicy(undefined), []);
});

// ---------------------------------------------------------------------------
console.log("\nNothing off the wire is trusted to be the shape it claims");
// ---------------------------------------------------------------------------

test("numbers arriving as strings become numbers", () => {
  const next = coerceSalon(
    {
      slotMinutes: "15",
      services: [{ id: "x", name: "Cut", durationMin: "60", bufferMin: "10", price: "130" }],
      staff: [],
      resources: [],
    },
    salon.salon!,
  );
  assert.strictEqual(next.services[0].durationMin, 60);
  assert.strictEqual(next.services[0].price, 130);
  assert.strictEqual(next.slotMinutes, 15);
});

test("a blank number is absent, not zero", () => {
  const policy = coercePolicy({ minNoticeMin: "", maxHorizonDays: "90" });
  assert.strictEqual(policy?.minNoticeMin, undefined);
  assert.strictEqual("minNoticeMin" in policy!, false, "an empty field was stored as a key");
  assert.strictEqual(policy?.maxHorizonDays, 90);
});

test("a policy with nothing in it is undefined rather than an empty object", () => {
  assert.strictEqual(coercePolicy({ minNoticeMin: "", lateCancelFee: "" }), undefined);
});

test("nonsense is dropped rather than stored", () => {
  const next = coerceSalon(
    {
      slotMinutes: 15,
      services: [{ id: "x", name: "Cut", durationMin: "not a number", bufferMin: 0, price: 0 }],
      staff: [{ id: "p", name: "Someone", serviceIds: ["x", "", 42], hours: {}, timeOff: [] }],
      resources: [{ id: "r", name: "", type: "chair" }],
    },
    salon.salon!,
  );
  assert.strictEqual(next.services[0].durationMin, 0, "an unreadable duration was kept");
  // An id that is not a string is dropped rather than stringified. Coercing it
  // would keep a reference that matches no service, which the validator then
  // refuses — so a client bug would become a venue that cannot save at all.
  assert.deepEqual(next.staff[0].serviceIds, ["x"]);
  assert.strictEqual(next.resources.length, 0, "a nameless room was stored");
});

test("one stage is not stages", () => {
  const next = coerceSalon(
    {
      slotMinutes: 15,
      services: [
        {
          id: "x",
          name: "Cut",
          durationMin: 60,
          bufferMin: 0,
          price: 0,
          phases: [{ name: "All of it", durationMin: 60 }],
        },
      ],
      staff: [],
      resources: [],
    },
    salon.salon!,
  );
  assert.strictEqual(next.services[0].phases, undefined);
});

test("turn times are sorted, so a venue cannot break them by reordering", () => {
  const next = coerceRestaurant(
    {
      ...restaurant.restaurant!,
      services: [
        {
          id: "d",
          name: "dinner",
          days: [1],
          start: 1080,
          end: 1380,
          lastSeating: 1300,
          turnTimes: [
            { upTo: 8, minutes: 135 },
            { upTo: 2, minutes: 90 },
          ],
        },
      ],
    },
    restaurant.restaurant!,
  );
  assert.deepEqual(
    next.services[0].turnTimes.map((t) => t.upTo),
    [2, 8],
  );
});

test("a rostered day off survives, because it is not the same as no pattern", () => {
  const next = coerceSalon(
    {
      slotMinutes: 15,
      services: [],
      staff: [
        {
          id: "p",
          name: "Someone",
          serviceIds: [],
          hours: {},
          timeOff: [],
          shifts: [{ date: "2026-10-01", ranges: [] }],
        },
      ],
      resources: [],
    },
    salon.salon!,
  );
  assert.deepEqual(next.staff[0].shifts, [{ date: "2026-10-01", ranges: [] }]);
});

test("an unknown field is not carried into the book", () => {
  const next = coerceRestaurant(
    { ...restaurant.restaurant!, somethingElse: "hello" },
    restaurant.restaurant!,
  );
  assert.strictEqual((next as unknown as Record<string, unknown>).somethingElse, undefined);
});

// ---------------------------------------------------------------------------
console.log("\nThe history sees a rule change");
// ---------------------------------------------------------------------------

test("changing the cancellation window is its own section in the history", () => {
  const before = snapshotOf(restaurant);
  const after = snapshotOf(
    tweak(restaurant, (l) => {
      l.policy = { ...l.policy, cancellationWindowHours: 48 };
    }),
  );
  assert.deepEqual(changedSections(before, after), ["rules"]);
});

test("moving a table is a change to the room, not to the price list", () => {
  const before = snapshotOf(restaurant);
  const after = snapshotOf(
    tweak(restaurant, (l) => {
      l.restaurant!.tables[0].maxSeats = 4;
    }),
  );
  assert.deepEqual(changedSections(before, after), ["room"]);
});

// ---------------------------------------------------------------------------
console.log("\nWorking the recall list");
// ---------------------------------------------------------------------------

const today = todayIn(clinic.timezone);

function seedRecall(id: string, phone: string, over: Partial<Booking> = {}): Booking {
  return store.saveBooking({
    id,
    ref: "TEST",
    locationId: clinic.id,
    vertical: "clinic",
    status: "completed",
    date: addDays(today, -200),
    startMin: H(10),
    endMin: H(11),
    guestName: "Recall Patient",
    guestPhone: phone,
    notes: "",
    serviceIds: ["hygiene"],
    recallServiceId: "hygiene",
    recallDueOn: addDays(today, -10),
    source: "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });
}

test("ringing somebody moves them down the list rather than off it", () => {
  const booking = seedRecall("bk_rc_1", "+971 50 100 0001");
  markRecall(booking, "contacted");
  const item = recallDue(clinic).find((i) => i.fromBookingId === "bk_rc_1");
  assert.ok(item, "the patient fell off the list entirely");
  assert.equal(item.status, "contacted");
  assert.ok(item.contactedAt);
});

test("putting somebody off takes them off the list until the date", () => {
  const booking = seedRecall("bk_rc_2", "+971 50 100 0002");
  markRecall(booking, "snooze", addDays(today, 30));
  assert.equal(
    recallDue(clinic).find((i) => i.fromBookingId === "bk_rc_2"),
    undefined,
    "somebody who asked to be left alone is still being chased",
  );
  const shown = recallDue(clinic, { includeSnoozed: true }).find((i) => i.fromBookingId === "bk_rc_2");
  assert.ok(shown, "and cannot be seen even on purpose");
  assert.equal(shown.snoozedUntil, addDays(today, 30));
});

test("a snooze that has run out puts them back", () => {
  const booking = seedRecall("bk_rc_3", "+971 50 100 0003");
  markRecall(booking, "snooze", addDays(today, -1));
  const item = recallDue(clinic).find((i) => i.fromBookingId === "bk_rc_3");
  assert.ok(item, "a lapsed snooze is still hiding somebody");
  assert.equal(item.status, "contacted");
});

test("undoing puts the row back where it was", () => {
  const booking = seedRecall("bk_rc_4", "+971 50 100 0004");
  markRecall(booking, "contacted");
  markRecall(store.getBooking("bk_rc_4")!, "clear");
  const item = recallDue(clinic).find((i) => i.fromBookingId === "bk_rc_4");
  assert.ok(item);
  assert.equal(item.status, "overdue");
  assert.equal(item.contactedAt, undefined);
});

test("the summary counts the rung separately from the outstanding", () => {
  const summary = recallSummary(clinic);
  assert(summary.contacted >= 2, `expected at least two rung, got ${summary.contacted}`);
  assert(summary.overdue >= 1);
});

// ---------------------------------------------------------------------------
console.log("\nWhat actually happened");
// ---------------------------------------------------------------------------

const { markProgress } = await import("../src/lib/booking");
const { checkPolicy } = await import("../src/lib/booking/policy");
const { recallDue: dueList } = await import("../src/lib/booking/recall");

function seedVisit(id: string, phone: string, over: Partial<Booking> = {}): Booking {
  return store.saveBooking({
    id,
    ref: "PROG",
    locationId: clinic.id,
    vertical: "clinic",
    status: "confirmed",
    date: addDays(today, -1),
    startMin: H(10),
    endMin: H(11),
    guestName: "Progress Patient",
    guestPhone: phone,
    notes: "",
    serviceIds: ["dent_consult"],
    source: "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });
}

test("arriving does not free the table — a seated party still holds it", () => {
  const saved = markProgress(seedVisit("bk_pg_1", "+971 50 200 0001"), "arrived");
  assert.equal(saved.status, "confirmed");
  assert.ok(saved.service?.arrivedAt);
});

test("leaving completes the booking, so the covers report is honest", () => {
  const saved = markProgress(seedVisit("bk_pg_2", "+971 50 200 0002"), "left");
  assert.equal(saved.status, "completed");
  assert.ok(saved.service?.leftAt);
});

test("a no-show ends the booking and leaves no arrival trail", () => {
  const arrived = markProgress(seedVisit("bk_pg_3", "+971 50 200 0003"), "arrived");
  const saved = markProgress(arrived, "no_show");
  assert.equal(saved.status, "no_show");
  assert.equal(saved.service, undefined, "somebody marked absent still looks like they arrived");
});

test("putting a booking back clears the trail rather than adding to it", () => {
  const gone = markProgress(seedVisit("bk_pg_4", "+971 50 200 0004"), "no_show");
  const back = markProgress(gone, "reopen");
  assert.equal(back.status, "confirmed");
  assert.equal(back.service, undefined);
});

test("the no-show rule can now actually fire, which is the point of all this", () => {
  const phone = "+971 50 200 0009";
  // The clinic is seeded with "hand to a person after two no-shows". Until
  // something could write the status, that rule was unreachable.
  const before = checkPolicy(clinic, {
    date: addDays(today, 9),
    startMin: H(11),
    guestPhone: phone,
    history: store.listBookings({ locationId: clinic.id }),
    now: { date: today, min: H(9) },
  });
  assert.equal(before, null, "refused before any no-show was recorded");

  markProgress(seedVisit("bk_pg_5", phone, { date: addDays(today, -3) }), "no_show");
  markProgress(seedVisit("bk_pg_6", phone, { date: addDays(today, -2) }), "no_show");

  const after = checkPolicy(clinic, {
    date: addDays(today, 9),
    startMin: H(11),
    guestPhone: phone,
    history: store.listBookings({ locationId: clinic.id }),
    now: { date: today, min: H(9) },
  });
  assert.ok(after && after.reason === "needs_review", `expected needs_review, got ${JSON.stringify(after)}`);
});

test("a no-show does not start the clock on coming back", () => {
  const phone = "+971 50 200 0010";
  markProgress(
    seedVisit("bk_pg_7", phone, {
      date: addDays(today, -190),
      serviceIds: ["hygiene"],
      recallServiceId: "hygiene",
      recallDueOn: addDays(today, -8),
    }),
    "no_show",
  );
  assert.equal(
    dueList(clinic).find((i) => i.fromBookingId === "bk_pg_7"),
    undefined,
    "chased somebody for a visit they did not turn up to",
  );
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
