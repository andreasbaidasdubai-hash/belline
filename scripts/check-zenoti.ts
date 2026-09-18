/**
 * Zenoti, against a fake Zenoti.
 *
 * Zenoti is one of the two partners with an API Belline could use tomorrow if
 * a salon handed us a key, so this check drives the adapter properly: the
 * sandbox partner offers a morning, the provider offers exactly those times
 * and no others, a booking becomes the salon's appointment and the same
 * booking twice is one, a partner that cannot be reached quotes nothing, and
 * the two things Zenoti genuinely cannot do — move an appointment, and connect
 * itself without the salon's own key — are refused in words rather than
 * attempted.
 *
 * What it does not prove: that Zenoti will have us. No salon has issued
 * Belline a key, `booking.partner.zenoti` is off on every deployment, and the
 * website says "on our roadmap". A green run here is Belline's side being
 * ready, and nothing else.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches Zenoti.
 *
 *   npm run check:zenoti
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-zenoti-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 5).toString("base64");
// Deliberately no flags and no key in the process environment: the default
// state of every deployment, so anything reading `process.env` below sees a
// venue that is not connected. The fake Zenoti is handed to the adapter
// explicitly instead.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_ZENOTI_") || key === "FLAG_BOOKING_PARTNER_ZENOTI" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, listBookings } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { zenotiConnector } = await import("../src/lib/integrations/partners/zenoti");
const { partnerMode } = await import("../src/lib/integrations/partners/contract");
const { sandboxPartner } = await import("../src/lib/integrations/partners/sandbox");
const { partnerProvider } = await import("../src/lib/booking/partner-provider");
const { providerFor, requestOnlyProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { integrationState } = await import("./site-integrations");
const { INTEGRATIONS } = await import("./site-integrations");
type Loc = import("../src/lib/types").Location;
type PartnerApi = import("../src/lib/integrations/partners/contract").PartnerApi;

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
const facts = PARTNERS.zenoti;

const venue = (link: Record<string, unknown> | null = { venueId: "centre-1" }): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "zenoti", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: link ? { zenoti: link } : undefined,
  }) as Loc;

/** The provider over a fake Zenoti we can steer. */
function withSandbox(api: PartnerApi) {
  return partnerProvider({ ...zenotiConnector, apiFor: () => api, usable: () => true });
}

// ---------------------------------------------------------------------------
head("What the research found, written down");

await test("Zenoti's documented API is recorded as it is, including what it cannot do", () => {
  assert.equal(facts.api.documented, true);
  assert.equal(facts.api.availability, true);
  assert.equal(facts.api.create, true);
  // Zenoti's own docs describe rescheduling as cancel-then-rebook, not an endpoint.
  assert.equal(facts.api.reschedule, false);
  assert.equal(facts.api.cancel, true);
  assert.match(facts.auth, /apikey/);
  // The key belongs to the salon, not to Belline: no third-party OAuth exists.
  assert.match(facts.gate.what, /API package/i);
  assert.ok(facts.limits.some((l) => /OAuth/i.test(l)), "the missing self-connect is not recorded");
  assert.ok(facts.limits.some((l) => /60 API calls/i.test(l)), "the rate limit is not recorded");
});

await test("the adapter is written against the documented endpoints and nothing else", () => {
  const code = source("src/lib/integrations/partners/zenoti.ts");
  assert.match(code, /https:\/\/api\.zenoti\.com\/v1\//);
  assert.match(code, /bookings\/\$\{cart\}\/slots\/reserve/);
  assert.match(code, /bookings\/\$\{cart\}\/slots\/confirm/);
  assert.match(code, /invoices\/\$\{ref\.id\}\/cancel/);
  // The two calls the research could not confirm are marked as such in the
  // source, so nobody enables this believing all of it is verified.
  assert.match(code, /UNVERIFIED/);
});

// ---------------------------------------------------------------------------
head("Not connected");

await test("no key and no salon: the venue takes requests and nothing is quoted", async () => {
  assert.equal(partnerMode(facts, {}), "off");
  assert.equal(zenotiConnector.usable(venue(), {}), false);
  assert.equal(zenotiConnector.apiFor(venue(), {}), null);
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
});

await test("a key without the salon's centre id connects nothing", () => {
  const env = { FLAG_BOOKING_PARTNER_ZENOTI: "on", PARTNER_ZENOTI_API_KEY: "k" };
  assert.equal(zenotiConnector.usable(venue(null), env), false);
  assert.equal(zenotiConnector.linked(venue(null)), false);
});

await test("a sandbox key and a centre id reach the fake and never the real host", () => {
  const env = { FLAG_STUBS: "on", FLAG_BOOKING_PARTNER_ZENOTI: "on" };
  assert.equal(partnerMode(facts, env), "sandbox");
  assert.notEqual(zenotiConnector.apiFor(venue(), env), null, "the sandbox is unreachable to the adapter");
  // Which is a fake studio, not a salon: the website is unmoved by it.
  assert.equal(partnerLive("zenoti", env), false);
});

await test("live needs the centre's own sealed key, not ours", () => {
  const env = { FLAG_BOOKING_PARTNER_ZENOTI: "on", PARTNER_ZENOTI_API_KEY: "k", PARTNER_ZENOTI_ENV: "live" };
  assert.equal(partnerMode(facts, env), "live");
  // The salon is recorded but has issued nothing.
  assert.equal(zenotiConnector.usable(venue({ venueId: "centre-1" }), env), false);
  assert.equal(zenotiConnector.usable(venue({ venueId: "centre-1", sealedToken: "sealed" }), env), true);
});

await test("the website stays on the roadmap while all of that is true", () => {
  const item = INTEGRATIONS.find((i) => i.name === "Zenoti")!;
  assert.equal(integrationState(item, {}), "roadmap");
  assert.equal(integrationState(item, { FLAG_BOOKING_PARTNER_ZENOTI: "on", PARTNER_ZENOTI_API_KEY: "k" }), "roadmap");
  assert.equal(partnerLive("zenoti", { FLAG_BOOKING_PARTNER_ZENOTI: "on", PARTNER_ZENOTI_API_KEY: "k" }), false);
});

// ---------------------------------------------------------------------------
head("Against a fake Zenoti");

await test("only the partner's times are offered, never Belline's own", async () => {
  const api = sandboxPartner(facts, { opens: 9 * 60, closes: 12 * 60, stepMin: 60 });
  const slots = await withSandbox(api).checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-21" });
  assert.deepEqual(slots.map((s) => s.startMin), [9 * 60, 10 * 60, 11 * 60]);
  assert.deepEqual(api.calls(), ["availability"]);
});

await test("a partner that cannot be reached offers nothing at all", async () => {
  const api = sandboxPartner(facts, { down: true });
  const slots = await withSandbox(api).checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-21" });
  assert.deepEqual(slots, [], "Belline quoted a time it could not check");
});

await test("a booking is the partner's, and Belline's record points at it", async () => {
  const api = sandboxPartner(facts, { opens: 9 * 60, closes: 12 * 60 });
  const provider = withSandbox(api);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-21", startMin: 10 * 60, guestName: "Layla H.", guestPhone: "+971501234567", serviceIds: ["svc-1"] },
  );
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.equal(api.bookings().length, 1);
  assert.equal(made.booking.partnerBookingId, api.bookings()[0].id);
  // The guest reads back the salon's own reference, which is what its staff
  // will search for in Zenoti.
  assert.equal(made.booking.ref, api.bookings()[0].ref);
});

await test("the same booking twice is one booking at the salon", async () => {
  const api = sandboxPartner(facts);
  const provider = withSandbox(api);
  const input = { date: "2026-09-22", startMin: 11 * 60, guestName: "Sara", guestPhone: "+971509999999", serviceIds: ["svc-1"] };
  const first = await provider.createBooking({ location: venue() }, input);
  const second = await provider.createBooking({ location: venue() }, input);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(second.duplicate, true);
  assert.equal(second.booking.id, first.booking.id);
  assert.equal(api.bookings().length, 1, "the salon was given the same appointment twice");
});

await test("a partner that refuses the write leaves no Belline booking behind", async () => {
  const api = sandboxPartner(facts);
  const provider = withSandbox(api);
  const before = listBookings({ locationId: salon.id }).length;
  api.down(true);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-23", startMin: 10 * 60, guestName: "Noor", guestPhone: "+971507777777", serviceIds: ["svc-1"] },
  );
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.detail, /take their name|message/i);
  assert.equal(listBookings({ locationId: salon.id }).length, before, "a booking exists that the salon never got");
});

await test("Zenoti is never asked to move an appointment, because it cannot", async () => {
  const api = sandboxPartner(facts);
  const provider = withSandbox(api);
  assert.equal(provider.capabilities.reschedule, false);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-24", startMin: 9 * 60, guestName: "Mona", guestPhone: "+971506666666", serviceIds: ["svc-1"] },
  );
  assert.ok(made.ok);
  if (!made.ok) return;
  const moved = await provider.rescheduleBooking({ location: venue() }, made.booking, { startMin: 10 * 60 });
  assert.equal(moved.ok, false);
  if (moved.ok) return;
  assert.match(moved.detail, /take a message/i);
  // And the guest's real appointment was not touched on the way to saying no.
  assert.ok(!api.calls().includes("reschedule"), "Zenoti was asked anyway");
  assert.equal(api.bookings()[0].startMin, 9 * 60);
});

await test("a cancellation reaches the salon before Belline calls it cancelled", async () => {
  const api = sandboxPartner(facts);
  const provider = withSandbox(api);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-25", startMin: 9 * 60, guestName: "Dana", guestPhone: "+971505555555", serviceIds: ["svc-1"] },
  );
  assert.ok(made.ok);
  if (!made.ok) return;
  api.down(true);
  const refused = await provider.cancelBooking({ location: venue() }, made.booking);
  assert.equal(refused.ok, false);
  assert.equal(api.bookings()[0].status, "confirmed");
  api.down(false);
  const done = await provider.cancelBooking({ location: venue() }, made.booking);
  assert.equal(done.ok, true);
  assert.equal(api.bookings()[0].status, "cancelled");
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
