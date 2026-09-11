/**
 * Signing up, without a person in the loop.
 *
 * This is the first route in Belline that is public, unauthenticated and
 * writes — so the things worth testing are not the happy path, which is
 * obvious, but the four ways it could quietly go wrong.
 *
 * **A new account is a new tenant.** Two businesses signing up ten seconds
 * apart must not be able to see each other's anything. The tenancy layer
 * enforces that, and this proves it end to end from the signup rather than
 * from a fixture.
 *
 * **The trial is capped.** An account nobody is watching must not be able to
 * run up a vendor bill. Fourteen days and thirty minutes, written at signup
 * rather than assumed by a job that might not run.
 *
 * **A new venue is blank, not plausible.** Seeding a fictional stylist and a
 * made-up price list makes a venue that looks configured and answers wrongly.
 * An obviously empty diary is a prompt to finish; a confidently wrong one is
 * a customer complaint.
 *
 * **The draft is never live until a person says so.** Everything the website
 * reader produces is a model's impression of a public page. `applyDraft`
 * takes only what was confirmed.
 *
 *   npm run check:signup
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-signup-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp, applyDraft, readiness } = await import("../src/lib/onboarding");
const { getLocation, listLocationsFor, listTenants, getBusiness, listUsers } = await import(
  "../src/lib/store"
);
const { canSeeLocation, visibleLocations } = await import("../src/lib/auth");
const { DEFAULT_TENANT_ID } = await import("../src/lib/tenancy");
const { historyFor } = await import("../src/lib/brain");

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

const PASSWORD = "Correct-Horse-Battery-9";

console.log("\n\x1b[1mAn account can be created without us\x1b[0m\n");

const first = await signUp({
  businessName: "Marina Hair Studio",
  email: "owner@marinahair.test",
  password: PASSWORD,
  vertical: "salon",
  timezone: "Asia/Dubai",
});
assert.ok(first.ok, "the first signup failed");
const alpha = first.ok ? first : null!;

await test("signing up creates a tenant, a business, a venue and an owner", () => {
  assert.ok(alpha.user.tenantId);
  assert.notEqual(alpha.user.tenantId, DEFAULT_TENANT_ID, "landed in the shared tenant");
  assert.equal(alpha.user.role, "owner");
  assert.equal(alpha.location.tenantId, alpha.user.tenantId);
  assert.ok(getBusiness(alpha.user.tenantId, alpha.location.businessId));
  assert.equal(getLocation(alpha.location.id)?.name, "Marina Hair Studio");
});

await test("the venue starts on a capped trial, not on a plan", () => {
  const sub = getLocation(alpha.location.id)?.subscription;
  assert.equal(sub?.status, "trialing");
  assert.ok(sub?.trial, "no trial was written");
  assert.equal(sub?.trial?.minutes, 30);
  // Fourteen days from today, so an unattended account expires on its own.
  const days =
    (Date.parse(`${sub!.trial!.endsOn}T12:00:00Z`) - Date.parse(`${sub!.startedOn}T12:00:00Z`)) /
    86_400_000;
  assert.equal(Math.round(days), 14);
});

await test("the new venue is blank rather than plausibly wrong", () => {
  const venue = getLocation(alpha.location.id)!;
  assert.equal(venue.salon?.services.length, 0, "invented services");
  assert.equal(venue.salon?.staff.length, 0, "invented staff");
  assert.equal(venue.agent.faqs.length, 0, "invented FAQs");
  assert.equal(venue.address, "");
  // But it does have the things that are true of every business.
  assert.ok(venue.agent.greeting.includes("Marina Hair Studio"));
  assert.ok(Object.keys(venue.hours).length, "no opening hours at all");
});

await test("the venue has a version 1 from the first second", () => {
  // So "what did it say on the call I am complaining about" has an answer
  // from day one rather than day two.
  assert.ok(historyFor(getLocation(alpha.location.id)!).length >= 1);
});

console.log("\n\x1b[1mTwo customers are two worlds\x1b[0m\n");

const second = await signUp({
  businessName: "Downtown Dental",
  email: "owner@downtowndental.test",
  password: PASSWORD,
  vertical: "clinic",
  timezone: "Asia/Dubai",
});
assert.ok(second.ok, "the second signup failed");
const beta = second.ok ? second : null!;

await test("the second account is a different tenant", () => {
  assert.notEqual(beta.user.tenantId, alpha.user.tenantId);
});

await test("neither owner can see the other's venue", () => {
  assert.equal(canSeeLocation(alpha.user, beta.location.id), false);
  assert.equal(canSeeLocation(beta.user, alpha.location.id), false);
  assert.equal(canSeeLocation(alpha.user, alpha.location.id), true);
});

await test("neither owner's venue list contains the other's", () => {
  const mine = visibleLocations(alpha.user).map((l) => l.id);
  assert.ok(mine.includes(alpha.location.id));
  assert.equal(mine.includes(beta.location.id), false);
  // Nor the seeded demo venues, which belong to the original tenant.
  assert.equal(mine.includes("loc_azure"), false);
  assert.equal(mine.length, 1);
});

await test("a venue lookup scoped to the wrong tenant finds nothing", () => {
  assert.equal(
    listLocationsFor(alpha.user.tenantId).some((l) => l.id === beta.location.id),
    false,
  );
});

await test("neither can see the other's business record", () => {
  assert.equal(getBusiness(alpha.user.tenantId, beta.location.businessId), undefined);
});

console.log("\n\x1b[1mWhat it refuses\x1b[0m\n");

await test("the same email cannot sign up twice", async () => {
  const again = await signUp({
    businessName: "Somebody Else",
    email: "owner@marinahair.test",
    password: PASSWORD,
    vertical: "salon",
  });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.field, "email");
});

await test("a mistyped address is caught before the account exists", async () => {
  const before = listTenants().length;
  const bad = await signUp({
    businessName: "Typo Salon",
    email: "owner@@nowhere",
    password: PASSWORD,
    vertical: "salon",
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.field, "email");
  // And nothing was written on the way to finding out.
  assert.equal(listTenants().length, before, "a tenant was created for a rejected signup");
});

await test("a weak password is refused", async () => {
  const weak = await signUp({
    businessName: "Weak Password Salon",
    email: "weak@example.test",
    password: "password",
    vertical: "salon",
  });
  assert.equal(weak.ok, false);
  if (!weak.ok) assert.equal(weak.field, "password");
});

await test("a business with no name is refused", async () => {
  const nameless = await signUp({
    businessName: " ",
    email: "nameless@example.test",
    password: PASSWORD,
    vertical: "salon",
  });
  assert.equal(nameless.ok, false);
  if (!nameless.ok) assert.equal(nameless.field, "businessName");
});

await test("every account that exists has exactly one owner and one tenant", () => {
  const owners = listUsers().filter((u) => u.email.endsWith(".test"));
  const tenants = new Set(owners.map((u) => u.tenantId));
  assert.equal(tenants.size, owners.length, "two accounts share a tenant");
});

console.log("\n\x1b[1mThe draft is a proposal, not a configuration\x1b[0m\n");

await test("applying a confirmed draft fills the venue", () => {
  const updated = applyDraft(getLocation(alpha.location.id)!, {
    address: "Marina Walk, Dubai",
    phone: "+97144000000",
    services: [
      { name: "Cut and finish", durationMin: 60, price: 220 },
      { name: "Colour", durationMin: 120, price: 450 },
    ],
    staff: ["Marta", "Sarah"],
    faqs: [{ q: "Is there parking?", a: "Yes, under the building, free for two hours." }],
    policies: ["Never book a colour without a patch test 48 hours before."],
  });

  assert.equal(updated.address, "Marina Walk, Dubai");
  assert.equal(updated.salon?.services.length, 2);
  assert.equal(updated.salon?.services[0].name, "Cut and finish");
  assert.equal(updated.salon?.staff.length, 2);
  assert.equal(updated.agent.faqs.length, 1);
  assert.equal(updated.agent.policies.length, 1);
});

await test("services get a cleanup buffer the guest is never quoted", () => {
  const venue = getLocation(alpha.location.id)!;
  assert.ok(venue.salon!.services.every((s) => s.bufferMin > 0));
});

await test("everyone can do everything until somebody says otherwise", () => {
  // The opposite default — nobody qualified for anything — produces a venue
  // that can never offer a slot, which reads as broken rather than unfinished.
  const venue = getLocation(alpha.location.id)!;
  const serviceIds = venue.salon!.services.map((s) => s.id);
  for (const person of venue.salon!.staff) {
    assert.deepEqual(person.serviceIds, serviceIds);
  }
});

await test("a field left out of the draft does not blank what was there", () => {
  // A second pass that only confirms the address must not wipe the services.
  const updated = applyDraft(getLocation(alpha.location.id)!, { address: "Marina Walk, Dubai" });
  assert.equal(updated.salon?.services.length, 2);
  assert.equal(updated.agent.faqs.length, 1);
});

await test("readiness names what is still missing, in the owner's words", () => {
  const fresh = getLocation(beta.location.id)!;
  const state = readiness(fresh);
  assert.equal(state.ready, false);
  assert.ok(state.missing.length > 0);
  // Not field names. A clinic owner should read "Who works there", not
  // "salon.staff".
  assert.equal(
    state.missing.some((m) => /[._]/.test(m.label)),
    false,
    `a raw field name leaked into the UI: ${JSON.stringify(state.missing)}`,
  );

  const done = getLocation(alpha.location.id)!;
  assert.equal(readiness(done).ready, true, `still not ready: ${JSON.stringify(readiness(done))}`);
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
