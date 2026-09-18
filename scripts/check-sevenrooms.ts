/**
 * SevenRooms: closed since February, and a trap recorded.
 *
 * SevenRooms moved its API documentation behind individually provisioned
 * accounts, so no endpoint, no auth model and no rate limit is public. The
 * capability set is attested second-hand and second-hand is not good enough to
 * build on.
 *
 * The trap: a GitHub repository (`PolyAI-LDN/sevenrooms-api`) documents
 * `POST /check-availability` and `POST /book` against a Railway host with a
 * static bearer token. It is somebody else's wrapper in front of eleven
 * restaurants, it looks exactly like an official reference at a glance, and it
 * is the single most likely thing for a future implementer to build against by
 * mistake. This check fails if any of it appears in the repository.
 *
 *   npm run check:sevenrooms
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-sevenrooms-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 8).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_SEVENROOMS_") || key === "FLAG_BOOKING_PARTNER_SEVENROOMS" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listBookings, listLocations } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { sevenroomsConnector } = await import("../src/lib/integrations/partners/sevenrooms");
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
const SOURCES = [
  "src/lib/integrations/partners/sevenrooms.ts",
  "src/lib/integrations/partners/registry.ts",
  "docs/integrations/partners.md",
];

seedIfEmpty();
const restaurant = listLocations().find((l) => l.vertical === "restaurant" && !l.internal)!;
const facts = PARTNERS.sevenrooms;

const venue = (): Loc =>
  ({
    ...restaurant,
    onboarding: {
      ...(restaurant.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "sevenrooms", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: { sevenrooms: { venueId: "venue-group-1", sealedToken: "sealed" } },
  }) as Loc;

const EVERYTHING = {
  FLAG_STUBS: "on",
  FLAG_BOOKING_PARTNER_SEVENROOMS: "on",
  PARTNER_SEVENROOMS_API_KEY: "a-key",
  PARTNER_SEVENROOMS_ENV: "live",
};

// ---------------------------------------------------------------------------
head("Closed, and recorded as closed");

await test("nothing is claimed for documentation nobody outside can read", () => {
  assert.equal(facts.api.documented, false);
  assert.equal(facts.api.availability, false);
  assert.equal(facts.api.create, false);
  assert.equal(facts.sandbox, "none");
  assert.equal(facts.model, "reservations");
  // Even the auth model is hearsay, and is labelled as hearsay.
  assert.match(facts.auth, /unverified/i);
});

await test("the way in is a provisioned documentation account, then an agreement", () => {
  assert.match(facts.gate.what, /api-integration-support@sevenrooms\.com/);
  assert.match(facts.gate.what, /partnership agreement/i);
  // Two-sided: a signed partnership is necessary and not sufficient.
  assert.ok(facts.limits.some((l) => /venue group|contract tier/i.test(l)));
});

await test("the third-party wrapper is not mistaken for SevenRooms anywhere", () => {
  for (const file of SOURCES) {
    const text = source(file);
    assert.ok(!/up\.railway\.app/.test(text) || /NOT|not SevenRooms|somebody else/i.test(text), `${file} cites the wrapper without the warning`);
    assert.ok(!/["'`]\/(check-availability|book)["'`]/.test(text), `${file} carries the wrapper's paths as if they were SevenRooms'`);
  }
  // And the warning itself is kept, so nobody re-finds the repository cold.
  assert.match(source("src/lib/integrations/partners/sevenrooms.ts"), /PolyAI-LDN\/sevenrooms-api/);
});

await test("no client was written for an API nobody has seen", () => {
  const code = source("src/lib/integrations/partners/sevenrooms.ts");
  assert.ok(!/fetch\(|httpTransport|path:/.test(code));
  assert.match(code, /closedConnector/);
});

// ---------------------------------------------------------------------------
head("The restaurant is exactly as it is today");

await test("every flag and key at once connects nothing", () => {
  assert.equal(sevenroomsConnector.usable(venue(), EVERYTHING), false);
  assert.equal(sevenroomsConnector.apiFor(venue(), EVERYTHING), null);
  assert.equal(partnerLive("sevenrooms", EVERYTHING), false);
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
  const made = await PARTNER_PROVIDERS.sevenrooms.createBooking(
    { location: venue() },
    { date: "2026-09-21", startMin: 20 * 60, guestName: "Omar", guestPhone: "+971501234567", partySize: 2 },
  );
  assert.equal(made.ok, false);
  if (!made.ok) assert.match(made.detail, /SevenRooms cannot take a booking/);
  assert.equal(listBookings({ locationId: restaurant.id }).length, before);
});

await test("the website says 'On our roadmap', whatever is in env", () => {
  const item = INTEGRATIONS.find((i) => i.name === "SevenRooms")!;
  assert.equal(integrationState(item, {}), "roadmap");
  assert.equal(integrationState(item, EVERYTHING), "roadmap");
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
