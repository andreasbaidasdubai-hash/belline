/**
 * The dashboard's working parts: locations and desk bookings.
 *
 * A business must be able to add a branch, change its details, archive a
 * closed one and delete a mistake — without ever losing history by accident.
 * And a receptionist must be able to take a booking with several services and
 * an email, and change a booking's time, person, services or guest details —
 * all through the same engine the phone line uses.
 *
 *   npm run check:backend
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-backend-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, getUser, listLocations, listLocationsFor, saveBooking } = await import("../src/lib/store");
const { visibleLocations, createUser } = await import("../src/lib/auth");
const { archiveLocation, createLocation, deleteLocation, restoreLocation, updateLocationBasics } = await import("../src/lib/locations");
const { createFromDesk, updateFromDesk } = await import("../src/lib/booking/desk");
const { findAvailability } = await import("../src/lib/booking");
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

const made = await signUp({
  businessName: "Palm Group Clinics",
  email: "owner@palmgroup.test",
  password: "Correct-Horse-Battery-9",
  vertical: "clinic",
  timezone: "Asia/Dubai",
});
assert.ok(made.ok);
const owner = made.ok ? made.user : null!;
const first = made.ok ? made.location : null!;
const me = () => getUser(owner.id)!;

console.log("\n\x1b[1mLocations\x1b[0m\n");

let branch = "";

await test("an owner adds a second location, in their own business, with its own trial and history", () => {
  const out = createLocation(me(), { name: "Palm Clinic — Marina", vertical: "clinic", address: "Marina Walk, Dubai", phone: "+971 4 555 0199" });
  assert.ok(out.ok, out.ok ? "" : out.error);
  branch = out.ok ? out.location.id : "";
  const loc = getLocation(branch)!;
  assert.equal(loc.tenantId, owner.tenantId);
  assert.equal(loc.businessId, first.businessId);
  assert.equal(loc.subscription?.status, "trialing");
  assert.match(loc.businessPhone, /^\+9714/);
  assert.equal(loc.bellineNumber, undefined, "the business's own phone was taken for its Belline number");
  assert.ok((loc.brainHistory ?? []).length >= 1, "no baseline version");
  assert.equal(listLocationsFor(owner.tenantId).length, 2);
});

await test("a manager or staff member cannot add a location", () => {
  const manager = createUser({ email: "manager@palmgroup.test", name: "Mona", password: "Correct-Horse-Battery-9", role: "manager", tenantId: owner.tenantId });
  assert.ok(manager.ok);
  const out = createLocation(manager.ok ? manager.user : null!, { name: "Rogue branch", vertical: "clinic" });
  assert.equal(out.ok, false);
});

await test("bad details are refused with the field named", () => {
  for (const [input, field] of [
    [{ name: "X", vertical: "clinic" }, "name"],
    [{ name: "Palm Two", vertical: "garage" }, "vertical"],
    [{ name: "Palm Two", vertical: "clinic", timezone: "Mars/Olympus" }, "timezone"],
    [{ name: "Palm Two", vertical: "clinic", currency: "dirhams" }, "currency"],
    [{ name: "Palm Two", vertical: "clinic", phone: "call me" }, "phone"],
    // Without its country code (2026-09-16): refused, not guessed.
    [{ name: "Palm Two", vertical: "clinic", phone: "04 555 0199" }, "phone"],
  ] as const) {
    const out = createLocation(me(), input);
    assert.equal(out.ok, false, JSON.stringify(input));
    assert.equal(out.ok ? "" : out.field, field);
  }
});

await test("the basics can be changed — name, hours, closures — but never the kind of business", () => {
  const hours = { 0: [], 1: [{ start: 480, end: 1200 }], 2: [{ start: 480, end: 1200 }], 3: [], 4: [], 5: [], 6: [] };
  const out = updateLocationBasics(me(), branch, { name: "Palm Clinic Marina", hours, closures: ["2026-12-02", "2026-12-02", "2026-12-03"] });
  assert.ok(out.ok, out.ok ? "" : out.error);
  const loc = getLocation(branch)!;
  assert.equal(loc.name, "Palm Clinic Marina");
  assert.deepEqual(loc.hours[1], [{ start: 480, end: 1200 }]);
  assert.deepEqual(loc.closures, ["2026-12-02", "2026-12-03"]);
  assert.equal(updateLocationBasics(me(), branch, { vertical: "restaurant" }).ok, false);
  assert.equal(updateLocationBasics(me(), branch, { hours: { 1: [{ start: 900, end: 600 }] } }).ok, false);
});

await test("archiving hides a location everywhere and keeps it restorable", () => {
  assert.ok(archiveLocation(me(), branch).ok);
  assert.ok(getLocation(branch)!.archivedAt);
  assert.ok(!listLocations().some((l) => l.id === branch), "still in the lists");
  assert.ok(!visibleLocations(me()).some((l) => l.id === branch), "still in the switcher");
  assert.ok(restoreLocation(me(), branch).ok);
  assert.equal(getLocation(branch)!.archivedAt, undefined);
});

await test("the last active location cannot be archived", () => {
  assert.ok(archiveLocation(me(), branch).ok);
  const out = archiveLocation(me(), first.id);
  assert.equal(out.ok, false);
  assert.ok(restoreLocation(me(), branch).ok);
});

await test("a location with history can only be archived, never deleted", () => {
  const withHistory = createLocation(me(), { name: "Palm Clinic JLT", vertical: "clinic" });
  assert.ok(withHistory.ok);
  const id = withHistory.ok ? withHistory.location.id : "";
  saveBooking({
    id: "bk_history", ref: "H1ST", locationId: id, vertical: "clinic", status: "cancelled",
    date: "2026-09-01", startMin: 600, endMin: 630, guestName: "Old Patient", guestPhone: "", notes: "",
  } as never);
  assert.ok(archiveLocation(me(), id).ok);
  const out = deleteLocation(me(), id, "Palm Clinic JLT");
  assert.equal(out.ok, false);
  assert.ok(getLocation(id), "a location with bookings was deleted");
});

await test("an empty, archived location is deleted once its name is typed", () => {
  const mistake = createLocation(me(), { name: "Typo Branch", vertical: "clinic" });
  assert.ok(mistake.ok);
  const id = mistake.ok ? mistake.location.id : "";
  assert.equal(deleteLocation(me(), id, "Typo Branch").ok, false, "deleted without archiving first");
  assert.ok(archiveLocation(me(), id).ok);
  assert.equal(deleteLocation(me(), id, "typo").ok, false, "deleted with the wrong name");
  assert.ok(deleteLocation(me(), id, "Typo Branch").ok);
  assert.equal(getLocation(id), undefined);
});

await test("nobody reaches a location in another business", async () => {
  const other = await signUp({ businessName: "Other Salon", email: "owner@othersalon.test", password: "Correct-Horse-Battery-9", vertical: "salon", timezone: "Asia/Dubai" });
  assert.ok(other.ok);
  const theirs = other.ok ? other.location.id : "";
  assert.equal(updateLocationBasics(me(), theirs, { name: "Mine now" }).ok, false);
  assert.equal(archiveLocation(me(), theirs).ok, false);
});

console.log("\n\x1b[1mBookings at the desk\x1b[0m\n");

const salon = listLocations().find((l) => l.vertical === "salon" && (l.salon?.services.length ?? 0) >= 2 && (l.salon?.staff.length ?? 0) >= 1)!;
const [svcA, svcB] = salon.salon!.services;

function freeSlot(serviceIds: string[]) {
  const today = todayIn(salon.timezone);
  for (let d = 2; d < 16; d++) {
    const date = addDays(today, d);
    const slots = findAvailability(salon, { locationId: salon.id, date, serviceIds, preferredMin: 11 * 60, staffOverride: true });
    if (slots.length) return { date, startMin: slots[0].startMin };
  }
  throw new Error("no free slot in two weeks");
}

let bookingId = "";

await test("a booking with two services and an email is taken, and runs longer than either alone", () => {
  const slot = freeSlot([svcA.id, svcB.id]);
  const out = createFromDesk(salon, { ...slot, serviceIds: [svcA.id, svcB.id], guestName: "Noor Haddad", guestPhone: "050 111 2233", guestEmail: "noor@example.com" });
  assert.ok(out.ok, out.ok ? "" : out.error);
  const booking = out.ok ? out.booking : null!;
  bookingId = booking.id;
  assert.deepEqual(booking.serviceIds, [svcA.id, svcB.id]);
  assert.equal(booking.guestEmail, "noor@example.com");
  // Chained services can share processing time, so the booking need not be
  // the plain sum — but it must be longer than either service on its own.
  const single = (id: string) => {
    const alone = createFromDesk(salon, { ...freeSlot([id]), serviceIds: [id], guestName: `Probe ${id}` });
    assert.ok(alone.ok);
    return alone.ok ? alone.booking.endMin - alone.booking.startMin : 0;
  };
  const both = booking.endMin - booking.startMin;
  assert.ok(both > single(svcA.id) && both > single(svcB.id), "no longer than a single service");
});

await test("a desk booking needs a name, a service and a real email", () => {
  const slot = freeSlot([svcA.id]);
  assert.equal(createFromDesk(salon, { ...slot, serviceIds: [svcA.id], guestName: " " }).ok, false);
  assert.equal(createFromDesk(salon, { ...slot, serviceIds: [], guestName: "Sam" }).ok, false);
  assert.equal(createFromDesk(salon, { ...slot, serviceIds: [svcA.id], guestName: "Sam", guestEmail: "sam@" }).ok, false);
});

await test("the guest's details change without moving the appointment", async () => {
  const { getBooking } = await import("../src/lib/store");
  const before = getBooking(bookingId)!;
  const out = updateFromDesk(salon, before, { guestName: "Noor H. Haddad", guestEmail: "noor.h@example.com" });
  assert.ok(out.ok, out.ok ? "" : out.error);
  const after = getBooking(bookingId)!;
  assert.equal(after.guestName, "Noor H. Haddad");
  assert.equal(after.guestEmail, "noor.h@example.com");
  assert.equal(after.startMin, before.startMin);
  assert.equal(after.date, before.date);
});

await test("dropping a service shortens the booking, through the engine", async () => {
  const { getBooking } = await import("../src/lib/store");
  const before = getBooking(bookingId)!;
  const out = updateFromDesk(salon, before, { serviceIds: [svcA.id] });
  assert.ok(out.ok, out.ok ? "" : out.error);
  const after = getBooking(bookingId)!;
  assert.deepEqual(after.serviceIds, [svcA.id]);
  assert.ok(after.endMin < before.endMin, "the booking did not get shorter");
});

await test("a cancelled booking cannot be edited, and a bad email is refused", async () => {
  const { getBooking } = await import("../src/lib/store");
  const current = getBooking(bookingId)!;
  assert.equal(updateFromDesk(salon, current, { guestEmail: "nope" }).ok, false);
  assert.equal(updateFromDesk(salon, { ...current, status: "cancelled" }, { guestName: "Someone" }).ok, false);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
