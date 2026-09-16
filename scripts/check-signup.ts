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
 * run up a vendor bill. The catalogue's length and thirty minutes, written at
 * signup rather than assumed by a job that might not run.
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
const { TRIAL } = await import("../src/lib/billing/plans");
const { TRADES, tradeFromParam, verticalForTrade } = await import("../src/lib/signup-rules");

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
  // Catalogue 2026-10: 30 voice minutes and 50 text conversations.
  assert.equal(sub?.trial?.minutes, 30);
  assert.equal(sub?.trial?.conversations, 50);
  // The catalogue's length from today, so an unattended account expires on its own.
  const days =
    (Date.parse(`${sub!.trial!.endsOn}T12:00:00Z`) - Date.parse(`${sub!.startedOn}T12:00:00Z`)) /
    86_400_000;
  assert.equal(Math.round(days), TRIAL.days);
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

console.log("\n\x1b[1mAll or nothing, and the right defaults (P0-2)\x1b[0m\n");

// `tradeFromParam` is already in scope from the import at the top of the file.
const { PASSWORD_HINT, PASSWORD_MIN_LENGTH, PASSWORD_COMMON_WORDS, passwordProblem } =
  await import("../src/lib/signup-rules");
const auth = await import("../src/lib/auth");
const { listLocations, getTenant } = await import("../src/lib/store");
const { TOS_VERSION, DPA_VERSION } = await import("../src/lib/legal");
const { createSignupLimiter, clientKey, PEER_HEADER } = await import("../src/lib/onboarding/limit");
const { findOrphans } = await import("../src/lib/onboarding/orphans");

const counts = () => ({
  tenants: listTenants().length,
  locations: listLocations({ includeInternal: true, includeArchived: true }).length,
  users: listUsers().length,
});

for (const bad of ["short", "Belline-is-great-2026", "1234567890123"]) {
  await test(`a rejected password (${JSON.stringify(bad)}) writes nothing at all`, async () => {
    const before = counts();
    const result = await signUp({
      businessName: "Orphan Candidate Salon",
      email: `orphan-${bad.length}@example.test`,
      password: bad,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.field, "password");
    assert.deepEqual(counts(), before, "a rejected password left rows behind");
  });
}

await test("a write that fails half way is rolled back before the error escapes", async () => {
  const before = counts();
  let seen: { tenantId: string; businessId: string; locationId: string } | null = null;
  await assert.rejects(
    signUp(
      { businessName: "Half Way Salon", email: "halfway@example.test", password: PASSWORD, acceptedTerms: true },
      {
        ensureBaseline: (loc) => {
          seen = { tenantId: loc.tenantId, businessId: loc.businessId, locationId: loc.id };
          throw new Error("disk full");
        },
      },
    ),
    /disk full/,
  );
  assert.ok(seen, "the failure was never reached");
  const s = seen as { tenantId: string; businessId: string; locationId: string };
  assert.equal(getTenant(s.tenantId), undefined, "tenant left behind");
  assert.equal(getBusiness(s.tenantId, s.businessId), undefined, "business left behind");
  assert.equal(getLocation(s.locationId), undefined, "venue left behind");
  assert.deepEqual(counts(), before);
});

await test("a failed owner creation removes the tenant, business and venue too", async () => {
  const before = counts();
  const result = await signUp(
    { businessName: "Race Salon", email: "race@example.test", password: PASSWORD },
    { createUser: () => ({ ok: false, error: "There is already an account with that address." }) },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(counts(), before);
});

await test("the password hint, minLength and server rule come from one constant", async () => {
  assert.equal(auth.passwordProblem, passwordProblem, "auth.ts has its own copy of the rule");
  assert.ok(PASSWORD_HINT.includes(String(PASSWORD_MIN_LENGTH)), "hint does not state the length");
  for (const word of PASSWORD_COMMON_WORDS.filter((w) => /[a-z]/.test(w))) {
    assert.ok(passwordProblem(`xx-${word}-Correct-9`), `"${word}" is not refused`);
  }
  assert.ok(passwordProblem("a1-B".padEnd(PASSWORD_MIN_LENGTH - 1, "x")), "one short is accepted");
  assert.equal(passwordProblem("a1-B".padEnd(PASSWORD_MIN_LENGTH, "x")), null, "exact length refused");
  const form = fs.readFileSync(path.join(import.meta.dirname, "../src/app/checkout/CheckoutForm.tsx"), "utf8");
  assert.ok(form.includes("minLength={PASSWORD_MIN_LENGTH}"), "the input's minLength is typed by hand");
  assert.ok(form.includes("{PASSWORD_HINT}"), "the hint is typed by hand");
  assert.ok(!/twelve|minLength=\{\d+\}/i.test(form), "a hand-typed length is still in the form");
});

const matrix: { market?: string; browserZone?: string; currency: string; timezone: string }[] = [
  { market: "AE", browserZone: "Asia/Dubai", currency: "AED", timezone: "Asia/Dubai" },
  { market: "AE", browserZone: "Europe/Zurich", currency: "AED", timezone: "Asia/Dubai" },
  { market: "AE", browserZone: "Europe/London", currency: "AED", timezone: "Asia/Dubai" },
  { browserZone: "Europe/Berlin", currency: "AED", timezone: "Asia/Dubai" },
];
for (const [i, row] of matrix.entries()) {
  await test(`market ${row.market ?? "(unset)"} from a ${row.browserZone} browser gets ${row.currency} and ${row.timezone}`, async () => {
    const made = await signUp({
      businessName: `Matrix Venue ${i}`,
      email: `matrix${i}@example.test`,
      password: PASSWORD,
      market: row.market,
      timezone: row.browserZone,
    });
    assert.ok(made.ok, made.ok ? "" : made.error);
    if (!made.ok) return;
    assert.equal(made.location.currency, row.currency);
    assert.equal(made.location.timezone, row.timezone);
    assert.equal(made.location.subscription?.market ?? row.market ?? "AE", row.market ?? "AE");
  });
}

await test("a market we do not serve yet, or a made-up one, is refused before any write", async () => {
  for (const market of ["GB", "XX"]) {
    const before = counts();
    const result = await signUp({ businessName: "Far Away", email: `far-${market}@example.test`, password: PASSWORD, market });
    assert.equal(result.ok, false, `${market} was accepted`);
    if (!result.ok) assert.equal(result.field, "market");
    assert.deepEqual(counts(), before);
  }
});

await test("the kind of business is optional, and ?trade= only prefills", async () => {
  const made = await signUp({ businessName: "Any Business Co", email: "any@example.test", password: PASSWORD, vertical: "" });
  assert.ok(made.ok, made.ok ? "" : made.error);
  if (made.ok) assert.equal(getBusiness(made.user.tenantId, made.location.businessId)?.category, undefined);
  assert.equal(tradeFromParam("restaurants"), "restaurant");
  assert.equal(tradeFromParam("Salon"), "salon");
  // A word the list has never heard of selects nothing rather than guessing.
  // ("plumber" is a trade now — the whole list is exercised further down.)
  assert.equal(tradeFromParam("nonsense"), "");
  assert.equal(tradeFromParam(undefined), "");
  const bogus = await signUp({ businessName: "Bogus", email: "bogus@example.test", password: PASSWORD, vertical: "garage" as never });
  assert.equal(bogus.ok, false);
});

await test("a likely typo in the email is suggested, and can be kept on purpose", async () => {
  const before = counts();
  const typo = await signUp({ businessName: "Typo Two", email: "owner@gmial.com", password: PASSWORD });
  assert.equal(typo.ok, false);
  if (!typo.ok) {
    assert.equal(typo.field, "email");
    assert.equal(typo.didYouMean, "owner@gmail.com");
  }
  assert.deepEqual(counts(), before);
  const kept = await signUp({ businessName: "Typo Two", email: "owner@gmial.com", password: PASSWORD, emailConfirmed: true });
  assert.ok(kept.ok, kept.ok ? "" : kept.error);
});

await test("an address that already has an account gets a sign-in link", async () => {
  const again = await signUp({ businessName: "Again", email: "Owner@MarinaHair.test", password: PASSWORD });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.signIn, "/login?email=owner%40marinahair.test");
});

await test("the terms versions and the time they were accepted are stored", async () => {
  const t0 = Date.now();
  const made = await signUp({ businessName: "Terms Salon", email: "terms@example.test", password: PASSWORD, acceptedTerms: true });
  assert.ok(made.ok);
  if (!made.ok) return;
  const terms = getTenant(made.user.tenantId)?.onboarding?.terms;
  assert.equal(terms?.tosVersion, TOS_VERSION);
  assert.equal(terms?.dpaVersion, DPA_VERSION);
  assert.equal(terms?.acceptedBy, "terms@example.test");
  assert.ok(terms && Date.parse(terms.acceptedAt) >= t0 - 1000, "no acceptance time");
});

await test("five refused attempts do not block the sixth, valid one", () => {
  const limiter = createSignupLimiter();
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.blocked("1.2.3.4"), false);
    limiter.record("1.2.3.4", false);
  }
  assert.equal(limiter.blocked("1.2.3.4"), false, "a person fighting the password rule was locked out");
});

await test("accounts created are capped, and refused attempts have their own higher ceiling", () => {
  const limiter = createSignupLimiter({ maxAccounts: 2, maxRefused: 10, windowMs: 1000 });
  limiter.record("a", true, 0);
  limiter.record("a", true, 1);
  assert.equal(limiter.blocked("a", 2), true);
  assert.equal(limiter.blocked("b", 2), false, "one address blocked another");
  assert.equal(limiter.blocked("a", 1500), false, "the window never ends");
  for (let i = 0; i < 10; i++) limiter.record("c", false, 0);
  assert.equal(limiter.blocked("c", 1), true);
});

await test("the limit's key falls back to x-real-ip, then the socket, never one shared bucket", () => {
  assert.equal(clientKey(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "9.9.9.9");
  assert.equal(clientKey(new Headers({ "x-real-ip": "8.8.8.8" })), "8.8.8.8");
  assert.equal(clientKey(new Headers({ [PEER_HEADER]: "::1" })), "::1");
  const server = fs.readFileSync(path.join(import.meta.dirname, "../server.ts"), "utf8");
  assert.ok(server.includes("req.headers[PEER_HEADER] = req.socket.remoteAddress"), "server.ts no longer stamps the socket");
});

await test("no signup in this run left an orphan, and the finder spots a planted one", () => {
  const mine = new Set(listUsers().filter((u) => u.email.endsWith(".test") || u.email.endsWith(".com")).map((u) => u.tenantId));
  const dir = process.env.DATA_DIR!;
  const read = (k: string) => JSON.parse(fs.readFileSync(path.join(dir, `${k}.json`), "utf8"));
  const db = { tenants: read("tenants"), businesses: read("businesses"), locations: read("locations"), users: read("users") };
  const report = findOrphans(db);
  assert.equal(report.tenants.filter((t) => mine.has(t.id)).length, 0);
  assert.equal(report.tenants.some((t) => t.name.includes("Orphan") || t.name.includes("Half Way") || t.name.includes("Race")), false);
  const planted = findOrphans({
    ...db,
    tenants: [...db.tenants, { id: "tnt_planted", name: "Planted", status: "active", createdAt: "" }],
    businesses: [...db.businesses, { id: "biz_planted", tenantId: "tnt_planted", name: "Planted", createdAt: "" }],
  });
  assert.ok(planted.tenants.some((t) => t.id === "tnt_planted"));
  assert.ok(planted.businesses.some((b) => b.id === "biz_planted"));
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

console.log("\n\x1b[1mWhat kind of business, from a list the engine never sees\x1b[0m\n");

await test("every option the customer can pick runs on an engine that exists", () => {
  for (const t of TRADES) {
    assert.ok(["salon", "clinic", "restaurant"].includes(t.vertical), `${t.key} maps to "${t.vertical}", which is not an engine`);
    assert.ok(t.label.trim(), `${t.key} has no label`);
    assert.ok(t.group.trim(), `${t.key} has no group, so the checkout cannot place it`);
  }
  assert.equal(new Set(TRADES.map((t) => t.key)).size, TRADES.length, "two trades share a key");
});

await test("the three values venues were signed up with before the list still resolve", () => {
  for (const old of ["salon", "clinic", "restaurant"] as const) {
    assert.equal(tradeFromParam(old), old, `a venue stored as "${old}" no longer resolves`);
    assert.equal(verticalForTrade(old), old, `"${old}" changed engine`);
  }
});

await test("a ?trade= link resolves through its aliases, and an unknown one selects nothing", () => {
  assert.equal(tradeFromParam("dentist"), "clinic");
  assert.equal(tradeFromParam("  Spa  "), "salon");
  assert.equal(tradeFromParam("plumber"), "trades");
  assert.equal(tradeFromParam("nonsense"), "", "an unknown trade guessed at one");
  assert.equal(tradeFromParam(undefined), "");
  // Unrecognised still has to be able to open an account.
  assert.equal(verticalForTrade("nonsense"), "salon");
});

await test("a trade the engine has no case for signs up on the right engine, and is kept as picked", async () => {
  const vet = await signUp({
    businessName: "Marina Vets",
    email: "owner@marinavets.test",
    password: PASSWORD,
    trade: "vet",
    timezone: "Asia/Dubai",
  });
  assert.ok(vet.ok, vet.ok ? "" : vet.error);
  const venue = getLocation(vet.ok ? vet.location.id : "")!;
  assert.equal(venue.vertical, "clinic", "a vet is an appointment diary");
  assert.equal(venue.tradeKey, "vet", "what they actually picked was not kept for reporting");

  const hotel = await signUp({
    businessName: "Creek Guest House",
    email: "owner@creekguesthouse.test",
    password: PASSWORD,
    trade: "hotel",
  });
  assert.ok(hotel.ok);
  assert.equal(getLocation(hotel.ok ? hotel.location.id : "")!.vertical, "restaurant");
});

await test("\"Something else\" is a valid answer, and gets the diary most businesses keep", async () => {
  const other = await signUp({
    businessName: "Something Else Co",
    email: "owner@somethingelse.test",
    password: PASSWORD,
    trade: "",
  });
  assert.ok(other.ok, other.ok ? "" : other.error);
  const venue = getLocation(other.ok ? other.location.id : "")!;
  assert.equal(venue.vertical, "salon");
  assert.equal(venue.tradeKey, undefined, "an empty answer was stored as though it were a trade");
});

await test("an engine value that does not exist is still refused", async () => {
  const bad = await signUp({
    businessName: "Garage Co",
    email: "owner@garageco.test",
    password: PASSWORD,
    vertical: "garage" as never,
  });
  assert.equal(bad.ok, false, "a made-up engine was accepted");
  if (!bad.ok) assert.equal(bad.field, "vertical");
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
