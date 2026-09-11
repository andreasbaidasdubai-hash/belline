/**
 * Who owns what.
 *
 * Tenancy arrived after the data did, which makes two things worth testing
 * rather than assuming.
 *
 * The first is that the migration is invisible: every venue, user and business
 * that existed before still resolves to the same place afterwards, and running
 * it twice changes nothing. A migration that is not idempotent is one that
 * corrupts the book on the second boot.
 *
 * The second is the property a customer will actually ask about — that one
 * tenant cannot reach another's data. The version of `canSeeLocation` this
 * replaced returned `true` for an owner asking about *any* venue id, which
 * inside one venue group was true by definition and across tenants was the
 * whole isolation problem in one line. That case is pinned here so it cannot
 * come back.
 *
 *   npm run check:tenancy
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-tenancy-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const {
  getLocation,
  listLocations,
  listTenants,
  getTenant,
  listBusinesses,
  getBusiness,
  listLocationsFor,
  getLocationFor,
  saveTenant,
  saveBusiness,
  upsertLocation,
  saveUser,
  listUsers,
} = await import("../src/lib/store");
const { DEFAULT_TENANT_ID, BELLINE_TENANT_ID, ensureTenancy, userCanSeeLocation } =
  await import("../src/lib/tenancy");
const { canSeeLocation, visibleLocations, createUser } = await import("../src/lib/auth");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");

let passed = 0;
let failed = 0;
let queue: Promise<void> = Promise.resolve();

function test(name: string, fn: () => void | Promise<void>) {
  queue = queue.then(async () => {
    try {
      await fn();
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } catch (err) {
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`      ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  });
}

seedIfEmpty();

console.log("\n\x1b[1mEverything has an owner\x1b[0m\n");

test("both tenants exist after seeding", () => {
  assert.ok(getTenant(DEFAULT_TENANT_ID), "the customer tenant is missing");
  assert.ok(getTenant(BELLINE_TENANT_ID), "Belline's own tenant is missing");
  // Not a count: the isolation fixtures further down this file add a third,
  // and they run before any queued test body does.
  assert.ok(listTenants().length >= 2);
});

test("every venue names a tenant and a business", () => {
  for (const l of listLocations({ includeInternal: true })) {
    assert.ok(l.tenantId, `${l.name} has no tenant`);
    assert.ok(l.businessId, `${l.name} has no business`);
    assert.ok(
      getBusiness(l.tenantId, l.businessId),
      `${l.name} names a business that does not exist in its tenant`,
    );
  }
});

test("Belline's own venue is in Belline's tenant, not a customer's", () => {
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  assert.equal(belline.tenantId, BELLINE_TENANT_ID);
  // Two independent defences: ownership, and the flag that predates it.
  assert.equal(belline.internal, true);
  assert.equal(
    listLocationsFor(DEFAULT_TENANT_ID, { includeInternal: true }).some(
      (l) => l.id === BELLINE_LOCATION_ID,
    ),
    false,
    "Belline's demo venue is reachable from the customer tenant",
  );
});

test("running the migration again changes nothing", () => {
  const before = JSON.stringify({
    locations: listLocations({ includeInternal: true }),
    tenants: listTenants(),
    businesses: [
      ...listBusinesses(DEFAULT_TENANT_ID),
      ...listBusinesses(BELLINE_TENANT_ID),
    ],
  });
  ensureTenancy();
  ensureTenancy();
  const after = JSON.stringify({
    locations: listLocations({ includeInternal: true }),
    tenants: listTenants(),
    businesses: [
      ...listBusinesses(DEFAULT_TENANT_ID),
      ...listBusinesses(BELLINE_TENANT_ID),
    ],
  });
  assert.equal(after, before);
});

test("a venue that predates tenancy is adopted rather than rewritten", () => {
  const orphan = {
    ...getLocation("loc_azure")!,
    id: "loc_orphan",
    name: "Orphan Grill",
  };
  // Exactly the shape the book held before this change: no owner at all.
  delete (orphan as Partial<typeof orphan>).tenantId;
  delete (orphan as Partial<typeof orphan>).businessId;
  upsertLocation(orphan as typeof orphan);

  ensureTenancy();

  const adopted = getLocation("loc_orphan")!;
  assert.equal(adopted.tenantId, DEFAULT_TENANT_ID);
  assert.ok(adopted.businessId);
  assert.equal(adopted.name, "Orphan Grill", "the migration changed the venue itself");
  assert.ok(getBusiness(DEFAULT_TENANT_ID, adopted.businessId));
});

console.log("\n\x1b[1mOne tenant cannot reach another\x1b[0m\n");

// A second customer, with a venue of their own.
const OTHER = "tnt_other";
saveTenant({ id: OTHER, name: "Someone else", status: "active", createdAt: new Date().toISOString() });
saveBusiness({
  id: "biz_other",
  tenantId: OTHER,
  name: "Someone Else's Salon",
  createdAt: new Date().toISOString(),
});
const foreign = {
  ...getLocation("loc_azure")!,
  id: "loc_foreign",
  name: "Someone Else's Salon",
  tenantId: OTHER,
  businessId: "biz_other",
};
upsertLocation(foreign);

const ours = createUser({
  email: "owner@ours.test",
  name: "Our owner",
  password: "Correct-Horse-Battery-9",
  role: "owner",
});
assert.ok(ours.ok, "could not create the test owner");
const owner = ours.ok ? ours.user : null!;

test("an owner sees their own venues", () => {
  assert.equal(canSeeLocation(owner, "loc_azure"), true);
});

test("an owner cannot see another tenant's venue", () => {
  // The case the old implementation got wrong: role === "owner" returned true
  // before anything about the venue was considered.
  assert.equal(canSeeLocation(owner, "loc_foreign"), false);
  assert.equal(userCanSeeLocation(owner, foreign), false);
});

test("a foreign venue never appears in the list either", () => {
  const visible = visibleLocations(owner).map((l) => l.id);
  assert.equal(visible.includes("loc_foreign"), false);
  assert.ok(visible.includes("loc_azure"));
});

test("an id from another tenant does not resolve through the scoped accessor", () => {
  assert.equal(getLocationFor(DEFAULT_TENANT_ID, "loc_foreign"), undefined);
  assert.ok(getLocationFor(OTHER, "loc_foreign"));
  assert.ok(getLocationFor(DEFAULT_TENANT_ID, "loc_azure"));
});

test("a business is invisible from the wrong tenant", () => {
  assert.equal(getBusiness(DEFAULT_TENANT_ID, "biz_other"), undefined);
  assert.ok(getBusiness(OTHER, "biz_other"));
  assert.equal(
    listBusinesses(DEFAULT_TENANT_ID).some((b) => b.id === "biz_other"),
    false,
  );
});

test("a venue id in the wrong tenant is refused even if the user lists it", () => {
  // The belt to the tenant check's braces: a stale id in `locationIds` — from
  // a venue that moved, or a hand-edited record — must not grant anything.
  const staff = createUser({
    email: "staff@ours.test",
    name: "Our staff",
    password: "Correct-Horse-Battery-9",
    role: "staff",
    locationIds: ["loc_azure", "loc_foreign"],
  });
  assert.ok(staff.ok);
  const user = staff.ok ? staff.user : null!;
  assert.equal(canSeeLocation(user, "loc_azure"), true);
  assert.equal(canSeeLocation(user, "loc_foreign"), false);
});

test("a venue that does not exist is not visible to anyone", () => {
  // Used to return true for an owner, which made every ownership check pass
  // for a mistyped id.
  assert.equal(canSeeLocation(owner, "loc_does_not_exist"), false);
});

test("every user belongs to a tenant", () => {
  for (const u of listUsers()) assert.ok(u.tenantId, `${u.email} has no tenant`);
});

test("a user written without a tenant is adopted by the migration", () => {
  const legacy = { ...owner, id: "usr_legacy", email: "legacy@ours.test" };
  delete (legacy as Partial<typeof legacy>).tenantId;
  saveUser(legacy as typeof legacy);
  ensureTenancy();
  assert.equal(listUsers().find((u) => u.id === "usr_legacy")?.tenantId, DEFAULT_TENANT_ID);
});

await queue;

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
