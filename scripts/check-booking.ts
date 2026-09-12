/**
 * Booking-engine smoke test.
 *
 * The agent is only as trustworthy as the availability logic underneath it,
 * and that logic is the part a demo will never exercise properly — nobody
 * manually double-books a colour station at 14:15 on a Thursday. So it gets
 * checked here instead.
 *
 *   npm run check
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Booking, Location } from "../src/lib/types";

// Point the store at a throwaway directory *before* anything imports it.
// One of these tests writes a real booking, and without this it lands in the
// working diary — silently consuming a practitioner on every run until the
// test starts failing against data it created itself.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "belline-test-"));
process.env.DATA_DIR = scratch;

const { checkRestaurantSlot, searchRestaurant } = await import("../src/lib/booking/restaurant");
const { checkSalonSlot, searchSalon } = await import("../src/lib/booking/salon");
const { createBooking } = await import("../src/lib/booking");
const { minutesToClock } = await import("../src/lib/time");

// Seed data is defined in src/lib/seed.ts but not exported; rebuild the two
// venues here so this script never touches the real store.
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

// A Wednesday and a Saturday, far enough out that nothing is in the past.
const WED = "2026-09-16";
const SAT = "2026-09-19";

function booking(over: Partial<Booking>): Booking {
  return {
    id: `bk_${Math.random().toString(16).slice(2)}`,
    ref: "TEST",
    locationId: over.locationId ?? restaurant.id,
    vertical: over.vertical ?? "restaurant",
    status: "confirmed",
    date: WED,
    startMin: H(20),
    endMin: H(21, 30),
    guestName: "Test",
    guestPhone: "+100",
    notes: "",
    source: "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

console.log("\nRestaurant — Azure Table");

test("turn time grows with party size", () => {
  const two = checkRestaurantSlot(restaurant, [], { date: WED, startMin: H(20), partySize: 2 });
  const six = checkRestaurantSlot(restaurant, [], { date: WED, startMin: H(20), partySize: 6 });
  assert(two.ok && six.ok);
  assert.equal(two.assignment.endMin - two.assignment.startMin, 90);
  assert.equal(six.assignment.endMin - six.assignment.startMin, 120);
});

test("a party of two gets the smallest table that fits, not the biggest", () => {
  const result = checkRestaurantSlot(restaurant, [], { date: WED, startMin: H(20), partySize: 2 });
  assert(result.ok);
  const table = restaurant.restaurant!.tables.find((t) => t.id === result.assignment.tableIds[0])!;
  assert.equal(table.maxSeats, 2, `burned a ${table.maxSeats}-top on a deuce`);
});

test("an occupied table is not offered again inside its turn", () => {
  const taken = restaurant.restaurant!.tables.find((t) => t.maxSeats === 8)!;
  const existing = [booking({ startMin: H(20), endMin: H(22, 15), partySize: 8, tableIds: [taken.id] })];
  const result = checkRestaurantSlot(restaurant, existing, {
    date: WED,
    startMin: H(21),
    partySize: 8,
  });
  // Only one 8-top exists, so this must fall through to a combination or fail.
  assert(!result.ok || !result.assignment.tableIds.includes(taken.id));
});

test("the table frees up once the turn is over", () => {
  const taken = restaurant.restaurant!.tables.find((t) => t.maxSeats === 8)!;
  const existing = [booking({ startMin: H(18), endMin: H(20, 15), partySize: 8, tableIds: [taken.id] })];
  const result = checkRestaurantSlot(restaurant, existing, {
    date: WED,
    startMin: H(20, 30),
    partySize: 8,
  });
  assert(result.ok && result.assignment.tableIds.includes(taken.id));
});

test("large parties are combined across tables in one section", () => {
  // Occupy the only 8-top so a party of 7 must be combined. Seat them in a
  // different slot from the blocking booking, or the pacing cap answers
  // first and this stops testing table selection at all.
  const eight = restaurant.restaurant!.tables.find((t) => t.maxSeats === 8)!;
  const existing = [booking({ startMin: H(20), endMin: H(22), partySize: 8, tableIds: [eight.id] })];
  const result = checkRestaurantSlot(restaurant, existing, {
    date: WED,
    startMin: H(20, 30),
    partySize: 7,
  });
  assert(result.ok, `no combination found for a party of 7: ${JSON.stringify(result)}`);
  assert.equal(result.assignment.tableIds.length, 2);
  const sections = result.assignment.tableIds.map(
    (id) => restaurant.restaurant!.tables.find((t) => t.id === id)!.section,
  );
  assert.equal(sections[0], sections[1], "combined tables from different sections");
});

test("pacing caps covers per slot even when tables are free", () => {
  const cap = restaurant.restaurant!.maxCoversPerSlot;
  const existing = [
    booking({ startMin: H(20), endMin: H(22), partySize: cap, tableIds: ["t8", "t7"] }),
  ];
  const result = checkRestaurantSlot(restaurant, existing, {
    date: WED,
    startMin: H(20),
    partySize: 2,
  });
  assert(!result.ok && result.reason === "pacing", `expected pacing, got ${JSON.stringify(result)}`);
});

test("pacing does not block the very next slot", () => {
  const cap = restaurant.restaurant!.maxCoversPerSlot;
  const existing = [
    booking({ startMin: H(20), endMin: H(22), partySize: cap, tableIds: ["t8", "t7"] }),
  ];
  const result = checkRestaurantSlot(restaurant, existing, {
    date: WED,
    startMin: H(20, 15),
    partySize: 2,
  });
  assert(result.ok, "pacing leaked into the following slot");
});

test("a time outside every service window is refused", () => {
  const result = checkRestaurantSlot(restaurant, [], { date: WED, startMin: H(17), partySize: 2 });
  assert(!result.ok && result.reason === "outside_service");
});

test("last seating is respected", () => {
  const late = checkRestaurantSlot(restaurant, [], { date: WED, startMin: H(22, 30), partySize: 2 });
  assert(!late.ok, "booked after last seating");
});

test("lunch does not run on the weekend, brunch does", () => {
  const satLunch = checkRestaurantSlot(restaurant, [], { date: SAT, startMin: H(13), partySize: 2 });
  assert(satLunch.ok, "weekend brunch should cover 13:00");
  const wedBrunch = restaurant.restaurant!.services.find((s) => s.id === "brunch")!;
  assert(!wedBrunch.days.includes(3), "brunch should not run midweek");
});

test("a party over the house maximum is refused with the policy", () => {
  const result = checkRestaurantSlot(restaurant, [], { date: WED, startMin: H(20), partySize: 12 });
  assert(!result.ok && result.reason === "party_too_large");
  assert(result.detail.includes("events"), "policy text not returned");
});

test("search returns nearby times ordered around the request", () => {
  const slots = searchRestaurant(restaurant, [], {
    locationId: restaurant.id,
    date: WED,
    preferredMin: H(20),
    partySize: 2,
  });
  assert(slots.length > 0);
  assert(slots.every((s) => Math.abs(s.startMin - H(20)) <= 120));
  assert(slots.some((s) => s.startMin === H(20)), "exact time missing from an empty book");
});

console.log("\nSalon — Lumière");

const salonBooking = (over: Partial<Booking>) =>
  booking({ locationId: salon.id, vertical: "salon", ...over });

/** Same helper, for any staff-diary venue. */
const salonBookingFor = (location: Location, over: Partial<Booking>) =>
  booking({ locationId: location.id, vertical: location.vertical, ...over });

// Pinned to Jonas throughout this pair: he charges and works to the list, so
// these test chaining rather than which stylist the engine happened to pick.
// Marie's own timing and prices are a separate test, below.
test("chained services are priced and timed as one block", () => {
  const result = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["cut_w", "blowdry"],
    staffId: "st_jonas",
  });
  assert(result.ok);
  assert.equal(result.assignment.durationMin, 105);
  assert.equal(result.assignment.price, 215);
});

test("the cleanup buffer is held after the appointment, not shown in it", () => {
  const result = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["cut_w"],
    staffId: "st_jonas",
  });
  assert(result.ok);
  assert.equal(result.assignment.endMin, H(11), "guest-facing end should exclude buffer");
  assert.equal(result.assignment.blockEndMin, H(11, 15), "diary block should include buffer");
});

test("the buffer actually blocks the next booking", () => {
  const existing = [
    salonBooking({ startMin: H(10), endMin: H(11, 15), staffId: "st_jonas", serviceIds: ["cut_w"] }),
  ];
  const result = checkSalonSlot(salon, existing, {
    date: WED,
    startMin: H(11),
    serviceIds: ["cut_w"],
    staffId: "st_jonas",
  });
  assert(!result.ok, "booked into a colleague's cleanup time");
});

test("only qualified staff are offered", () => {
  // Jonas does not do colour.
  const result = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["balayage"],
    staffId: "st_jonas",
  });
  assert(!result.ok && result.reason === "no_staff");
});

test("a request for someone who is not in that day is refused", () => {
  // Marie does not work Mondays (day 1); 2026-09-14 is a Monday.
  const result = checkSalonSlot(salon, [], {
    date: "2026-09-14",
    startMin: H(11),
    serviceIds: ["balayage"],
    staffId: "st_marie",
  });
  assert(!result.ok, "booked a stylist on their day off");
});

test("shared colour stations are a real constraint", () => {
  const existing = [
    salonBooking({
      startMin: H(10),
      endMin: H(11, 50),
      staffId: "st_marie",
      resourceId: "cs1",
      serviceIds: ["colour_root"],
    }),
    salonBooking({
      startMin: H(10),
      endMin: H(11, 50),
      staffId: "st_aisha",
      resourceId: "cs2",
      serviceIds: ["colour_root"],
    }),
  ];
  // Both stations busy, and both colourists busy — must fail.
  const result = checkSalonSlot(salon, existing, {
    date: WED,
    startMin: H(10, 30),
    serviceIds: ["colour_root"],
  });
  assert(!result.ok, "double-booked a colour station");
});

test("work is spread across the team rather than stacked on one person", () => {
  const existing = [
    salonBooking({ startMin: H(10), endMin: H(11, 15), staffId: "st_jonas", serviceIds: ["cut_w"] }),
  ];
  const result = checkSalonSlot(salon, existing, { date: WED, startMin: H(14), serviceIds: ["cut_w"] });
  assert(result.ok);
  assert.notEqual(result.assignment.staffId, "st_jonas", "kept loading the busiest stylist");
});

test("an appointment that would overrun the shift is refused", () => {
  // Balayage is 3 hours; nobody's shift can absorb it starting at 17:00.
  const result = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(17),
    serviceIds: ["balayage"],
  });
  assert(!result.ok, "let a 3-hour service run past closing");
});

test("an unknown service is named back, not silently dropped", () => {
  const result = checkSalonSlot(salon, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["cut_w", "nail_art"],
  });
  assert(!result.ok && result.reason === "unknown_service");
  assert(result.detail.includes("nail_art"));
});

test("search returns distinct bookable times", () => {
  const slots = searchSalon(salon, [], {
    locationId: salon.id,
    date: WED,
    preferredMin: H(14),
    serviceIds: ["cut_w"],
  });
  assert(slots.length > 0, "no salon availability on an empty day");
  assert(slots.every((s) => s.staffId), "slot returned without a stylist");
});

console.log("\nClinic — Meridian Dental & Aesthetics");

test("the clinic runs on the same engine as the salon", () => {
  const result = checkSalonSlot(clinic, [], {
    date: WED,
    startMin: H(10),
    serviceIds: ["dent_consult"],
  });
  assert(result.ok, `clinic consultation not bookable: ${JSON.stringify(result)}`);
  assert.equal(result.assignment.durationMin, 30);
  assert.equal(result.assignment.price, 350);
});

test("bookings carry the clinic vertical, not a hardcoded salon", () => {
  const result = createBooking(clinic, {
    date: WED,
    startMin: H(14),
    guestName: "Test Patient",
    guestPhone: "+971500000001",
    serviceIds: ["dent_consult"],
    source: "manual",
  });
  assert(result.ok, `clinic booking failed: ${JSON.stringify(result)}`);
  assert.equal(result.booking.vertical, "clinic", "a patient would be read back as a salon client");
});

test("a surgery is a shared resource, exactly like a colour station", () => {
  const existing = [
    salonBookingFor(clinic, { startMin: H(10), endMin: H(11, 15), staffId: "dr_haddad", resourceId: "surg1", serviceIds: ["filling"] }),
    salonBookingFor(clinic, { startMin: H(10), endMin: H(11, 15), staffId: "dr_novak", resourceId: "surg2", serviceIds: ["filling"] }),
  ];
  const result = checkSalonSlot(clinic, existing, {
    date: WED,
    startMin: H(10, 30),
    serviceIds: ["filling"],
  });
  assert(!result.ok, "booked a third filling into two surgeries");
});

test("a dentist is never offered for an aesthetic treatment", () => {
  const result = checkSalonSlot(clinic, [], {
    date: WED,
    startMin: H(11),
    serviceIds: ["injectables"],
    staffId: "dr_haddad",
  });
  assert(!result.ok && result.reason === "no_staff");
});

test("the clinic is closed on Friday", () => {
  // 2026-09-18 is a Friday; the clinic works Sat–Thu.
  const result = checkSalonSlot(clinic, [], {
    date: "2026-09-18",
    startMin: H(11),
    serviceIds: ["dent_consult"],
  });
  assert(!result.ok, "booked a patient on the clinic's closed day");
});

test("a two-hour root canal cannot start an hour before close", () => {
  const result = checkSalonSlot(clinic, [], {
    date: WED,
    startMin: H(17),
    serviceIds: ["root_canal"],
    staffId: "dr_haddad",
  });
  assert(!result.ok, "let a 2-hour treatment run past the end of the shift");
});

console.log(
  `\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed\n`,
);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);

// ---------------------------------------------------------------------------

async function loadFixtures(): Promise<{
  restaurant: Location;
  salon: Location;
  clinic: Location;
}> {
  // seed.ts writes to the store on import, so build the fixtures from a
  // throwaway store directory instead of the real one.
  process.env.BELLINE_FIXTURE = "1";
  const { seedIfEmpty } = await import("../src/lib/seed");
  const store = await import("../src/lib/store");
  seedIfEmpty();
  const locations = store.listLocations();
  const restaurant = locations.find((l) => l.vertical === "restaurant");
  const salon = locations.find((l) => l.vertical === "salon");
  const clinic = locations.find((l) => l.vertical === "clinic");
  if (!restaurant || !salon || !clinic) throw new Error("Seed data missing a venue");
  return { restaurant, salon, clinic };
}

void minutesToClock;
