/**
 * Treatwell: closed, and honest about being closed.
 *
 * Treatwell publishes no developer documentation of any kind — no portal, no
 * reference, no base URL, no auth model, no sandbox. Their own Partner Terms of
 * Business confirm APIs exist and say what a partner gets "will be set out in
 * your Specific Partner Agreement", which is the whole integration story.
 *
 * There is therefore nothing to implement and nothing to estimate, and this
 * check makes sure the repository keeps saying so: no guessed endpoints, no
 * adapter that books against a fake, and a salon on Treatwell taking requests
 * exactly as it does today.
 *
 *   npm run check:treatwell
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-treatwell-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 4).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_TREATWELL_") || key === "FLAG_BOOKING_PARTNER_TREATWELL" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listBookings, listLocations } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { treatwellConnector } = await import("../src/lib/integrations/partners/treatwell");
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
const salon = listLocations().find((l) => l.vertical === "salon" && !l.internal)!;
const facts = PARTNERS.treatwell;

const venue = (): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "treatwell", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: { treatwell: { venueId: "tw-1", sealedToken: "sealed" } },
  }) as Loc;

const EVERYTHING = {
  FLAG_STUBS: "on",
  FLAG_BOOKING_PARTNER_TREATWELL: "on",
  PARTNER_TREATWELL_API_KEY: "a-key",
  PARTNER_TREATWELL_ENV: "live",
};

// ---------------------------------------------------------------------------
head("Closed, and recorded as closed");

await test("nothing is claimed for an API nobody outside Treatwell has seen", () => {
  assert.equal(facts.api.documented, false);
  assert.equal(facts.api.availability, false);
  assert.equal(facts.api.create, false);
  assert.equal(facts.api.reschedule, false);
  assert.equal(facts.api.cancel, false);
  assert.equal(facts.sandbox, "none");
  assert.equal(facts.auth, "Not published.");
});

await test("the way in is a Specific Partner Agreement, and it says so", () => {
  assert.match(facts.gate.what, /Specific Partner Agreement/i);
  assert.match(facts.gate.docs ?? "", /treatwell\.co\.uk/);
  assert.ok(facts.limits.some((l) => /No public documentation/i.test(l)));
  // Treatwell is also a marketplace: the negotiation is commercial too.
  assert.ok(facts.limits.some((l) => /marketplace/i.test(l)));
});

await test("no endpoint was invented to fill the silence", () => {
  const code = source("src/lib/integrations/partners/treatwell.ts");
  assert.ok(!/fetch\(|httpTransport|path:/.test(code), "Treatwell has a client for an API nobody has documented");
  assert.match(code, /closedConnector/);
});

// ---------------------------------------------------------------------------
head("A Treatwell salon is exactly as it is today");

await test("every flag and key at once connects nothing", () => {
  assert.equal(treatwellConnector.usable(venue(), EVERYTHING), false);
  assert.equal(treatwellConnector.apiFor(venue(), EVERYTHING), null);
  assert.equal(partnerLive("treatwell", EVERYTHING), false);
});

await test("the salon takes requests, and the agent cannot quote or book", async () => {
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider);
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
  const before = listBookings({ locationId: salon.id }).length;
  const made = await PARTNER_PROVIDERS.treatwell.createBooking(
    { location: venue() },
    { date: "2026-09-21", startMin: 10 * 60, guestName: "Layla", guestPhone: "+971501234567" },
  );
  assert.equal(made.ok, false);
  if (!made.ok) assert.match(made.detail, /Treatwell cannot take a booking/);
  assert.equal(listBookings({ locationId: salon.id }).length, before);
});

await test("the website says 'On our roadmap', whatever is in env", () => {
  const item = INTEGRATIONS.find((i) => i.name === "Treatwell")!;
  assert.equal(integrationState(item, {}), "roadmap");
  assert.equal(integrationState(item, EVERYTHING), "roadmap");
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
