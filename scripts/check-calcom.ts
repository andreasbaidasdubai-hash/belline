/**
 * Cal.com, against a fake Cal.com.
 *
 * The partner with no gatekeeper — open source, public API, a key the venue's
 * own account holder mints in their settings — which makes it the easiest of
 * these to connect and therefore the one where a quiet mistake would reach a
 * real diary fastest. Nothing stands between this code and a customer's
 * calendar except this check.
 *
 * Five things are held down here rather than left in a document:
 *
 * - **The `cal-api-version` header, on every request.** Cal.com documents that
 *   an absent or wrong value silently falls back to an older version of the
 *   endpoint instead of failing. A dropped header would not break a test; it
 *   would change what the API means. So every request is inspected.
 * - **Cal.com decides the length.** `format=range` is asked for so the end time
 *   is Cal.com's, and the check fails if the adapter starts computing one.
 * - **A booking needs an email address**, and refusing without one is what makes
 *   the agent ask rather than fail in front of a guest.
 * - **No person is ever named.** A Cal.com slot carries no host, and a
 *   round-robin event type does not have one until the booking is made.
 * - **Time is the venue's.** Cal.com books an instant; a venue that has not
 *   said which zone it answers in is not connected.
 *
 * And the comparison the founder asked for: this is the second worked example
 * of the booking-page shape, and `check:calendly` on the other branch is its
 * twin. The differences that matter are asserted here — Cal.com has a real
 * reschedule endpoint where Calendly has none, and Cal.com can be self-hosted,
 * so its base URL is a venue property.
 *
 * A green run is Belline's side being ready. No venue has given Belline a key,
 * `booking.partner.calcom` is off everywhere, and Cal.com is not on the
 * website's strip.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches Cal.com.
 *
 *   npm run check:calcom
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-calcom-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 11).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_CALCOM_") || key === "FLAG_BOOKING_PARTNER_CALCOM" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { calcomConnector, calcomApi, CALCOM_API_VERSIONS, instantOf, minutesOf } = await import(
  "../src/lib/integrations/partners/calcom"
);
const { partnerMode } = await import("../src/lib/integrations/partners/contract");
const { sandboxPartner } = await import("../src/lib/integrations/partners/sandbox");
const { partnerProvider } = await import("../src/lib/booking/partner-provider");
const { providerFor, requestOnlyProvider, localProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { INTEGRATIONS, integrationState } = await import("./site-integrations");
const { BOOKING_TOOL_NAMES, toolsFor } = await import("../src/lib/agent/tools");
type Loc = import("../src/lib/types").Location;
type PartnerApi = import("../src/lib/integrations/partners/contract").PartnerApi;
type PartnerRequest = import("../src/lib/integrations/partners/http").PartnerRequest;

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
const facts = PARTNERS.calcom;

const LINK = { venueId: "belline-salon", sealedToken: "sealed", timeZone: "Asia/Dubai" };

const venue = (link: Record<string, unknown> | null = LINK): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "calcom", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: link ? { calcom: link } : undefined,
  }) as Loc;

const withSandbox = (api: PartnerApi) => partnerProvider({ ...calcomConnector, apiFor: () => api, usable: () => true });

// ---------------------------------------------------------------------------
// A fake Cal.com: its own envelope, and nothing it would not send.
// ---------------------------------------------------------------------------

interface FakeOptions {
  slots?: { start: string; end: string }[];
  /** The day the slots are filed under, which is not always the day asked for. */
  key?: string;
}

function fakeCalcom(options: FakeOptions = {}) {
  const seen: PartnerRequest[] = [];
  const transport = {
    async request<T>(req: PartnerRequest): Promise<T> {
      seen.push(req);
      if (req.path === "slots") {
        const key = options.key ?? String(req.query?.start ?? "");
        const slots = options.slots ?? [
          { start: "2026-09-21T09:00:00.000+04:00", end: "2026-09-21T09:30:00.000+04:00" },
          { start: "2026-09-21T10:00:00.000+04:00", end: "2026-09-21T10:30:00.000+04:00" },
        ];
        return { status: "success", data: { [key]: slots } } as T;
      }
      if (/\/reschedule$/.test(req.path)) return { status: "success", data: { uid: "uid-moved" } } as T;
      if (/\/cancel$/.test(req.path)) return { status: "success", data: { uid: "uid-1", status: "cancelled" } } as T;
      return { status: "success", data: { id: 1, uid: "uid-1" } } as T;
    },
  };
  return { transport, seen };
}

const api = (options: FakeOptions = {}) => {
  const fake = fakeCalcom(options);
  return { ...fake, api: calcomApi(fake.transport, { timeZone: "Asia/Dubai" }) };
};

// ---------------------------------------------------------------------------
head("What the research found, written down");

await test("all four operations are recorded, because Cal.com documents all four", () => {
  assert.equal(facts.api.documented, true);
  assert.equal(facts.api.availability, true);
  assert.equal(facts.api.create, true);
  assert.equal(facts.api.reschedule, true);
  assert.equal(facts.api.cancel, true);
  assert.equal(facts.model, "appointments");
});

await test("there is nothing to apply for, and the registry says so rather than inventing a queue", () => {
  assert.equal(facts.sandbox, "self-serve");
  assert.match(facts.gate.what, /Nothing to apply for/i);
  // The key is the venue's, exactly as Zenoti's is. Nothing goes in env.
  assert.deepEqual(facts.liveNeeds, []);
  assert.ok(facts.venueNeeds.some((n) => /API key/i.test(n)), "the venue's own key is not recorded as something to collect");
  assert.ok(facts.venueNeeds.some((n) => /time zone/i.test(n)), "the zone Cal.com answers in is not recorded");
});

await test("the honest limits of a booking page are recorded", () => {
  const has = (re: RegExp) => facts.limits.some((l) => re.test(l));
  assert.ok(has(/email address/i), "the mandatory attendee email is not recorded");
  assert.ok(has(/event type fixes the length/i), "that Cal.com owns the duration is not recorded");
  assert.ok(has(/round-robin|collective/i), "pooled event types are not recorded");
  assert.ok(has(/[Mm]anaged event types/), "the managed-event-type trap is not recorded");
  assert.ok(has(/Nothing holds a slot/i), "that no slot is held is not recorded");
  assert.ok(has(/cal-api-version/), "the silent version fallback is not recorded");
  assert.ok(has(/UNVERIFIED/), "nothing is marked unverified");
});

await test("the differences from Calendly are written down, because the two are not interchangeable", () => {
  const registry = source("src/lib/integrations/partners/registry.ts");
  const calcom = registry.slice(registry.indexOf("Cal.com: the only one"), registry.indexOf("calcom: {"));
  assert.match(calcom, /Calendly/, "the comparison the two examples exist for is missing");
  assert.match(calcom, /reschedule/i, "the reschedule difference is not recorded");
  assert.match(calcom, /self-hosted/i, "that Cal.com can be self-hosted is not recorded");
  assert.match(calcom, /[Mm]anaged event type/, "the managed-event-type difference is not recorded");
});

// ---------------------------------------------------------------------------
head("The version header, on every single request");

await test("the three pinned versions are the ones the adapter was written against", () => {
  assert.deepEqual(CALCOM_API_VERSIONS, { slots: "2024-09-04", bookings: "2026-02-25", eventTypes: "2024-06-14" });
});

await test("every request carries its endpoint's version, because a missing one is not an error", async () => {
  const { api: cal, seen } = api();
  await cal.availability({ date: "2026-09-21", serviceIds: ["10"] });
  await cal.create({
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 9 * 60 + 30,
    guestName: "Layla",
    guestPhone: "+971501234567",
    guestEmail: "layla@example.com",
    serviceIds: ["10"],
    idempotencyKey: "k-1",
  });
  await cal.reschedule({ id: "uid-1" }, { date: "2026-09-22", startMin: 10 * 60, endMin: 10 * 60 + 30 });
  await cal.cancel({ id: "uid-1" });
  assert.equal(seen.length, 4);
  for (const req of seen) {
    const version = req.headers?.["cal-api-version"];
    assert.ok(version, `${req.method} ${req.path} was sent with no cal-api-version, which Cal.com answers with an older endpoint`);
    assert.ok(Object.values(CALCOM_API_VERSIONS).includes(version as never), `${req.path} sent an unknown version ${version}`);
  }
  assert.equal(seen[0].headers?.["cal-api-version"], CALCOM_API_VERSIONS.slots);
  for (const req of seen.slice(1)) assert.equal(req.headers?.["cal-api-version"], CALCOM_API_VERSIONS.bookings);
});

// ---------------------------------------------------------------------------
head("Cal.com decides the times and the lengths");

await test("slots are asked for as ranges, so the appointment's length is Cal.com's", async () => {
  const { api: cal, seen } = api();
  const slots = await cal.availability({ date: "2026-09-21", serviceIds: ["10"] });
  assert.equal(seen[0].query?.format, "range", "Belline asked for bare start times and would have to invent the ends");
  assert.equal(seen[0].query?.eventTypeId, "10");
  assert.equal(seen[0].query?.timeZone, "Asia/Dubai", "slots were not asked for in the venue's own zone");
  assert.deepEqual(slots.map((s) => s.startMin), [9 * 60, 10 * 60]);
  // 30 minutes, because Cal.com said 30 — not because Belline assumed it.
  assert.deepEqual(slots.map((s) => s.endMin), [9 * 60 + 30, 10 * 60 + 30]);
});

await test("no event type means no answer, rather than a guess at the whole day", async () => {
  const { api: cal, seen } = api();
  assert.deepEqual(await cal.availability({ date: "2026-09-21" }), []);
  assert.deepEqual(seen, [], "Belline asked Cal.com a question it cannot answer");
});

await test("slots filed under another day are not offered as this day's", async () => {
  // Cal.com keys the response by date; a mismatch must not become an answer.
  const { api: cal } = api({ key: "2026-09-22" });
  assert.deepEqual(await cal.availability({ date: "2026-09-21", serviceIds: ["10"] }), []);
});

await test("no caller is ever promised a person, because a Cal.com slot has no host", async () => {
  const { api: cal } = api();
  const slots = await cal.availability({ date: "2026-09-21", serviceIds: ["10"] });
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    assert.equal(slot.staffId, undefined, "Belline named a host Cal.com had not chosen");
    assert.equal(slot.staffName, undefined);
  }
});

await test("the slot's own instant is handed back, rather than recomputed at booking time", async () => {
  const { api: cal, seen } = api();
  const slots = await cal.availability({ date: "2026-09-21", serviceIds: ["10"] });
  await cal.create({
    date: "2026-09-21",
    startMin: slots[0].startMin,
    endMin: slots[0].endMin,
    guestName: "Layla",
    guestPhone: "+971501234567",
    guestEmail: "layla@example.com",
    serviceIds: ["10"],
    token: slots[0].token,
    idempotencyKey: "k-2",
  });
  const body = seen[1].body as { start?: string };
  assert.equal(body.start, "2026-09-21T09:00:00.000+04:00", "Belline rewrote the instant Cal.com had offered");
});

await test("a wall time becomes an instant through the venue's zone, never a Belline default", () => {
  // 09:00 in Dubai is 05:00 UTC. If this ever reads 09:00Z, a Gulf salon is
  // taking bookings four hours out.
  assert.equal(instantOf("2026-09-21", 9 * 60, "Asia/Dubai"), "2026-09-21T05:00:00.000Z");
  assert.equal(instantOf("2026-09-21", 9 * 60, "Europe/Berlin"), "2026-09-21T07:00:00.000Z");
  assert.equal(minutesOf("2026-09-21T09:30:00.000+04:00"), 9 * 60 + 30);
  assert.ok(Number.isNaN(minutesOf("not a time")));
});

// ---------------------------------------------------------------------------
head("Bookings");

await test("a guest with no email address is refused before anything leaves, and is told why", async () => {
  const { api: cal, seen } = api();
  await assert.rejects(
    () =>
      cal.create({
        date: "2026-09-21",
        startMin: 9 * 60,
        endMin: 9 * 60 + 30,
        guestName: "Layla",
        guestPhone: "+971501234567",
        serviceIds: ["10"],
        idempotencyKey: "k-3",
      }),
    /email address/i,
  );
  assert.deepEqual(seen, [], "Belline sent Cal.com a booking it would have refused");
});

await test("a booking is Cal.com's own shape, and its uid is what Belline keeps", async () => {
  const { api: cal, seen } = api();
  const ref = await cal.create({
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 9 * 60 + 30,
    guestName: "Layla",
    guestPhone: "+971501234567",
    guestEmail: "  layla@example.com  ",
    serviceIds: ["10"],
    idempotencyKey: "k-4",
  });
  // Every other endpoint takes the uid, and it is what a guest reads off their
  // confirmation. The numeric id is not it.
  assert.equal(ref.id, "uid-1");
  assert.equal(ref.ref, "uid-1");
  const body = seen[0].body as { eventTypeId?: number; attendee?: Record<string, string> };
  assert.equal(body.eventTypeId, 10, "the event type was sent as a string where Cal.com wants a number");
  assert.equal(body.attendee?.email, "layla@example.com", "the address was sent with the caller's stray spaces");
  assert.equal(body.attendee?.timeZone, "Asia/Dubai");
});

await test("a move is one endpoint, and the booking follows the uid Cal.com gives back", async () => {
  const { api: cal, seen } = api();
  const moved = await cal.reschedule({ id: "uid-1" }, { date: "2026-09-22", startMin: 10 * 60, endMin: 10 * 60 + 30 });
  assert.match(seen[0].path, /^bookings\/uid-1\/reschedule$/);
  // Calendly has no such endpoint and has to create-then-cancel. This is the
  // difference, and it is why the moved booking has a new uid to follow.
  assert.equal(moved.id, "uid-moved", "Belline kept the old uid and would lose the guest's booking");
  assert.equal(moved.ref, "uid-moved");
});

await test("a cancellation carries a reason a guest can read, never an empty one", async () => {
  const { api: cal, seen } = api();
  await cal.cancel({ id: "uid-1" }, "   ");
  assert.match(seen[0].path, /^bookings\/uid-1\/cancel$/);
  const reason = (seen[0].body as { cancellationReason?: string }).cancellationReason ?? "";
  assert.ok(reason.trim().length > 0, "Cal.com would have mailed the guest an empty cancellation");
  assert.ok(!/undefined|null/i.test(reason), `the guest would have been mailed "${reason}"`);
});

// ---------------------------------------------------------------------------
head("Not connected");

await test("no key, no venue: the salon takes requests", () => {
  assert.equal(partnerMode(facts, {}), "off");
  assert.equal(calcomConnector.usable(venue(), {}), false);
  assert.equal(calcomConnector.apiFor(venue(), {}), null);
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "Cal.com fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("a venue that has not said which zone it answers in is not connected", () => {
  const env = { FLAG_BOOKING_PARTNER_CALCOM: "on", PARTNER_CALCOM_API_KEY: "k", PARTNER_CALCOM_ENV: "live" };
  assert.equal(calcomConnector.usable(venue({ venueId: "v", sealedToken: "sealed" }), env), false, "a venue with no zone looked connected");
  assert.equal(calcomConnector.usable(venue(LINK), env), true);
});

await test("a venue that has given Belline no key is not connected, however the flags are set", () => {
  const env = { FLAG_BOOKING_PARTNER_CALCOM: "on", PARTNER_CALCOM_API_KEY: "k", PARTNER_CALCOM_ENV: "live" };
  assert.equal(calcomConnector.usable(venue({ venueId: "v", timeZone: "Asia/Dubai" }), env), false);
  for (const withdrawn of ["expiredAt", "misconfiguredAt"] as const) {
    const loc = venue({ ...LINK, [withdrawn]: "2026-09-18T00:00:00.000Z" });
    assert.equal(calcomConnector.usable(loc, env), false, withdrawn);
    assert.equal(takesRequestsOnly(loc), true, withdrawn);
  }
});

await test("Cal.com is not on the website's strip at all", () => {
  assert.equal(
    INTEGRATIONS.some((i) => i.flag === "booking.partner.calcom"),
    false,
    "Cal.com was put on the landing page before anyone decided to list it",
  );
  assert.equal(partnerLive("calcom", {}), false);
});

/**
 * The gate on a venue-keyed partner is weaker than on a Belline-keyed one, and
 * this test says so out loud rather than asserting a comfortable falsehood.
 *
 * For Mindbody, `liveNeeds` holds the staff credentials Mindbody's own approval
 * issues, so the website cannot say "Available" until Mindbody has actually
 * approved us — the gate is a partner's decision. Cal.com has no such
 * credential to wait for: the key belongs to the venue's own account, so
 * `liveNeeds` is empty and the only thing standing between the flag and the
 * word "Available" is a person typing `PARTNER_CALCOM_ENV=live` on a
 * deployment. Zenoti is the same shape for the same reason.
 *
 * That is the documented design (contract.ts) and not an accident, but it is a
 * human act rather than a partner's, so it is written down here and in
 * docs/integrations/partners.md where the founder will see it.
 */
await test("without an explicit live deployment Cal.com stays on the roadmap", () => {
  const item = { name: "Cal.com", logo: "calcom.png", flag: "booking.partner.calcom", pending: "roadmap" } as const;
  assert.equal(integrationState(item, {}), "roadmap", "with no env at all");
  // The flag and a key are not enough: that is what a deployment being tested
  // against a fake looks like.
  assert.equal(integrationState(item, { FLAG_BOOKING_PARTNER_CALCOM: "on", PARTNER_CALCOM_API_KEY: "k" }), "roadmap", "flag and key alone");
  assert.equal(
    integrationState(item, { FLAG_BOOKING_PARTNER_CALCOM: "on", PARTNER_CALCOM_API_KEY: "k", PARTNER_CALCOM_ENV: "sandbox" }),
    "roadmap",
    "a sandbox connection counted as an available one",
  );
  assert.equal(integrationState(item, { FLAG_STUBS: "on", FLAG_BOOKING_PARTNER_CALCOM: "on" }), "roadmap", "stubs promoted a logo");
  // And the one thing that does promote it is a person saying `live` out loud,
  // which for this partner is the only gate there is.
  assert.equal(
    integrationState(item, { FLAG_BOOKING_PARTNER_CALCOM: "on", PARTNER_CALCOM_API_KEY: "k", PARTNER_CALCOM_ENV: "live" }),
    "available",
    "the documented behaviour for a venue-keyed partner has changed; docs/integrations/partners.md says otherwise",
  );
});

// ---------------------------------------------------------------------------
head("Through the provider, as a venue would see it");

await test("everything Cal.com can do is offered, and no person and no waitlist", () => {
  const provider = withSandbox(sandboxPartner(facts, { staff: [] }));
  assert.equal(provider.capabilities.availability, true);
  assert.equal(provider.capabilities.confirms, true);
  assert.equal(provider.capabilities.reschedule, true);
  assert.equal(provider.capabilities.cancel, true);
  assert.equal(provider.capabilities.waitlist, false);
});

await test("a repeated booking is one booking", async () => {
  const fake = sandboxPartner(facts, { staff: [] });
  const provider = withSandbox(fake);
  const input = { date: "2026-09-22", startMin: 9 * 60, guestName: "Aisha", guestPhone: "+971504444444", serviceIds: ["10"] };
  const first = await provider.createBooking({ location: venue() }, input);
  const again = await provider.createBooking({ location: venue() }, input);
  assert.ok(first.ok && again.ok);
  if (!first.ok || !again.ok) return;
  assert.equal(again.duplicate, true);
  assert.equal(fake.bookings().length, 1);
});

await test("a Cal.com that cannot be reached quotes nothing and books nothing", async () => {
  const provider = withSandbox(sandboxPartner(facts, { staff: [], down: true }));
  assert.deepEqual(await provider.checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-25" }), []);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-25", startMin: 9 * 60, guestName: "Yara", guestPhone: "+971501111111", serviceIds: ["10"] },
  );
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.detail, /message|team will confirm/i);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
