/**
 * Mindbody, against a fake Mindbody.
 *
 * The only one of the six with an open specification and a sandbox anybody can
 * have, and the one whose *shape* is most likely to be got wrong later. Three
 * of Mindbody's own facts are held down here rather than left in a document:
 *
 * - `availabledates` says when a therapist is rostered, which is not the same
 *   as a bookable gap. Only `bookableitems` may be quoted.
 * - Public API v6 cannot cancel a booked appointment. The agent is therefore
 *   never given a cancel tool, and a guest who rings to cancel is taken as a
 *   message. Saying "that's cancelled" here would be a lie.
 * - Every studio activates Belline itself, with a code its owner types in.
 *   Approval for one studio opens no other door.
 *
 * A green run is Belline's side being ready. Mindbody has approved nothing,
 * `booking.partner.mindbody` is off everywhere, and the website says "on our
 * roadmap".
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches Mindbody.
 *
 *   npm run check:mindbody
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-mindbody-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 3).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_MINDBODY_") || key === "FLAG_BOOKING_PARTNER_MINDBODY" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { mindbodyConnector, MINDBODY_SANDBOX_SITE } = await import("../src/lib/integrations/partners/mindbody");
const { partnerMode } = await import("../src/lib/integrations/partners/contract");
const { sandboxPartner } = await import("../src/lib/integrations/partners/sandbox");
const { partnerProvider } = await import("../src/lib/booking/partner-provider");
const { providerFor, requestOnlyProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { INTEGRATIONS, integrationState } = await import("./site-integrations");
const { BOOKING_TOOL_NAMES, toolsFor } = await import("../src/lib/agent/tools");
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
const facts = PARTNERS.mindbody;

const venue = (link: Record<string, unknown> | null = { venueId: "123456" }): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "mindbody", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: link ? { mindbody: link } : undefined,
  }) as Loc;

const withSandbox = (api: PartnerApi) => partnerProvider({ ...mindbodyConnector, apiFor: () => api, usable: () => true });

const STAFF = [{ id: "100000001", name: "Dana" }];

// ---------------------------------------------------------------------------
head("What the research found, written down");

await test("the documented API is recorded as it is, cancellation included", () => {
  assert.equal(facts.api.documented, true);
  assert.equal(facts.api.availability, true);
  assert.equal(facts.api.create, true);
  assert.equal(facts.api.reschedule, true);
  // v6 has no appointment cancellation. This is the assertion that stops
  // somebody "fixing" it later by pointing at the class endpoints.
  assert.equal(facts.api.cancel, false);
  assert.equal(facts.sandbox, "self-serve");
  assert.match(facts.auth, /Api-Key.*SiteId|SiteId.*Api-Key/s);
  assert.equal(MINDBODY_SANDBOX_SITE, "-99");
});

await test("the two gates are written where a founder will read them", () => {
  assert.match(facts.gate.what, /go live/i);
  assert.match(facts.gate.what, /activation/i);
  assert.equal(facts.gate.apply, "https://developers.mindbodyonline.com/");
  assert.ok(facts.limits.some((l) => /activate Belline itself/i.test(l)), "per-studio activation is not recorded as a limit");
  assert.ok(facts.limits.some((l) => /1,000 calls/i.test(l)), "the daily call ceiling is not recorded");
  assert.ok(facts.limits.some((l) => /cancel/i.test(l)), "the missing cancellation is not recorded");
});

await test("the adapter quotes bookableitems and never availabledates", () => {
  const code = source("src/lib/integrations/partners/mindbody.ts");
  assert.match(code, /appointment\/bookableitems/);
  assert.match(code, /appointment\/addappointment/);
  assert.match(code, /appointment\/updateappointment/);
  assert.match(code, /usertoken\/issue/);
  // Present only in the comment explaining why it is not used.
  assert.ok(!/path: "appointment\/availabledates"/.test(code), "the adapter reads rostered dates as if they were availability");
  // Mindbody deduplicates addappointment itself; the header that turns that
  // off must never be sent from here.
  assert.ok(!/X-RequestDeduplication-Skip["']\s*:/.test(code), "the adapter switches off Mindbody's own deduplication");
});

// ---------------------------------------------------------------------------
head("Not connected");

await test("no approval, no key, no studio: the venue takes requests", () => {
  assert.equal(partnerMode(facts, {}), "off");
  assert.equal(mindbodyConnector.usable(venue(), {}), false);
  assert.equal(mindbodyConnector.apiFor(venue(), {}), null);
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
  }
});

await test("a studio that has not activated us is not connected, however approved we are", () => {
  const env = {
    FLAG_BOOKING_PARTNER_MINDBODY: "on",
    PARTNER_MINDBODY_API_KEY: "k",
    PARTNER_MINDBODY_STAFF_USERNAME: "belline",
    PARTNER_MINDBODY_STAFF_PASSWORD: "secret",
    PARTNER_MINDBODY_ENV: "live",
  };
  assert.equal(partnerMode(facts, env), "live");
  assert.equal(mindbodyConnector.usable(venue({ venueId: "123456" }), env), false, "a studio with no activation looked connected");
  assert.equal(mindbodyConnector.usable(venue({ venueId: "123456", sealedToken: "sealed" }), env), true);
});

await test("live needs the staff credentials the approval issues, not only the key", () => {
  const partial = { FLAG_BOOKING_PARTNER_MINDBODY: "on", PARTNER_MINDBODY_API_KEY: "k", PARTNER_MINDBODY_ENV: "live" };
  // Missing the staff username and password: not live, whatever was asked for.
  assert.equal(partnerMode(facts, partial), "sandbox");
  assert.equal(partnerLive("mindbody", partial), false);
});

await test("the website stays on the roadmap through all of it", () => {
  const item = INTEGRATIONS.find((i) => i.name === "Mindbody")!;
  assert.equal(integrationState(item, {}), "roadmap");
  assert.equal(
    integrationState(item, { FLAG_BOOKING_PARTNER_MINDBODY: "on", PARTNER_MINDBODY_API_KEY: "k", PARTNER_MINDBODY_ENV: "live" }),
    "roadmap",
    "a key and a switch promoted Mindbody without the approval behind it",
  );
});

// ---------------------------------------------------------------------------
head("Against a fake studio");

await test("only the studio's bookable times are offered", async () => {
  const api = sandboxPartner(facts, { opens: 8 * 60, closes: 11 * 60, stepMin: 60, staff: STAFF });
  const slots = await withSandbox(api).checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-21" });
  assert.deepEqual(slots.map((s) => s.startMin), [8 * 60, 9 * 60, 10 * 60]);
  assert.deepEqual(slots.map((s) => s.staffId), ["100000001", "100000001", "100000001"]);
});

await test("a guest may ask for a person, and a person who is not there is not offered", async () => {
  const api = sandboxPartner(facts, { staff: STAFF });
  const provider = withSandbox(api);
  assert.equal(provider.capabilities.staffSelection, true);
  const theirs = await provider.checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-21", staffId: "100000001" });
  assert.ok(theirs.length > 0);
  const nobody = await provider.checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-21", staffId: "999" });
  assert.deepEqual(nobody, [], "Belline offered a therapist the studio does not have");
});

await test("a booking is the studio's appointment, and a repeat is not a second one", async () => {
  const api = sandboxPartner(facts, { staff: STAFF });
  const provider = withSandbox(api);
  const input = {
    date: "2026-09-22",
    startMin: 9 * 60,
    guestName: "Aisha",
    guestPhone: "+971504444444",
    serviceIds: ["55"],
    staffId: "100000001",
  };
  const first = await provider.createBooking({ location: venue() }, input);
  const again = await provider.createBooking({ location: venue() }, input);
  assert.ok(first.ok && again.ok);
  if (!first.ok || !again.ok) return;
  assert.equal(first.booking.partnerBookingId, api.bookings()[0].id);
  assert.equal(again.duplicate, true);
  assert.equal(api.bookings().length, 1);
});

await test("an appointment can be moved, because Mindbody can move one", async () => {
  const api = sandboxPartner(facts, { staff: STAFF });
  const provider = withSandbox(api);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-23", startMin: 9 * 60, guestName: "Reem", guestPhone: "+971503333333", serviceIds: ["55"], staffId: "100000001" },
  );
  assert.ok(made.ok);
  if (!made.ok) return;
  const moved = await provider.rescheduleBooking({ location: venue() }, made.booking, { startMin: 11 * 60 });
  assert.ok(moved.ok, "Mindbody can update an appointment and Belline did not");
  if (!moved.ok) return;
  assert.equal(moved.booking.startMin, 11 * 60);
  assert.equal(api.bookings()[0].startMin, 11 * 60, "the studio's own diary was not moved");
});

await test("nobody is told an appointment is cancelled, because Mindbody cannot cancel one", async () => {
  const api = sandboxPartner(facts, { staff: STAFF });
  const provider = withSandbox(api);
  assert.equal(provider.capabilities.cancel, false);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-24", startMin: 9 * 60, guestName: "Hala", guestPhone: "+971502222222", serviceIds: ["55"], staffId: "100000001" },
  );
  assert.ok(made.ok);
  if (!made.ok) return;
  const out = await provider.cancelBooking({ location: venue() }, made.booking);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.detail, /take a message/i);
  assert.equal(api.bookings()[0].status, "confirmed", "the studio thinks it is cancelled and it is not");
  assert.ok(!api.calls().includes("cancel"), "Mindbody was asked to do something it cannot");
});

await test("a studio that cannot be reached quotes nothing and books nothing", async () => {
  const api = sandboxPartner(facts, { staff: STAFF, down: true });
  const provider = withSandbox(api);
  assert.deepEqual(await provider.checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-25" }), []);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-25", startMin: 9 * 60, guestName: "Yara", guestPhone: "+971501111111", serviceIds: ["55"], staffId: "100000001" },
  );
  assert.equal(made.ok, false);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
