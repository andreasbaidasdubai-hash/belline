/**
 * Vagaro: the check that readable documentation is not the same as a bookable API.
 *
 * Every other refusal in this directory is about access — Fresha has no API,
 * Booksy's is behind a 401, Treatwell's arrives with a signature, Doctolib's
 * developer host answers 401. Vagaro is the one where the documentation opens
 * and the answer is still no, and that makes it the easiest to get wrong. A
 * reader who sees docs.vagaro.com load, finds an "Appointments" section and a
 * well-specified webhook contract could reasonably conclude there is an
 * integration here. There is — a reporting one.
 *
 * So this check pins the distinction rather than the access:
 *
 * - the registry records availability, create, reschedule and cancel as absent,
 *   and says why in terms of what Vagaro publishes;
 * - the webhooks are recorded as real and as answering the wrong question,
 *   so nobody mistakes good event docs for a booking API;
 * - the commercial gate — the salon must be on Vagaro's own card processing —
 *   is recorded as a condition on every venue rather than a one-off approval;
 * - the consumer marketplace is not mistaken for a developer app store;
 * - and no endpoint, base URL or sandbox host is invented, since none is
 *   published and two of the obvious hostnames do not resolve.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches Vagaro.
 *
 *   npm run check:vagaro
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-vagaro-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 17).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_VAGARO_") || key === "FLAG_BOOKING_PARTNER_VAGARO" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, listBookings } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { vagaroConnector } = await import("../src/lib/integrations/partners/vagaro");
const { PARTNER_PROVIDERS } = await import("../src/lib/booking/partner-providers");
const { providerFor, requestOnlyProvider, localProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { INTEGRATIONS } = await import("./site-integrations");
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
const facts = PARTNERS.vagaro;

const venue = (): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "vagaro", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: { vagaro: { venueId: "vagaro-venue-1", sealedToken: "sealed" } },
  }) as Loc;

const EVERYTHING = {
  FLAG_STUBS: "on",
  FLAG_BOOKING_PARTNER_VAGARO: "on",
  PARTNER_VAGARO_API_KEY: "a-key",
  PARTNER_VAGARO_ENV: "live",
  PARTNER_VAGARO_BASE_URL: "https://api.vagaro.com/",
};

// ---------------------------------------------------------------------------
head("Readable documentation, and no booking in it");

await test("no bookable operation is claimed, because none is published", () => {
  assert.equal(facts.api.availability, false, "Vagaro publishes no availability search");
  assert.equal(facts.api.create, false);
  assert.equal(facts.api.reschedule, false);
  assert.equal(facts.api.cancel, false);
  // `documented: false` is about a *bookable* API. The webhooks are documented
  // and are recorded separately, in the limits, as the wrong answer.
  assert.equal(facts.api.documented, false);
  assert.equal(facts.sandbox, "none");
  assert.equal(facts.liveNeeds.length, 0);
});

await test("the reason is recorded as what Vagaro publishes, not as a closed door", () => {
  assert.ok(
    facts.limits.some((l) => /no booking API/i.test(l) && /availability/i.test(l)),
    "the actual finding — read-oriented capability areas, no write path — is not recorded",
  );
  assert.ok(facts.limits.some((l) => /base URL/i.test(l)), "that no base URL is published is not recorded");
  assert.ok(facts.limits.some((l) => /sandbox/i.test(l)), "the missing sandbox is not recorded");
});

await test("the webhooks are recorded as real and as answering the wrong question", () => {
  // Good event documentation is exactly what could persuade somebody there is
  // a booking integration here. It has to be named and then set aside.
  assert.ok(
    facts.limits.some((l) => /webhook/i.test(l) && /already happened/i.test(l)),
    "the webhooks are not recorded, or not recorded as retrospective",
  );
});

await test("the card-processing condition is recorded as a gate on every salon", () => {
  assert.match(facts.gate.what, /credit card processing/i);
  assert.ok(
    facts.limits.some((l) => /credit card processing/i.test(l) && /every venue|each salon|every salon/i.test(l)),
    "that the payments requirement falls on each salon is not recorded",
  );
  assert.equal(facts.gate.apply, "https://www.vagaro.com/pro/updates/webhooks");
});

await test("the consumer marketplace is not mistaken for a developer app store", () => {
  assert.ok(
    facts.limits.some((l) => /[Mm]arketplace/.test(l) && /not a developer app store/i.test(l)),
    "the marketplace confusion is not headed off",
  );
});

// ---------------------------------------------------------------------------
head("Nothing was invented");

await test("no hostname that does not resolve is cited", () => {
  for (const file of ["src/lib/integrations/partners/vagaro.ts", "src/lib/integrations/partners/registry.ts", "docs/integrations/partners.md"]) {
    const text = source(file);
    // Both of these are NXDOMAIN. Naming them as absent is fine; citing them
    // as sources is not, and the difference is a scheme.
    assert.ok(!/https?:\/\/developers\.vagaro\.com/.test(text), `${file} cites developers.vagaro.com, which does not resolve`);
    assert.ok(!/https?:\/\/sandbox\.vagaro\.com/.test(text), `${file} cites sandbox.vagaro.com, which does not resolve`);
    assert.ok(!/https?:\/\/api\.vagaro\.com/.test(text), `${file} cites api.vagaro.com as an API base, which 404s`);
  }
});

await test("no adapter code was written against an endpoint nobody published", () => {
  const code = source("src/lib/integrations/partners/vagaro.ts");
  assert.ok(!/fetch\(|httpTransport|path:/.test(code), "Vagaro has an HTTP client for endpoints that are not published");
  assert.match(code, /closedConnector/);
});

// ---------------------------------------------------------------------------
head("Nothing can switch it on");

await test("every flag, key and setting at once still leaves it unconnected", () => {
  assert.equal(vagaroConnector.usable(venue(), EVERYTHING), false);
  assert.equal(vagaroConnector.apiFor(venue(), EVERYTHING), null);
  assert.equal(partnerLive("vagaro", EVERYTHING), false);
});

await test("a Vagaro salon takes requests, and the agent has no tool that could book", () => {
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "Vagaro fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("the provider refuses in words, and no booking is left behind", async () => {
  const provider = PARTNER_PROVIDERS.vagaro;
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
  assert.match(made.detail, /Vagaro cannot take a booking/);
  assert.match(made.detail, /message/i);
  assert.equal(listBookings({ locationId: salon.id }).length, before);
});

await test("Vagaro is not on the website's strip", () => {
  assert.equal(INTEGRATIONS.some((i) => i.flag === "booking.partner.vagaro"), false);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
