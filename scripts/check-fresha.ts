/**
 * Fresha: the check that there is nothing there.
 *
 * Fresha is the system our Gulf salons ask about most and the one with the
 * least to build against: no developer portal, no reference, no sandbox, no
 * partner programme with a form on it. Its one official programmatic product,
 * the Data Connector, is a paid one-way Snowflake share of reporting data that
 * Fresha themselves say sends nothing back.
 *
 * So this check does the opposite of check:zenoti. It proves that no
 * combination of flags, keys and venue records can make Belline quote a Fresha
 * time or claim a Fresha booking, and that the application route recorded in
 * the registry is the truthful one — a commercial conversation, because there
 * is no queue to join.
 *
 * It also pins the warning that cost the research an hour: several confident
 * third-party articles cite a `developers.fresha.com` that does not resolve.
 * If a future change here starts quoting that domain, this check fails.
 *
 *   npm run check:fresha
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-fresha-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 2).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_FRESHA_") || key === "FLAG_BOOKING_PARTNER_FRESHA" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, listBookings } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { freshaConnector } = await import("../src/lib/integrations/partners/fresha");
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
const facts = PARTNERS.fresha;

const venue = (): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "fresha", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: { fresha: { venueId: "fresha-venue-1", sealedToken: "sealed" } },
  }) as Loc;

/** Everything somebody could set, believing it would switch Fresha on. */
const EVERYTHING = {
  FLAG_STUBS: "on",
  FLAG_BOOKING_PARTNER_FRESHA: "on",
  PARTNER_FRESHA_API_KEY: "a-key",
  PARTNER_FRESHA_ENV: "live",
  PARTNER_FRESHA_BASE_URL: "https://api.fresha.com/",
};

// ---------------------------------------------------------------------------
head("There is no Fresha API, and the registry says so");

await test("no documented API means no claimed operation", () => {
  assert.equal(facts.api.documented, false);
  assert.equal(facts.api.availability, false);
  assert.equal(facts.api.create, false);
  assert.equal(facts.api.reschedule, false);
  assert.equal(facts.api.cancel, false);
  assert.equal(facts.sandbox, "none");
  assert.equal(facts.liveNeeds.length, 0, "credentials are listed for an API that does not exist");
});

await test("the way in is written down as what it is: a conversation, not a form", () => {
  assert.match(facts.gate.what, /No public API/i);
  assert.equal(facts.gate.apply, undefined, "an application URL is recorded for a programme that does not exist");
  assert.ok(facts.limits.some((l) => /Data Connector/i.test(l)), "the read-only Snowflake share is not recorded");
  assert.ok(facts.limits.some((l) => /[Ss]craping/.test(l)), "the scraping question is not answered");
});

await test("nothing in the repository cites a Fresha developer portal that does not exist", () => {
  for (const file of [
    "src/lib/integrations/partners/fresha.ts",
    "src/lib/integrations/partners/registry.ts",
    "docs/integrations/partners.md",
  ]) {
    const text = source(file);
    assert.ok(
      !/https?:\/\/(developers|developer|docs)\.fresha\.com/.test(text),
      `${file} cites a Fresha developer site that does not resolve`,
    );
  }
});

await test("no adapter code was written against a guessed endpoint", () => {
  const code = source("src/lib/integrations/partners/fresha.ts");
  assert.ok(!/fetch\(|httpTransport|path:/.test(code), "Fresha has an HTTP client for an API that does not exist");
  assert.match(code, /closedConnector/);
});

// ---------------------------------------------------------------------------
head("Nothing can switch it on");

await test("every flag, key and setting at once still leaves it unconnected", () => {
  assert.equal(freshaConnector.usable(venue(), EVERYTHING), false);
  assert.equal(freshaConnector.apiFor(venue(), EVERYTHING), null);
  assert.equal(partnerLive("fresha", EVERYTHING), false);
});

await test("a Fresha salon takes requests, and the agent has no tool that could book", () => {
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "Fresha fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("the provider refuses in words, and no booking is left behind", async () => {
  const provider = PARTNER_PROVIDERS.fresha;
  const ctx = { location: venue() };
  const before = listBookings({ locationId: salon.id }).length;
  assert.deepEqual(await provider.checkAvailability(ctx, { locationId: salon.id, date: "2026-09-21" }), []);
  const made = await provider.createBooking(ctx, {
    date: "2026-09-21",
    startMin: 10 * 60,
    guestName: "Layla",
    guestPhone: "+971501234567",
    serviceIds: ["svc-1"],
  });
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.detail, /Fresha cannot take a booking/);
  assert.match(made.detail, /message/i);
  assert.equal(listBookings({ locationId: salon.id }).length, before);
});

await test("the website says 'On our roadmap', whatever is in env", () => {
  const item = INTEGRATIONS.find((i) => i.name === "Fresha")!;
  assert.equal(item.pending, "roadmap");
  assert.equal(integrationState(item, {}), "roadmap");
  assert.equal(integrationState(item, EVERYTHING), "roadmap");
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
