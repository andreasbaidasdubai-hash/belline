/**
 * Adding, archiving and deleting a location — the rules that keep it safe.
 *
 * A free trial covers one location, so adding a second is refused until one
 * location is on a plan, and the page says so instead of offering a button
 * that fails. Deleting is refused for the account's last location, for a
 * location carrying a paid plan (Stripe would go on charging), for a location
 * with bookings or calls (archived instead, so customers' records are kept),
 * for another business's location and for anybody but the owner. A location
 * that is archived or deleted answers nothing: not by its Belline number, not
 * by its website key, not by its chat link, not by a stream token.
 *
 *   npm run check:locations
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-locations-"));
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FLAG_BILLING_STRIPE;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { createUser } = await import("../src/lib/auth");
const store = await import("../src/lib/store");
const locations = await import("../src/lib/locations");
const { serviceState } = await import("../src/lib/billing/entitlement");
const { mayStreamTo } = await import("../src/lib/voice/entitlement");
const { venueForDialledNumber } = await import("../src/lib/telephony/number");
const { addPoolNumbers, recordManualAssignment } = await import("../src/lib/telephony/pool");
const { enableEmbed } = await import("../src/lib/embed");
const { ensureChatLink, findChatVenue } = await import("../src/lib/chat-link");

const { getLocation, getUser, listLocations, listLocationsFor, upsertLocation, saveBooking, listPoolRows } = store;
const { addAllowance, archiveLocation, createLocation, deleteLocation, removalOf, restoreLocation, updateLocationBasics } = locations;

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

let n = 0;
async function business(name: string) {
  n++;
  const made = await signUp({
    businessName: name,
    email: `owner${n}@locations.test`,
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
  });
  assert.ok(made.ok, "signup failed");
  const { user, location } = made as Extract<typeof made, { ok: true }>;
  return { ownerId: user.id, first: location.id, me: () => getUser(user.id)! };
}

/** The checkout's result, without Stripe: the venue's subscription is active. */
function pay(locationId: string) {
  const venue = getLocation(locationId)!;
  upsertLocation({ ...venue, subscription: { ...venue.subscription!, status: "active" }, stripe: { customerId: "cus_test", subscriptionId: "sub_test" } });
}

const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");

console.log("\n\x1b[1mAdding a location follows the plan\x1b[0m\n");

const trial = await business("Trial Salon");

await test("on a free trial a second location is refused, with the reason and no plan that cannot be chosen", () => {
  const allowance = addAllowance(trial.me());
  assert.equal(allowance.allowed, false);
  const reason = allowance.allowed ? "" : allowance.reason;
  assert.match(reason, /free trial covers one location/);
  // Card payments are off in this check: there is no plan to choose, and the
  // sentence must not tell the owner to choose one.
  assert.equal(allowance.allowed ? null : allowance.choosePlan, false);
  assert.match(reason, /not open yet/);
  const out = createLocation(trial.me(), { name: "Trial Salon Two", vertical: "salon" });
  assert.equal(out.ok, false);
  assert.equal(listLocationsFor(trial.me().tenantId).length, 1, "the refused location was saved anyway");
});

const paid = await business("Paid Salon");
pay(paid.first);
let branch = "";

await test("once a location is on a plan, another can be added — and it starts its own trial", () => {
  const allowance = addAllowance(paid.me());
  assert.equal(allowance.allowed, true);
  assert.match(allowance.allowed ? allowance.sentence : "", /its own 30-day trial/);
  const out = createLocation(paid.me(), { name: "Paid Salon Marina", vertical: "salon" });
  assert.ok(out.ok, out.ok ? "" : out.error);
  branch = out.ok ? out.location.id : "";
  assert.equal(getLocation(branch)!.subscription?.status, "trialing");
  assert.equal(listLocationsFor(paid.me().tenantId).length, 2);
});

await test("a manager and floor staff cannot add one", () => {
  for (const role of ["manager", "staff"] as const) {
    const made = createUser({ email: `${role}@paidsalon.test`, name: role, password: "Correct-Horse-Battery-9", role, tenantId: paid.me().tenantId });
    assert.ok(made.ok);
    const person = made.ok ? made.user : null!;
    assert.equal(addAllowance(person).allowed, false);
    assert.equal(createLocation(person, { name: "Rogue", vertical: "salon" }).ok, false);
  }
});

await test("the page offers the button only when adding would work, and links to the plan otherwise", () => {
  const manager = src("src", "app", "(app)", "locations", "LocationsManager.tsx");
  assert.match(manager, /canManage && add\.allowed && \([\s\S]{0,300}Add a location/);
  assert.match(manager, /canManage && !add\.allowed && \([\s\S]{0,400}add\.reason[\s\S]{0,200}add\.choosePlan && [\s\S]{0,120}href="\/checkout"/);
  const page = src("src", "app", "(app)", "locations", "page.tsx");
  assert.match(page, /addAllowance\(user\)/);
});

console.log("\n\x1b[1mDeleting and archiving\x1b[0m\n");

await test("the last active location of an account can be neither archived nor deleted", async () => {
  const solo = await business("Solo Salon");
  const venue = getLocation(solo.first)!;
  assert.equal(removalOf(solo.me(), venue).delete?.code, "last");
  const del = deleteLocation(solo.me(), solo.first, venue.name);
  assert.equal(del.ok, false);
  assert.match(del.ok ? "" : del.error, /only active location/);
  assert.equal(archiveLocation(solo.me(), solo.first).ok, false);
  assert.ok(getLocation(solo.first));
});

await test("a location carrying a paid plan is refused, and pointed at Billing", () => {
  const venue = getLocation(paid.first)!;
  const del = deleteLocation(paid.me(), paid.first, venue.name);
  assert.equal(del.ok, false);
  assert.match(del.ok ? "" : del.error, /paid plan[\s\S]*Billing/);
  const arch = archiveLocation(paid.me(), paid.first);
  assert.equal(arch.ok, false, "archived a venue Stripe is still charging for");
  assert.equal(removalOf(paid.me(), venue).archive?.code, "paid");
  // A Stripe subscription not yet marked active still counts.
  upsertLocation({ ...getLocation(branch)!, stripe: { subscriptionId: "sub_pending" } });
  assert.equal(deleteLocation(paid.me(), branch, "Paid Salon Marina").ok, false);
  upsertLocation({ ...getLocation(branch)!, stripe: undefined });
  assert.ok(getLocation(paid.first));
});

await test("another business's location, and anybody but the owner, is refused", async () => {
  const other = await business("Other Salon");
  const theirs = getLocation(other.first)!;
  assert.equal(deleteLocation(paid.me(), theirs.id, theirs.name).ok, false);
  assert.equal(archiveLocation(paid.me(), theirs.id).ok, false);
  assert.ok(getLocation(theirs.id));
  for (const email of ["manager@paidsalon.test", "staff@paidsalon.test"]) {
    const person = store.findUserByEmail(email)!;
    assert.equal(deleteLocation(person, branch, "Paid Salon Marina").ok, false, email);
    assert.equal(archiveLocation(person, branch).ok, false, email);
  }
  assert.ok(getLocation(branch));
});

await test("a location with bookings is never deleted for good — it is archived instead", () => {
  const out = createLocation(paid.me(), { name: "Paid Salon JLT", vertical: "salon" });
  assert.ok(out.ok);
  const id = out.ok ? out.location.id : "";
  saveBooking({
    id: "bk_loc_history", ref: "LOCH1", locationId: id, vertical: "salon", status: "cancelled",
    date: "2026-09-01", startMin: 600, endMin: 630, guestName: "Old Guest", guestPhone: "", notes: "",
  } as never);
  const removal = removalOf(paid.me(), getLocation(id)!);
  assert.equal(removal.delete?.code, "history");
  assert.equal(removal.archive, null, "the way out, archiving, is not offered");
  assert.equal(deleteLocation(paid.me(), id, "Paid Salon JLT").ok, false);
  assert.ok(archiveLocation(paid.me(), id).ok);
  assert.equal(deleteLocation(paid.me(), id, "Paid Salon JLT").ok, false, "archived, but its history was erased");
  assert.ok(getLocation(id));
});

await test("a team member who can see only this location blocks deleting it, rather than being given every location", () => {
  const out = createLocation(paid.me(), { name: "Paid Salon Pop-up", vertical: "salon" });
  assert.ok(out.ok);
  const id = out.ok ? out.location.id : "";
  const made = createUser({ email: "popup@paidsalon.test", name: "Pia", password: "Correct-Horse-Battery-9", role: "manager", locationIds: [id], tenantId: paid.me().tenantId });
  assert.ok(made.ok);
  const del = deleteLocation(paid.me(), id, "Paid Salon Pop-up");
  assert.equal(del.ok, false);
  assert.match(del.ok ? "" : del.error, /Pia can only see this location/);
  // …and that manager cannot edit a branch they cannot see.
  assert.equal(updateLocationBasics(made.ok ? made.user : null!, branch, { name: "Renamed by Pia" }).ok, false);
  assert.equal(getLocation(branch)!.name, "Paid Salon Marina");
});

console.log("\n\x1b[1mA location that is gone answers nothing\x1b[0m\n");

/** Give a venue a Belline number from the pool, a website key and a chat link. */
function wire(id: string, number: string) {
  addPoolNumbers([number]);
  recordManualAssignment(id, number, "check");
  let venue = upsertLocation({ ...getLocation(id)!, bellineNumber: { number, via: "staff", assignedAt: new Date().toISOString() } });
  venue = upsertLocation(enableEmbed(venue, ["https://paidsalon.ae"]));
  venue = ensureChatLink(venue);
  return venue;
}
const doors = () => listLocations({ includeInternal: true });

await test("an archived location: no call by its number, no widget, no chat link, no stream, not answering", () => {
  const venue = wire(branch, "+97140000901");
  assert.equal(venueForDialledNumber(doors(), "+97140000901")?.id, branch, "wired venue not found before archiving");
  assert.ok(archiveLocation(paid.me(), branch).ok);
  const archived = getLocation(branch)!;
  assert.equal(venueForDialledNumber(doors(), "+97140000901"), undefined, "an archived venue still answers its number");
  assert.equal(doors().find((l) => l.embed?.enabled && l.embed.key === venue.embed!.key), undefined, "the embed key still resolves");
  assert.equal(findChatVenue(venue.embed!.key), null);
  assert.equal(findChatVenue(venue.chatLink!.key), null);
  assert.equal(mayStreamTo(archived), false, "a stream token still opens a socket");
  for (const channel of ["phone", "web_voice", "chat", "whatsapp"] as const) {
    const state = serviceState(archived, "2026-09-17", { channel });
    assert.equal(state.answering, false, channel);
    assert.equal(state.refused, "archived", channel);
  }
  // The number stays held while archived, so a restore answers on it again.
  assert.equal(listPoolRows().find((r) => r.number === "+97140000901")?.status, "assigned");
  assert.ok(!listLocationsFor(paid.me().tenantId).some((l) => l.id === branch));
});

await test("restoring follows the same limit as adding", async () => {
  assert.ok(restoreLocation(paid.me(), branch).ok);
  assert.equal(venueForDialledNumber(doors(), "+97140000901")?.id, branch);
  // A trial business that archived its first location to add another cannot
  // bring the first back beside it.
  const t = await business("Trial Two Salon");
  pay(t.first);
  const second = createLocation(t.me(), { name: "Trial Two Branch", vertical: "salon" });
  assert.ok(second.ok);
  const secondId = second.ok ? second.location.id : "";
  const firstVenue = getLocation(t.first)!;
  upsertLocation({ ...firstVenue, subscription: { ...firstVenue.subscription!, status: "cancelled", cancelledAt: "2026-09-01T00:00:00Z" }, stripe: undefined });
  assert.ok(archiveLocation(t.me(), t.first).ok, "a cancelled plan should not stop archiving");
  assert.equal(addAllowance(t.me()).allowed, false);
  assert.equal(restoreLocation(t.me(), t.first).ok, false);
  assert.ok(getLocation(t.first)!.archivedAt);
  void secondId;
});

await test("deleting an empty location removes it, releases its number and it answers nothing", () => {
  const out = createLocation(paid.me(), { name: "Paid Salon Typo", vertical: "salon" });
  assert.ok(out.ok);
  const id = out.ok ? out.location.id : "";
  const venue = wire(id, "+97140000902");
  assert.equal(deleteLocation(paid.me(), id, "Paid Salon").ok, false, "deleted with the wrong name");
  assert.ok(getLocation(id));
  const del = deleteLocation(paid.me(), id, "Paid Salon Typo");
  assert.ok(del.ok, del.ok ? "" : del.error);
  assert.equal(getLocation(id), undefined);
  assert.ok(!listLocationsFor(paid.me().tenantId, { includeArchived: true }).some((l) => l.id === id), "still listed");
  assert.equal(venueForDialledNumber(doors(), "+97140000902"), undefined);
  assert.equal(findChatVenue(venue.embed!.key), null);
  assert.equal(findChatVenue(venue.chatLink!.key), null);
  // Quarantined, not free: an old caller must not reach a new venue.
  assert.equal(listPoolRows().find((r) => r.number === "+97140000902")?.status, "quarantine");
});

await test("the confirmation is an accessible modal: named, described, Escape cancels, focus goes in", () => {
  const manager = src("src", "app", "(app)", "locations", "LocationsManager.tsx");
  assert.match(manager, /<dialog[^>]*aria-labelledby=\{titleId\}[^>]*aria-describedby=\{bodyId\}/);
  assert.match(manager, /showModal\(\)/);
  assert.match(manager, /addEventListener\("cancel"/, "Escape does not go through onClose");
  assert.match(manager, /data-autofocus/);
  assert.match(manager, /disabled=\{busy \|\| typed\.trim\(\) !== venue\.name\}/, "delete is not held until the name is typed");
  // Every block is explained in the dialog with its way out.
  assert.match(manager, /block\.code === "paid"[\s\S]{0,200}\/billing/);
  assert.match(manager, /Archive instead/);
  // The drawer that edits a location closes on Escape too.
  assert.match(manager, /event\.key === "Escape"/);
  const route = src("src", "app", "api", "locations", "route.ts");
  for (const action of ["create", "update", "archive", "restore", "delete"]) assert.match(route, new RegExp(`case "${action}"`));
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
