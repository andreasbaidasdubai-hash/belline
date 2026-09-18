/**
 * Doctolib: the check that the obstacle is not the API.
 *
 * The German-speaking launch wanted this one, and it is the hardest door on
 * the list. Nothing technical is public — the developer host answers 401, the
 * partner portal is a login wall, there is no reference, no base URL, no auth
 * model and no sandbox — but that is the ordinary half.
 *
 * The half this check exists for is the other one. Appointment data at a clinic
 * is health data: HDS-regulated hosting in France, medical confidentiality
 * under §203 StGB in Germany, GDPR Article 9 over both, and Doctolib's own
 * position that patient data is reachable only by authorised healthcare
 * providers. A voice agent booking on a patient's behalf is a non-clinical
 * third party touching regulated data. So the registry must record the legal
 * obstacle and not only the technical one, or a future reader will price this
 * as an integration task and be wrong by a year.
 *
 * And the most dangerous sentence about Doctolib is one nobody wrote: it does
 * not publish a prohibition on third-party booking, because it does not address
 * third-party booking at all. Silence is not consent, and this check asserts
 * that the repository says so.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches Doctolib.
 *
 *   npm run check:doctolib
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-doctolib-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 19).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_DOCTOLIB_") || key === "FLAG_BOOKING_PARTNER_DOCTOLIB" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, listBookings } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { doctolibConnector } = await import("../src/lib/integrations/partners/doctolib");
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
const clinic = listLocations().find((l) => l.vertical === "clinic" && !l.internal) ?? listLocations().find((l) => !l.internal)!;
const facts = PARTNERS.doctolib;

const venue = (): Loc =>
  ({
    ...clinic,
    onboarding: {
      ...(clinic.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "doctolib", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: { doctolib: { venueId: "doctolib-practice-1", sealedToken: "sealed" } },
  }) as Loc;

const EVERYTHING = {
  FLAG_STUBS: "on",
  FLAG_BOOKING_PARTNER_DOCTOLIB: "on",
  PARTNER_DOCTOLIB_API_KEY: "a-key",
  PARTNER_DOCTOLIB_ENV: "live",
  PARTNER_DOCTOLIB_BASE_URL: "https://api.doctolib.fr/",
};

// ---------------------------------------------------------------------------
head("Nothing technical is public");

await test("no documented API means no claimed operation", () => {
  assert.equal(facts.api.documented, false);
  assert.equal(facts.api.availability, false);
  assert.equal(facts.api.create, false);
  assert.equal(facts.api.reschedule, false);
  assert.equal(facts.api.cancel, false);
  assert.equal(facts.sandbox, "none");
  assert.equal(facts.liveNeeds.length, 0);
});

await test("the 401 developer host and the login-walled partner portal are recorded", () => {
  assert.ok(
    facts.limits.some((l) => /401/.test(l)),
    "that a gated developer host exists is not recorded",
  );
  assert.ok(
    facts.limits.some((l) => /partner portal/i.test(l)),
    "that the partner portal needs a relationship first is not recorded",
  );
});

await test("that every named integration runs the other way is recorded", () => {
  // Doctolib's calendar syncs INTO a practice's software. That is the opposite
  // of an agent writing an appointment, and is the thing most likely to be
  // misread as evidence that a booking API exists.
  assert.ok(
    facts.limits.some((l) => /other way|other direction/i.test(l)),
    "the direction of Doctolib's own integrations is not recorded",
  );
  assert.ok(
    facts.limits.some((l) => /practice-management|no category/i.test(l)),
    "that every named partner is a PMS vendor is not recorded",
  );
});

// ---------------------------------------------------------------------------
head("The obstacle is the health-data question, not the endpoint");

await test("the regulatory position is recorded, in the terms it will actually be argued in", () => {
  const regulatory = facts.limits.find((l) => /health data/i.test(l));
  assert.ok(regulatory, "health data is not recorded as a limit at all");
  assert.match(regulatory!, /HDS/, "France's health-data hosting regime is not named");
  assert.match(regulatory!, /203 StGB/, "German medical confidentiality is not named");
  assert.match(regulatory!, /Article 9|Art\. 9/, "GDPR's special-category rule is not named");
});

await test("silence is not recorded as permission", () => {
  // The most dangerous sentence about Doctolib is the one nobody wrote.
  assert.ok(
    facts.limits.some((l) => /not publish a prohibition|Absence of a refusal/i.test(l)),
    "the repository does not warn that Doctolib simply does not address third-party booking",
  );
  const adapter = source("src/lib/integrations/partners/doctolib.ts");
  assert.match(adapter, /Absence of a refusal is not consent/i, "the adapter does not carry the warning either");
});

await test("the launch assumption is written down as 'not connected', not 'not yet'", () => {
  assert.ok(
    facts.limits.some((l) => /German-speaking launch/i.test(l) && /will not be connected/i.test(l)),
    "the registry lets the German launch plan on Doctolib arriving",
  );
  const adapter = source("src/lib/integrations/partners/doctolib.ts");
  assert.match(adapter, /takes the request/i, "the adapter does not say what a Doctolib clinic actually gets");
});

await test("the application route is recorded as the commercial form it really is", () => {
  assert.equal(facts.gate.apply, "https://info.doctolib.de/commercial-partnerships/");
  assert.match(facts.gate.what, /commercial/i);
  // There is no ISV or developer programme to point at, and pretending there
  // is would send the founder to a form that does not exist.
  assert.match(facts.gate.what, /no public developer programme|no technical application route/i);
});

await test("no Doctolib API host is cited as though it were one", () => {
  for (const file of [
    "src/lib/integrations/partners/doctolib.ts",
    "src/lib/integrations/partners/registry.ts",
    "docs/integrations/partners.md",
  ]) {
    const text = source(file);
    // api.doctolib.fr serves the patient website, not an API.
    assert.ok(!/https?:\/\/api\.doctolib\.(fr|de|com)/.test(text), `${file} cites a Doctolib API host that is not one`);
  }
});

await test("no adapter code was written against a guessed endpoint", () => {
  const code = source("src/lib/integrations/partners/doctolib.ts");
  assert.ok(!/fetch\(|httpTransport|path:/.test(code), "Doctolib has an HTTP client for an API nobody can read");
  assert.match(code, /closedConnector/);
});

// ---------------------------------------------------------------------------
head("Nothing can switch it on");

await test("every flag, key and setting at once still leaves it unconnected", () => {
  assert.equal(doctolibConnector.usable(venue(), EVERYTHING), false);
  assert.equal(doctolibConnector.apiFor(venue(), EVERYTHING), null);
  assert.equal(partnerLive("doctolib", EVERYTHING), false);
});

await test("a Doctolib clinic takes requests, and the agent has no tool that could book", () => {
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "Doctolib fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("the provider refuses in words, and no patient's appointment is invented", async () => {
  const provider = PARTNER_PROVIDERS.doctolib;
  const ctx = { location: venue() };
  const before = listBookings({ locationId: clinic.id }).length;
  assert.deepEqual(await provider.checkAvailability(ctx, { locationId: clinic.id, date: "2026-09-21" }), []);
  const made = await provider.createBooking(ctx, {
    date: "2026-09-21",
    startMin: 10 * 60,
    guestName: "Anna Weber",
    guestPhone: "+4915112345678",
    serviceIds: ["svc-1"],
  });
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.detail, /Doctolib cannot take a booking/);
  assert.match(made.detail, /message/i);
  assert.equal(listBookings({ locationId: clinic.id }).length, before);
});

await test("Doctolib is not on the website's strip", () => {
  assert.equal(INTEGRATIONS.some((i) => i.flag === "booking.partner.doctolib"), false);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
