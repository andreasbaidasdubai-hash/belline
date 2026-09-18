/**
 * OpenTable: a restaurant system, gated, and not pretended at.
 *
 * Two things this check exists to hold.
 *
 * **No guessed endpoints.** OpenTable publishes the platform basics — OAuth 2.0,
 * JSON, a unique `X-Request-Id` on every write — and gates the reference itself.
 * Third-party articles describe an availability → slot lock → reservation flow;
 * the shape is plausible and the paths are unverified, so not one of them is in
 * this repository, and this check fails if one appears.
 *
 * **A restaurant is not an appointment book.** Party size decides whether a time
 * exists at all, the house sets the turn time, the room is solved as tables, and
 * nobody asks for a waiter. The registry records that, and the adapter is a
 * reservations model rather than an appointments one — so that when a
 * partnership does arrive, nobody builds it as a salon with a party size
 * attached.
 *
 *   npm run check:opentable
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-opentable-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 6).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_OPENTABLE_") || key === "FLAG_BOOKING_PARTNER_OPENTABLE" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listBookings, listLocations } = await import("../src/lib/store");
const { PARTNERS, RESTAURANT_MODEL_NOTE, partnerLive } = await import("../src/lib/integrations/partners");
const { opentableConnector } = await import("../src/lib/integrations/partners/opentable");
const { sandboxPartner } = await import("../src/lib/integrations/partners/sandbox");
const { PARTNER_PROVIDERS } = await import("../src/lib/booking/partner-providers");
const { providerFor, requestOnlyProvider, localProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { INTEGRATIONS, integrationState } = await import("./site-integrations");
const { BOOKING_TOOL_NAMES, toolsFor } = await import("../src/lib/agent/tools");
type Loc = import("../src/lib/types").Location;

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
const head = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m\n`);

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

seedIfEmpty();
const restaurant = listLocations().find((l) => l.vertical === "restaurant" && !l.internal)!;
const facts = PARTNERS.opentable;

const venue = (): Loc =>
  ({
    ...restaurant,
    onboarding: {
      ...(restaurant.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "opentable", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: { opentable: { venueId: "rid-1", sealedToken: "sealed" } },
  }) as Loc;

const EVERYTHING = {
  FLAG_STUBS: "on",
  FLAG_BOOKING_PARTNER_OPENTABLE: "on",
  PARTNER_OPENTABLE_API_KEY: "a-key",
  PARTNER_OPENTABLE_ENV: "live",
};

// ---------------------------------------------------------------------------
head("Gated, and recorded as gated");

await test("the platform basics are kept, and no operation is claimed", () => {
  assert.equal(facts.api.documented, false);
  assert.equal(facts.api.create, false);
  assert.equal(facts.api.availability, false);
  assert.match(facts.auth, /OAuth 2\.0/);
  // The one mechanic worth carrying into a future implementation.
  assert.match(facts.auth, /X-Request-Id/);
  assert.equal(facts.model, "reservations");
});

await test("the application route and its unusual catch are written down", () => {
  assert.equal(facts.gate.apply, "https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/");
  assert.match(facts.gate.what, /three to four weeks/i);
  assert.ok(
    facts.limits.some((l) => /sandbox excludes the Booking API/i.test(l)),
    "the sandbox not covering bookings is not recorded, and it is the surprise",
  );
});

await test("no third-party endpoint was copied in as if it were OpenTable's", () => {
  for (const file of ["src/lib/integrations/partners/opentable.ts", "src/lib/integrations/partners/registry.ts"]) {
    const code = source(file);
    assert.ok(!/["'`]\/v2\/(availability|booking)/.test(code), `${file} carries an unverified OpenTable path`);
  }
  const code = source("src/lib/integrations/partners/opentable.ts");
  assert.ok(!/fetch\(|httpTransport/.test(code), "OpenTable has a client for a reference nobody outside can read");
});

// ---------------------------------------------------------------------------
head("A restaurant is not an appointment book");

await test("the difference is written where the next implementer will find it", () => {
  assert.match(RESTAURANT_MODEL_NOTE, /party size/i);
  assert.match(RESTAURANT_MODEL_NOTE, /turn time/i);
  assert.match(RESTAURANT_MODEL_NOTE, /no staff selection/i);
  assert.equal(facts.api.staffSelection, false, "a restaurant was given a person to ask for");
  assert.ok(facts.limits.some((l) => /not an appointment book/i.test(l)));
});

await test("a reservations partner cannot quietly behave like an appointments one", async () => {
  // Not OpenTable — OpenTable has no reachable API and the rest of this file
  // is about keeping it that way. This is the *reservations shape* a future
  // OpenTable or SevenRooms adapter would inherit, driven so that the shape
  // itself is held down: party size or nothing, and never a person.
  const shape = { ...facts, api: { ...facts.api, documented: true, availability: true, create: true } };
  const api = sandboxPartner(shape, { opens: 18 * 60, closes: 21 * 60, stepMin: 30, maxParty: 6 });
  // No party size is not a question a restaurant can answer.
  assert.deepEqual(await api.availability({ date: "2026-09-21" }), []);
  // Nor is a party the room cannot take.
  assert.deepEqual(await api.availability({ date: "2026-09-21", partySize: 12 }), []);
  const four = await api.availability({ date: "2026-09-21", partySize: 4 });
  assert.ok(four.length > 0);
  assert.ok(four.every((s) => s.staffId === undefined), "a table was offered with a waiter attached");
});

// ---------------------------------------------------------------------------
head("The restaurant is exactly as it is today");

await test("every flag and key at once connects nothing", () => {
  assert.equal(opentableConnector.usable(venue(), EVERYTHING), false);
  assert.equal(opentableConnector.apiFor(venue(), EVERYTHING), null);
  assert.equal(partnerLive("opentable", EVERYTHING), false);
});

await test("the restaurant takes requests, and no table is ever quoted", async () => {
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider);
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
  }
  const before = listBookings({ locationId: restaurant.id }).length;
  const made = await PARTNER_PROVIDERS.opentable.createBooking(
    { location: venue() },
    { date: "2026-09-21", startMin: 19 * 60, guestName: "Sara", guestPhone: "+971501234567", partySize: 4 },
  );
  assert.equal(made.ok, false);
  if (!made.ok) assert.match(made.detail, /OpenTable cannot take a booking/);
  assert.equal(listBookings({ locationId: restaurant.id }).length, before);
});

await test("the website says 'On our roadmap', whatever is in env", () => {
  const item = INTEGRATIONS.find((i) => i.name === "OpenTable")!;
  assert.equal(integrationState(item, {}), "roadmap");
  assert.equal(integrationState(item, EVERYTHING), "roadmap");
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
