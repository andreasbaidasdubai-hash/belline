/**
 * Calendly as a booking destination, against a fake Calendly.
 *
 * Written in the shape of check-google.ts and check-outlook.ts, and holding the
 * same promises: the OAuth state is signed and single use, the refresh token is
 * sealed and never sits in the location file, a token Calendly stops accepting
 * puts the venue on requests and tells the team and the owner, and every
 * outbound fetch is blocked for the whole run so nothing here reaches Calendly.
 *
 * What is only Calendly's, and what most of this file is about: **Calendly is
 * not a calendar**. It books the owner's own event types, each with a fixed
 * length and its own availability, and a great deal Belline can promise through
 * Google or Outlook it simply cannot promise here. Every one of those limits is
 * tested as a *product* behaviour — said at connect time, refused at the
 * destination step, and never discovered by a customer on the phone.
 *
 *   npm run check:calendly
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-calendly-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_APP_URL = "http://localhost:3000";
process.env.FLAG_STUBS = "on";
process.env.FLAG_BOOKING_CALENDLY = "on";
delete process.env.CALENDLY_CLIENT_ID;
delete process.env.CALENDLY_CLIENT_SECRET;

const { installFetchGuard, blockedFetches, fakeCalendlyApi } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { getBooking, getLocation, listBookings, listLocations, upsertLocation } = await import("../src/lib/store");
const calendly = await import("../src/lib/integrations/calendly");
const { CALENDLY_SCOPES, CALENDLY_WEBHOOK_EVENTS } = await import("../src/lib/integrations/calendly-api");
const { calendlyProvider } = await import("../src/lib/booking/calendly-provider");
const { providerFor, requestOnlyProvider } = await import("../src/lib/booking/provider");
const { calendlyUsable, needsGuestEmail, takesRequestsOnly } = await import("../src/lib/booking/destination");
const { openCredentials } = await import("../src/lib/db/credentials");
const { listExceptions } = await import("../src/lib/exceptions");
const { recordStep, NO_FACTS } = await import("../src/lib/onboarding/journey");
const { integrationErrorText, resetCustomerErrors } = await import("../src/lib/errors/customer");
const { zonedInstant } = await import("../src/lib/integrations/google-api");
const { addDays, todayIn } = await import("../src/lib/time");
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

/** Every file under DATA_DIR, as one string: what a copy of the data would show. */
function dataOnDisk(): string {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [fs.readFileSync(p, "utf8")];
    });
  return walk(process.env.DATA_DIR!).join("\n");
}

async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const error = console.error;
  const warn = console.warn;
  const log = console.log;
  console.error = () => {};
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.warn = warn;
    console.log = log;
  }
}

seedIfEmpty();
const venues = listLocations();
const salonBase = venues.find((l) => l.vertical === "salon" && !l.internal && (l.salon?.services.length ?? 0) >= 2)!;
const services = salonBase.salon!.services;

const TYPE_A = "https://api.calendly.com/event_types/TYPEAAAAAAAAAAAA";
const TYPE_B = "https://api.calendly.com/event_types/TYPEBBBBBBBBBBBB";
const POOLED = "https://api.calendly.com/event_types/TYPEPOOLED000000";

function freshApi() {
  const fake = fakeCalendlyApi({
    eventTypes: [
      { uri: TYPE_A, name: "Cut and finish", duration: services[0].durationMin },
      { uri: TYPE_B, name: "Colour", duration: services[1].durationMin },
      { uri: POOLED, name: "Anyone free", duration: 30, poolingType: "round_robin" },
    ],
    // Calendly's own open hours, in UTC, wide enough for any venue's day.
    open: { fromMin: 0, toMin: 24 * 60, stepMin: 30 },
  });
  calendly.setCalendlyApi(fake.api);
  return fake;
}
let fake = freshApi();

const REDIRECT = "http://localhost:3000/api/integrations/calendly";

/**
 * Connect through the real code path, map every service, and optionally choose
 * Calendly.
 *
 * Each call gets its own copy of the venue. Belline's own engine is real here —
 * it is what decides the venue's hours, notice and whether the stylist is free
 * — so a second test booking the same stylist at the same time on the same
 * venue would be refused by Belline before Calendly was ever asked, and would
 * prove nothing about Calendly.
 */
let venueSeq = 0;
async function connect(base: Loc, opts: { destination?: boolean; map?: boolean } = {}): Promise<Loc> {
  const at = new Date().toISOString();
  const own = { ...base, id: `${base.id}_cal${++venueSeq}` };
  let loc = await quiet(() => calendly.completeCalendlyConnection(own, "stub-code", REDIRECT, "user_owner"));
  if (opts.map !== false) {
    loc = {
      ...loc,
      calendly: {
        ...loc.calendly!,
        serviceEventTypes: Object.fromEntries(services.map((s, i) => [s.id, i === 1 ? TYPE_B : TYPE_A])),
      },
    };
  }
  if (opts.destination !== false) {
    loc = { ...loc, onboarding: { version: 1, channels: {}, ...base.onboarding, destination: { kind: "calendly", setAt: at } } };
  }
  return upsertLocation(loc);
}

/** A weekday this venue is open, a few days out, and a time inside its hours. */
function openDay(loc: Loc): { date: string; startMin: number } {
  const today = todayIn(loc.timezone);
  for (let i = 2; i < 14; i++) {
    const date = addDays(today, i);
    const ranges = loc.hours[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? [];
    if (ranges.length) {
      // On the half hour, which is the stub's grid, and comfortably inside.
      const start = Math.ceil((ranges[0].start + 60) / 30) * 30;
      if (start + 120 <= ranges[0].end) return { date, startMin: start };
    }
  }
  throw new Error("no open day found in the next fortnight");
}

const iso = (l: Loc, date: string, min: number) => new Date(zonedInstant(date, min, l.timezone)).toISOString();

// ---------------------------------------------------------------------------
head("OAuth: exact scopes, signed single-use state, a real revoke");

await test("the scopes are exactly the five Calendly's own docs name for what Belline does", () => {
  assert.deepEqual([...CALENDLY_SCOPES], [
    "event_types:read",
    "availability:read",
    "scheduled_events:read",
    "scheduled_events:write",
    "webhooks:write",
  ]);
  // Never the two that would let Belline change the owner's booking page.
  assert.ok(!CALENDLY_SCOPES.includes("event_types:write" as never));
  assert.ok(!CALENDLY_SCOPES.includes("availability:write" as never));
});

await test("the auth URL goes to Calendly with those scopes, and the state is not the bare venue id", () => {
  calendly.setCalendlyApi(fake.api);
  const { state } = calendly.signCalendlyState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const url = new URL(calendly.calendlyAuthUrl(state, REDIRECT));
  assert.equal(url.hostname, "auth.calendly.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), CALENDLY_SCOPES.join(" "));
  assert.notEqual(url.searchParams.get("state"), salonBase.id);
  assert.ok(!url.searchParams.get("state")!.includes(salonBase.id));
});

await test("a state verifies once, for the same user and browser, and never twice", () => {
  const { state, nonce } = calendly.signCalendlyState({ locationId: salonBase.id, userId: "user_owner", returnTo: "calendars" });
  assert.deepEqual(calendly.verifyCalendlyState(state, { userId: "user_owner", cookieNonce: nonce }), {
    ok: true,
    locationId: salonBase.id,
    returnTo: "calendars",
  });
  const again = calendly.verifyCalendlyState(state, { userId: "user_owner", cookieNonce: nonce });
  assert.ok(!again.ok && again.reason === "used");
});

await test("a state signed for Google or Outlook is not good at Calendly's callback", async () => {
  const google = await import("../src/lib/integrations/google");
  const theirs = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const checked = calendly.verifyCalendlyState(theirs.state, { userId: "user_owner", cookieNonce: theirs.nonce });
  assert.ok(!checked.ok && checked.reason === "signature");
});

await test("under stubs with nothing injected, the auth URL comes straight back here, never to Calendly", () => {
  calendly.setCalendlyApi(null);
  try {
    const url = new URL(calendly.calendlyAuthUrl("s.t", REDIRECT));
    assert.equal(url.hostname, "localhost");
    assert.equal(url.searchParams.get("code"), "stub-code");
  } finally {
    calendly.setCalendlyApi(fake.api);
  }
});

await test("the route verifies the signed state before trusting a venue, and the flag gates the start", () => {
  const route = source("src/app/api/integrations/calendly/route.ts");
  assert.match(route, /verifyCalendlyState\(state, \{ userId: auth\.user\.id, cookieNonce/);
  assert.match(route, /getLocation\(checked\.locationId\)/);
  assert.match(route, /!flag\("booking\.calendly"\) \|\| !credentialsConfigured\(\)/);
  assert.doesNotMatch(route, /refreshToken/);
  // The callback branch never builds a Calendly URL.
  assert.equal(route.match(/calendlyAuthUrl\(/g)?.length, 1);
  assert.ok(route.indexOf("calendlyAuthUrl(") < route.indexOf("verifyCalendlyState("));
});

await test("a decline lands back where it started with 'No problem — requests for now', never on Calendly", () => {
  assert.equal(calendly.calendlyReturnPath("setup", salonBase.id, "declined"), "/setup/bookings?calendly=declined");
  assert.equal(calendly.calendlyReturnPath("calendars", salonBase.id, "declined"), `/calendars?loc=${salonBase.id}&error=calendly_declined`);
  assert.match(integrationErrorText("calendly_declined")!, /^No problem — requests for now\./);
  assert.match(integrationErrorText("calendly_failed")!, /Please connect again/);
  resetCustomerErrors();
});

// ---------------------------------------------------------------------------
head("The token is sealed, never plain, and rotates the way Calendly's does");

await test("connecting stores a sealed token that opens, and no plain token anywhere in the data", async () => {
  const loc = await connect(salonBase, { destination: false });
  const link = loc.calendly!;
  assert.ok(link.sealedToken?.startsWith("v1."));
  assert.equal((link as { refreshToken?: string }).refreshToken, undefined);
  const plain = openCredentials(link.sealedToken!).refreshToken;
  assert.match(plain, /^stub-cal-refresh-/);
  assert.ok(!JSON.stringify(getLocation(loc.id)).includes(plain), "token in the location JSON");
  assert.ok(!dataOnDisk().includes(plain), "token in DATA_DIR");
  assert.equal(link.scope, CALENDLY_SCOPES.join(" "));
});

await test("a refresh keeps the newest token, because Calendly's old one stops working", async () => {
  const loc = await connect(salonBase, { destination: false });
  const first = openCredentials(loc.calendly!.sealedToken!).refreshToken;
  // Force a refresh by emptying the access cache the way a restart would.
  calendly.setCalendlyApi(fake.api);
  await quiet(() => calendly.withCalendlyAccess(getLocation(loc.id)!, (token, api, link) => api.listEventTypes(token, link.owner)));
  const after = openCredentials(getLocation(loc.id)!.calendly!.sealedToken!).refreshToken;
  assert.notEqual(after, first, "the rotated token was not stored");
  assert.ok(fake.accepts(after), "the stored token is not one Calendly would accept");
  assert.ok(!fake.accepts(first), "the stub did not rotate, so the test proves nothing");
  assert.ok(!dataOnDisk().includes(after));
});

await test("the connection needs every scope: one missing is refused and handed back", async () => {
  fake.grant("event_types:read scheduled_events:read");
  try {
    await assert.rejects(
      () => quiet(() => calendly.completeCalendlyConnection(salonBase, "stub-code", REDIRECT, "user_owner")),
      (err: Error) => err.name === "CalendlyScopeError",
    );
  } finally {
    fake.grant([...CALENDLY_SCOPES].join(" "));
  }
});

await test("an application registered before Calendly had scopes ('default') satisfies all five", () => {
  assert.deepEqual(calendly.missingCalendlyScopes("default"), []);
  assert.deepEqual(calendly.missingCalendlyScopes(""), [...CALENDLY_SCOPES]);
});

// ---------------------------------------------------------------------------
head("There is nothing to book: an account with no event types is refused at the door");

await test("a Calendly with no active event type cannot be connected, and the owner is told what to do", async () => {
  const empty = fakeCalendlyApi({ eventTypes: [] });
  calendly.setCalendlyApi(empty.api);
  try {
    await assert.rejects(
      () => quiet(() => calendly.completeCalendlyConnection(salonBase, "stub-code", REDIRECT, "user_owner")),
      (err: Error) => err.name === "CalendlyNoEventTypesError",
    );
    assert.match(integrationErrorText("calendly_no_event_types")!, /no bookable event types/);
    assert.match(integrationErrorText("calendly_no_event_types")!, /Create at least one event type/);
  } finally {
    calendly.setCalendlyApi(fake.api);
  }
});

await test("a connected account whose event types are all deleted stops being usable, and takes requests", async () => {
  const loc = await connect(salonBase);
  assert.ok(calendlyUsable(loc));
  const emptied = upsertLocation({ ...loc, calendly: { ...loc.calendly!, eventTypes: [] } });
  assert.ok(!calendlyUsable(emptied));
  assert.ok(takesRequestsOnly(emptied));
  assert.equal(providerFor(emptied), requestOnlyProvider);
});

// ---------------------------------------------------------------------------
head("The honest limits, said at connect time and not on a call");

await test("a service with no Calendly event type is named, and blocks Calendly being chosen at all", async () => {
  const loc = await connect(salonBase, { map: false, destination: false });
  const bare = upsertLocation({ ...loc, calendly: { ...loc.calendly!, serviceEventTypes: {} } });
  const { ok, limits } = calendly.calendlyLimits(bare);
  assert.equal(ok, false, "an unbookable service did not block");
  const blocking = limits.find((l) => l.severity === "blocking")!;
  assert.match(blocking.text, /every service needs one/);
  for (const s of services) assert.ok(blocking.text.includes(s.name), `${s.name} is not named`);

  // And the destination step refuses it, with the same sentence.
  const said = recordStep(bare, { kind: "destination", destination: "calendly" }, NO_FACTS);
  assert.ok(!said.ok);
  assert.equal(said.error, blocking.text);
  assert.match(said.fix!, /^\/calendars\?loc=/);
});

await test("with every service mapped, Calendly can be chosen, and the remaining limits are still stated", async () => {
  const loc = await connect(salonBase, { destination: false });
  const { ok, limits } = calendly.calendlyLimits(loc);
  assert.equal(ok, true, `still blocked: ${JSON.stringify(limits)}`);
  const said = recordStep(loc, { kind: "destination", destination: "calendly" }, NO_FACTS);
  assert.ok(said.ok, `refused: ${JSON.stringify(said)}`);
  const texts = limits.map((l) => l.text).join(" ");
  // The three that are always true of Calendly, whatever the account.
  assert.match(texts, /needs an email address for every booking/);
  assert.match(texts, /no way to move a booking/);
  assert.match(texts, /limits how many bookings/);
  assert.ok(limits.every((l) => l.severity === "narrowing"));
});

await test("a Calendly length that disagrees with the service says which one the customer gets", async () => {
  const loc = await connect(salonBase, { destination: false });
  const shifted = upsertLocation({
    ...loc,
    calendly: {
      ...loc.calendly!,
      eventTypes: loc.calendly!.eventTypes!.map((t) => (t.uri === TYPE_A ? { ...t, duration: t.duration + 15 } : t)),
    },
  });
  const texts = calendly.calendlyLimits(shifted).limits.map((l) => l.text).join(" ");
  assert.match(texts, /Calendly's length is the one the customer gets/);
  assert.ok(texts.includes(services[0].name));
});

await test("a shared event type means Belline will not promise a person, and says so", async () => {
  const loc = await connect(salonBase, { destination: false });
  const pooled = upsertLocation({
    ...loc,
    calendly: { ...loc.calendly!, serviceEventTypes: Object.fromEntries(services.map((s) => [s.id, POOLED])) },
  });
  const texts = calendly.calendlyLimits(pooled).limits.map((l) => l.text).join(" ");
  assert.match(texts, /Calendly chooses who takes the appointment/);
  assert.equal(calendly.calendlyStaffSelection(pooled), false);
  assert.equal(calendlyProvider(pooled).capabilities.staffSelection, false);
  assert.deepEqual(await calendlyProvider(pooled).getStaff({ location: pooled }), []);
  // Solo event types, and the choice is honoured again.
  const solo = upsertLocation(loc);
  assert.equal(calendly.calendlyStaffSelection(solo), true);
  assert.equal(calendlyProvider(solo).capabilities.staffSelection, true);
});

await test("the Calendars page shows the limits, and the setup card refuses on the same answer", () => {
  const page = source("src/app/(app)/calendars/page.tsx");
  assert.match(page, /calendlyLimits\(venue\)\.limits/);
  assert.match(page, /Before Belline can book into this Calendly/);
  assert.match(page, /calendlyBlocked/);
  const setup = source("src/app/setup/[step]/page.tsx");
  assert.match(setup, /calendlyLimits\(venue\)\.limits\.find\(\(l\) => l\.severity === "blocking"\)/);
  // And the journey, which is what actually decides.
  assert.match(source("src/lib/onboarding/journey.ts"), /calendlyLimits\(location\)/);
});

// ---------------------------------------------------------------------------
head("Availability is Calendly's answer, narrowed by the venue's own rules");

await test("the times offered are Calendly's open times, inside the venue's hours, and never invented", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slots = await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] });
  assert.ok(slots.length > 0, "nothing offered at all");
  const ranges = loc.hours[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? [];
  for (const slot of slots) {
    assert.equal(slot.date, date);
    assert.equal(slot.endMin - slot.startMin, services[0].durationMin, "the length offered is not Calendly's event type's");
    assert.ok(ranges.some((r) => slot.startMin >= r.start && slot.endMin <= r.end), `${slot.startMin} is outside the venue's hours`);
  }
  // And every one of them is a time Calendly itself offered, never one Belline
  // worked out: asking Calendly again returns the same set.
  const again = await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] });
  assert.deepEqual(again.map((s) => s.startMin), slots.map((s) => s.startMin));
});

await test("a time somebody else took in Calendly is not offered, and is not bookable", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const before = await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] });
  const target = before[0];
  fake.takeSlot(TYPE_A, iso(loc, target.date, target.startMin));
  const after = await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] });
  assert.ok(!after.some((s) => s.startMin === target.startMin), "a time Calendly had given away was still offered");

  const said = await quiet(() =>
    calendlyProvider(loc).createBooking(
      { location: loc },
      { date: target.date, startMin: target.startMin, guestName: "Nadia", guestPhone: "+971500000001", guestEmail: "nadia@example.test", serviceIds: [services[0].id] },
    ),
  );
  assert.ok(!said.ok);
  assert.equal(said.reason, "unavailable");
  assert.match(said.detail!, /has just gone/);
  // And no Belline booking was left behind for a time nobody holds.
  assert.equal(listBookings({ locationId: loc.id, status: "confirmed" }).filter((b) => b.date === target.date && b.startMin === target.startMin).length, 0);
});

await test("a Calendly that cannot be read offers nothing at all, rather than a time nobody checked", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  fake.failNext("availableTimes", 5);
  const slots = await quiet(() => calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }));
  assert.deepEqual(slots, []);
});

await test("two services in one appointment is refused plainly, because Calendly cannot express it", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date, startMin } = openDay(loc);
  const both = [services[0].id, services[1].id];
  assert.deepEqual(await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: both }), []);
  const said = await quiet(() =>
    calendlyProvider(loc).createBooking(
      { location: loc },
      { date, startMin, guestName: "Nadia", guestPhone: "+971500000002", guestEmail: "n@example.test", serviceIds: both },
    ),
  );
  assert.ok(!said.ok);
  assert.match(said.detail!, /one kind of appointment at a time/);
});

// ---------------------------------------------------------------------------
head("Booking: a real Calendly invitee, once, or nothing at all");

await test("a booking becomes one Calendly invitee, and the Belline record points at it", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  const made = await calendlyProvider(loc).createBooking(
    { location: loc },
    { date: slot.date, startMin: slot.startMin, guestName: "Nadia", guestPhone: "+971500000003", guestEmail: "nadia@example.test", serviceIds: [services[0].id] },
  );
  assert.ok(made.ok, `refused: ${JSON.stringify(made)}`);
  const live = fake.bookings().filter((b) => !b.canceled);
  assert.equal(live.length, 1);
  assert.equal(live[0].email, "nadia@example.test");
  assert.equal(live[0].eventType, TYPE_A);
  assert.equal(live[0].startTime, iso(loc, slot.date, slot.startMin));
  assert.equal(made.booking.calendarEventId, live[0].eventUri);
  assert.equal(made.booking.calendarId, TYPE_A);
  assert.equal(made.booking.calendlyInvitee, live[0].uri);
  assert.equal(made.booking.calendarSync?.provider, "calendly");
});

await test("the same booking twice is one invitee, not two confirmation emails", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  const input = {
    date: slot.date,
    startMin: slot.startMin,
    guestName: "Nadia",
    guestPhone: "+971500000004",
    guestEmail: "twice@example.test",
    serviceIds: [services[0].id],
  };
  const first = await calendlyProvider(loc).createBooking({ location: loc }, input, "same-key");
  const second = await calendlyProvider(loc).createBooking({ location: loc }, input, "same-key");
  assert.ok(first.ok && second.ok);
  assert.equal(second.duplicate, true);
  assert.equal(second.booking.id, first.booking.id);
  assert.equal(fake.bookings().filter((b) => !b.canceled).length, 1, "Calendly holds two invitees for one booking");
});

await test("a create whose answer was lost is found again, not made twice", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  // The invitee lands in Calendly and then the reply is lost.
  fake.failNext("createInvitee", 1, { afterWrite: true });
  const made = await quiet(() =>
    calendlyProvider(loc).createBooking(
      { location: loc },
      { date: slot.date, startMin: slot.startMin, guestName: "Lost", guestPhone: "+971500000005", guestEmail: "lost@example.test", serviceIds: [services[0].id] },
    ),
  );
  assert.ok(made.ok, `the booking was thrown away although Calendly had it: ${JSON.stringify(made)}`);
  assert.equal(fake.bookings().filter((b) => !b.canceled).length, 1, "a second invitee was created");
  assert.equal(made.booking.calendarEventId, fake.bookings()[0].eventUri);
});

await test("without an email address Belline does not book, and says exactly why", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date, startMin } = openDay(loc);
  const said = await quiet(() =>
    calendlyProvider(loc).createBooking(
      { location: loc },
      { date, startMin, guestName: "No Address", guestPhone: "+971500000006", serviceIds: [services[0].id] },
    ),
  );
  assert.ok(!said.ok);
  assert.equal(said.reason, "needs_email");
  assert.match(said.detail!, /needs an email address/);
  assert.match(said.detail!, /take the booking as a request instead/);
  assert.equal(fake.bookings().length, 0, "something was written to Calendly without an address");
  // Nothing half-made in Belline either.
  assert.equal(listBookings({ locationId: loc.id, status: "confirmed" }).filter((b) => b.guestName === "No Address").length, 0);
});

await test("a Calendly venue always asks the caller for an address, whatever the venue's own setting", async () => {
  const loc = await connect(salonBase);
  assert.notEqual(loc.requiresEmail, true, "the venue already required one, so this proves nothing");
  assert.equal(needsGuestEmail(loc), true);
  // And the agent's own tool list reads that, not the raw field.
  const tools = source("src/lib/agent/tools.ts");
  assert.match(tools, /needsGuestEmail\(location\)/);
  assert.doesNotMatch(tools, /location\.requiresEmail/);
  // A venue on requests is not made to ask.
  assert.equal(needsGuestEmail(upsertLocation({ ...loc, calendly: undefined, onboarding: { ...loc.onboarding!, destination: { kind: "requests", setAt: new Date().toISOString() } } })), false);
});

// ---------------------------------------------------------------------------
head("A booking is never lost silently");

await test("a Calendly that refuses the booking cancels the Belline record, tells the caller, and raises", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  fake.failNext("createInvitee", 5);
  const said = await quiet(() =>
    calendlyProvider(loc).createBooking(
      { location: loc },
      { date: slot.date, startMin: slot.startMin, guestName: "Refused", guestPhone: "+971500000007", guestEmail: "refused@example.test", serviceIds: [services[0].id] },
    ),
  );
  assert.ok(!said.ok);
  assert.match(said.detail!, /Take their name, number and the time they want as a message/);
  // No Belline booking anybody would act on.
  assert.equal(listBookings({ locationId: loc.id, status: "confirmed" }).filter((b) => b.guestName === "Refused").length, 0);
  // The owner sees it on the connection, and the team has an exception.
  assert.match(getLocation(loc.id)!.calendly!.lastError!, /did not accept the last booking change/);
  assert.ok(listExceptions({ locationId: loc.id }).some((e) => e.kind === "calendly_booking_failed"));
});

await test("a Calendly plan that cannot take API bookings puts the venue on requests and says whose it is to fix", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  fake.refusePlan();
  const said = await quiet(() =>
    calendlyProvider(loc).createBooking(
      { location: loc },
      { date: slot.date, startMin: slot.startMin, guestName: "Free Plan", guestPhone: "+971500000008", guestEmail: "free@example.test", serviceIds: [services[0].id] },
    ),
  );
  fake.refusePlan(false);
  assert.ok(!said.ok);
  const after = getLocation(loc.id)!;
  assert.ok(after.calendly!.planBlockedAt, "the plan block was not recorded");
  assert.match(after.calendly!.lastError!, /will not let Belline make bookings on your current Calendly plan/);
  assert.equal(calendlyUsable(after), false, "the venue kept offering times it cannot book");
  assert.ok(takesRequestsOnly(after));
  assert.ok(listExceptions({ locationId: loc.id }).some((e) => e.kind === "calendly_plan_blocked"));
  // And it is a blocking limit on the page, so nobody chooses it in this state.
  assert.equal(calendly.calendlyLimits(after).ok, false);
});

await test("Calendly's daily booking ceiling is told to the caller, the owner and the team", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  fake.rateLimit({ daily: true });
  const said = await quiet(() =>
    calendlyProvider(loc).createBooking(
      { location: loc },
      { date: slot.date, startMin: slot.startMin, guestName: "Capped", guestPhone: "+971500000009", guestEmail: "capped@example.test", serviceIds: [services[0].id] },
    ),
  );
  fake.rateLimit(false);
  assert.ok(!said.ok);
  assert.match(said.detail!, /will not take any more bookings today/);
  assert.match(getLocation(loc.id)!.calendly!.lastError!, /limits how many an account can take through an app/);
  const raised = listExceptions({ locationId: loc.id }).find((e) => e.kind === "calendly_rate_limited");
  assert.ok(raised, "the team was not told the venue had hit Calendly's ceiling");
  assert.match(raised!.reason, /hundred a day/);
});

// ---------------------------------------------------------------------------
head("Moving and cancelling, the only way Calendly allows");

await test("a move makes the new booking first and cancels the old one after", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slots = await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] });
  const made = await calendlyProvider(loc).createBooking(
    { location: loc },
    { date: slots[0].date, startMin: slots[0].startMin, guestName: "Mover", guestPhone: "+971500000010", guestEmail: "mover@example.test", serviceIds: [services[0].id] },
  );
  assert.ok(made.ok);
  const first = fake.bookings()[0];

  const moved = await calendlyProvider(loc).rescheduleBooking({ location: loc }, made.booking, { date: slots[1].date, startMin: slots[1].startMin });
  assert.ok(moved.ok, `the move was refused: ${JSON.stringify(moved)}`);
  const live = fake.bookings().filter((b) => !b.canceled);
  assert.equal(live.length, 1, "Calendly holds the wrong number of invitees after a move");
  assert.equal(live[0].startTime, iso(loc, slots[1].date, slots[1].startMin));
  assert.ok(fake.bookings().find((b) => b.uri === first.uri)!.canceled, "the old Calendly booking is still standing");
  assert.equal(moved.booking.calendarEventId, live[0].eventUri);
});

await test("a move Calendly will not take leaves the customer with the time they already had", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slots = await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] });
  const made = await calendlyProvider(loc).createBooking(
    { location: loc },
    { date: slots[0].date, startMin: slots[0].startMin, guestName: "Stays", guestPhone: "+971500000011", guestEmail: "stays@example.test", serviceIds: [services[0].id] },
  );
  assert.ok(made.ok);
  fake.failNext("createInvitee", 5);
  const said = await quiet(() => calendlyProvider(loc).rescheduleBooking({ location: loc }, made.booking, { date: slots[2].date, startMin: slots[2].startMin }));
  assert.ok(!said.ok, "the move was reported as done although Calendly refused it");
  const kept = getBooking(made.booking.id)!;
  assert.equal(kept.status, "confirmed");
  assert.equal(kept.startMin, slots[0].startMin, "the Belline record moved although Calendly did not");
  const live = fake.bookings().filter((b) => !b.canceled);
  assert.equal(live.length, 1);
  assert.equal(live[0].startTime, iso(loc, slots[0].date, slots[0].startMin), "the original Calendly booking was lost");
});

await test("a cancellation the customer was told about is retried until Calendly takes it, then raised", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  const made = await calendlyProvider(loc).createBooking(
    { location: loc },
    { date: slot.date, startMin: slot.startMin, guestName: "Goes", guestPhone: "+971500000012", guestEmail: "goes@example.test", serviceIds: [services[0].id] },
  );
  assert.ok(made.ok);

  fake.failNext("cancelEvent", 10);
  const cancelled = await quiet(() => calendlyProvider(loc).cancelBooking({ location: loc }, made.booking, "Changed their mind"));
  // The customer is told it is cancelled: refusing here would leave them believing they are booked.
  assert.ok(cancelled.ok);
  assert.equal(cancelled.booking.status, "cancelled");
  assert.equal(cancelled.booking.calendarSync?.provider, "calendly");
  assert.equal(cancelled.booking.calendarSync?.state, "failed");
  assert.ok(fake.bookings().every((b) => !b.canceled), "the stub cancelled it anyway, so this proves nothing");

  // The sweep retries, still fails, and after the second failure the team is told.
  const later = new Date(Date.now() + 24 * 3600_000);
  const one = await quiet(() => calendly.retryCalendlyCancellations(later));
  assert.equal(one.failed, 1);
  assert.ok(listExceptions({ locationId: loc.id }).some((e) => e.kind === "calendly_cancel_failed"));

  // Calendly answers again, and the slot is freed without anybody doing anything.
  fake.failNext("cancelEvent", 0);
  const done = await quiet(() => calendly.retryCalendlyCancellations(new Date(Date.now() + 48 * 3600_000)));
  assert.equal(done.done, 1);
  assert.ok(fake.bookings().some((b) => b.canceled), "the slot is still held in Calendly");
  assert.equal(getBooking(made.booking.id)!.calendarSync?.state, "synced");
});

await test("the shared calendar sync leaves Calendly's marks alone rather than wiping them", async () => {
  const sync = source("src/lib/integrations/calendar-sync.ts");
  assert.match(sync, /if \(sync\.provider === "calendly"\) return "skipped";/);
  assert.match(sync, /retryCalendlyCancellations\(now\)/);
  assert.match(sync, /sweepAbandonedCalendlyConnects\(now\)/);
  assert.match(sync, /recheckCalendlyMisconfigured\(\)/);
  // Calendly is not a CalendarConnector: there is nothing to mirror into it.
  assert.doesNotMatch(sync, /calendlyConnector/);
  assert.doesNotMatch(source("src/lib/integrations/calendly.ts"), /CalendarConnector/);
});

// ---------------------------------------------------------------------------
head("Webhooks: what Belline can see of a change made in Calendly, and what it cannot");

await test("Belline subscribes to invitee.created and invitee.canceled, and seals the signing key", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const hook = loc.calendly!.webhook!;
  assert.ok(hook.uri);
  const subscribed = fake.webhooks().find((w) => w.uri === hook.uri)!;
  assert.deepEqual(subscribed.events, [...CALENDLY_WEBHOOK_EVENTS]);
  assert.match(subscribed.callbackUrl, /\/api\/webhooks\/calendly\//);
  assert.ok(subscribed.callbackUrl.endsWith(encodeURIComponent(loc.id)));
  // The key is sealed like every other secret, and never in the data in the clear.
  const key = calendly.calendlySigningKey(loc)!;
  assert.equal(key, subscribed.signingKey);
  assert.ok(!dataOnDisk().includes(key), "the signing key is in the data in the clear");
  assert.equal(calendly.calendlyWebhookReadable(loc), true);
});

await test("with no signing key at all, deliveries are refused and the owner is told what Belline cannot see", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  // A subscription whose key Calendly did not hand back, and no application key
  // in the environment: Belline cannot check a single delivery.
  const keyless = upsertLocation({ ...loc, calendly: { ...loc.calendly!, webhook: { uri: "x", createdAt: new Date().toISOString() } } });
  assert.equal(calendly.calendlySigningKey(keyless, {}), null);
  assert.equal(calendly.calendlyWebhookReadable(keyless, {}), false);
  assert.match(calendly.calendlyLimits(keyless).limits.map((l) => l.text).join(" "), /will not reach Belline on its own/);
  // Calendly issues the key per OAuth application, shown once in the developer
  // portal, so most deployments hold it as an environment variable.
  assert.equal(calendly.calendlySigningKey(keyless, { CALENDLY_WEBHOOK_SIGNING_KEY: "app-level-key" }), "app-level-key");
  assert.equal(calendly.calendlyWebhookReadable(keyless, { CALENDLY_WEBHOOK_SIGNING_KEY: "app-level-key" }), true);
});

await test("a webhook with no signature, a wrong one, or an old one is refused", async () => {
  const loc = await connect(salonBase);
  const key = calendly.calendlySigningKey(loc)!;
  const body = JSON.stringify({ event: "invitee.canceled" });
  const sign = (at: number, secret = key) =>
    `t=${Math.floor(at / 1000)},v1=${crypto.createHmac("sha256", secret).update(`${Math.floor(at / 1000)}.${body}`).digest("hex")}`;
  const now = Date.now();
  assert.equal(calendly.verifyCalendlySignature(sign(now), body, key, now), true);
  assert.equal(calendly.verifyCalendlySignature(null, body, key, now), false);
  assert.equal(calendly.verifyCalendlySignature(sign(now, "somebody else's key"), body, key, now), false);
  // Replayed an hour later.
  assert.equal(calendly.verifyCalendlySignature(sign(now), body, key, now + 3600_000), false);
  // And the route refuses rather than trusting the path alone.
  const route = source("src/app/api/webhooks/calendly/[locationId]/route.ts");
  assert.match(route, /verifyCalendlySignature\(request\.headers\.get\("calendly-webhook-signature"\), raw, key\)/);
  assert.match(route, /if \(!key\) \{/);
  assert.match(route, /status: 401/);
});

await test("a customer who cancels on Calendly's page is not still expected in Belline", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  const made = await calendlyProvider(loc).createBooking(
    { location: loc },
    { date: slot.date, startMin: slot.startMin, guestName: "Gone", guestPhone: "+971500000013", guestEmail: "gone@example.test", serviceIds: [services[0].id] },
  );
  assert.ok(made.ok);
  const outcome = await quiet(() =>
    calendly.applyCalendlyWebhook(getLocation(loc.id)!, {
      event: "invitee.canceled",
      payload: { email: "gone@example.test", scheduled_event: { uri: made.booking.calendarEventId } },
    }),
  );
  assert.deepEqual(outcome, { applied: "cancelled", bookingId: made.booking.id });
  assert.equal(getBooking(made.booking.id)!.status, "cancelled");
  // A redelivery of the same event changes nothing.
  const again = await quiet(() =>
    calendly.applyCalendlyWebhook(getLocation(loc.id)!, {
      event: "invitee.canceled",
      payload: { scheduled_event: { uri: made.booking.calendarEventId } },
    }),
  );
  assert.equal(again.applied, "ignored");
});

await test("a booking made on the owner's own Calendly page is ignored, not invented", async () => {
  const loc = await connect(salonBase);
  const outcome = await quiet(() =>
    calendly.applyCalendlyWebhook(loc, {
      event: "invitee.created",
      payload: { email: "stranger@example.test", scheduled_event: { uri: "https://api.calendly.com/scheduled_events/SOMEBODYELSE" } },
    }),
  );
  assert.equal(outcome.applied, "ignored");
});

await test("a reschedule made in Calendly is recorded plainly, because Belline cannot follow it", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const { date } = openDay(loc);
  const slot = (await calendlyProvider(loc).checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds: [services[0].id] }))[0];
  const made = await calendlyProvider(loc).createBooking(
    { location: loc },
    { date: slot.date, startMin: slot.startMin, guestName: "Moved", guestPhone: "+971500000014", guestEmail: "moved@example.test", serviceIds: [services[0].id] },
  );
  assert.ok(made.ok);
  // Calendly has no invitee.rescheduled: it is a cancel, then a create naming
  // the invitee it replaced.
  await quiet(() =>
    calendly.applyCalendlyWebhook(getLocation(loc.id)!, {
      event: "invitee.canceled",
      payload: { scheduled_event: { uri: made.booking.calendarEventId } },
    }),
  );
  const outcome = await quiet(() =>
    calendly.applyCalendlyWebhook(getLocation(loc.id)!, {
      event: "invitee.created",
      payload: {
        rescheduled: true,
        old_invitee: made.booking.calendlyInvitee,
        scheduled_event: { uri: "https://api.calendly.com/scheduled_events/NEWONE", start_time: "2026-10-01T09:00:00.000000Z" },
      },
    }),
  );
  assert.equal(outcome.applied, "rescheduled_elsewhere");
  const after = getBooking(made.booking.id)!;
  assert.equal(after.status, "cancelled", "Belline claimed to have followed a move it cannot follow");
  assert.match(after.notes!, /Moved in Calendly to 2026-10-01T09:00:00.000000Z/);
  assert.match(after.notes!, /Belline's record was cancelled/);
});

await test("a Calendly that will not take a webhook is said plainly, not hidden", async () => {
  const noHooks = freshApi();
  noHooks.failNext("createWebhook", 10);
  calendly.setCalendlyApi(noHooks.api);
  try {
    const loc = upsertLocation(await quiet(() => calendly.completeCalendlyConnection(salonBase, "stub-code", REDIRECT, "user_owner")));
    assert.ok(loc.calendly!.webhookFailedAt, "a failed subscription was not recorded");
    assert.equal(loc.calendly!.webhook, undefined);
    const texts = calendly.calendlyLimits({ ...loc, calendly: { ...loc.calendly!, serviceEventTypes: Object.fromEntries(services.map((s) => [s.id, TYPE_A])) } })
      .limits.map((l) => l.text)
      .join(" ");
    assert.match(texts, /will not reach Belline on its own/);
    // And it never stops Belline booking: availability still comes live from Calendly.
    assert.match(texts, /still come live from Calendly, so it will not double-book/);
  } finally {
    calendly.setCalendlyApi(fake.api);
  }
});

// ---------------------------------------------------------------------------
head("A Calendly Belline cannot use takes requests, tells the owner and tells the team");

await test("a token Calendly stops accepting marks the venue, raises for the team, and falls back to requests", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  assert.equal(providerFor(loc).name, "calendly");
  fake.expire();
  await quiet(async () => {
    await assert.rejects(() => calendly.withCalendlyAccess(getLocation(loc.id)!, async (t, api, link) => api.listEventTypes(t, link.owner)));
  });
  const after = getLocation(loc.id)!;
  assert.ok(after.calendly!.expiredAt);
  assert.match(after.calendly!.lastError!, /stopped letting Belline in/);
  assert.equal(calendlyUsable(after), false);
  assert.ok(takesRequestsOnly(after));
  assert.equal(providerFor(after), requestOnlyProvider);
  assert.ok(listExceptions({ locationId: loc.id }).some((e) => e.kind === "calendly_token_expired"));
  fake.restore();
});

await test("Belline books into one place per venue: the routes refuse a second connection", () => {
  for (const [file, guard] of [
    ["src/app/api/integrations/google/route.ts", /location\.outlook \|\| location\.calendly/],
    ["src/app/api/integrations/microsoft/route.ts", /location\.google \|\| location\.calendly/],
    ["src/app/api/integrations/calendly/route.ts", /location\.google \|\| location\.outlook/],
  ] as const) {
    assert.match(source(file), guard, file);
  }
  assert.match(integrationErrorText("calendly_in_use")!, /one place per venue/);
});

await test("disconnecting withdraws the access at Calendly and removes the webhook", async () => {
  fake = freshApi();
  const loc = await connect(salonBase);
  const token = openCredentials(getLocation(loc.id)!.calendly!.sealedToken!).refreshToken;
  const hook = loc.calendly!.webhook!.uri;
  const after = await quiet(() => calendly.disconnectCalendly(getLocation(loc.id)!));
  upsertLocation(after);
  assert.equal(after.calendly, undefined);
  assert.equal(after.onboarding?.destination?.kind, "requests", "the venue went on booking into a Calendly it no longer holds");
  assert.ok(!fake.webhooks().some((w) => w.uri === hook), "Belline's webhook is still on the owner's Calendly");
  assert.ok(!fake.accepts(token), "Belline's access was only forgotten, not withdrawn");
  assert.match(calendly.CALENDLY_DISCONNECTED_TEXT, /withdrawn at Calendly/);
});

// ---------------------------------------------------------------------------
head("The flag, and what the product says while it is off");

const OFF = {} as Record<string, string>;
const ON = { CALENDLY_CLIENT_ID: "id", CALENDLY_CLIENT_SECRET: "secret", CREDENTIALS_KEY: "key", FLAG_BOOKING_CALENDLY: "on" } as Record<string, string>;

await test("the flag needs the Calendly credentials, the sealing key, and somebody switching it on", async () => {
  const { flagState } = await import("../src/lib/flags");
  assert.deepEqual(flagState("booking.calendly", OFF).missing, ["CALENDLY_CLIENT_ID", "CALENDLY_CLIENT_SECRET", "CREDENTIALS_KEY"]);
  assert.equal(flagState("booking.calendly", OFF).reason, "missing_credentials");
  const credentialsOnly = { CALENDLY_CLIENT_ID: "id", CALENDLY_CLIENT_SECRET: "secret", CREDENTIALS_KEY: "key" };
  assert.equal(flagState("booking.calendly", credentialsOnly).on, false);
  assert.equal(flagState("booking.calendly", credentialsOnly).reason, "needs_approval");
  assert.equal(flagState("booking.calendly", ON).on, true);
  assert.equal(flagState("booking.calendly", { ...ON, FLAG_BOOKING_CALENDLY: "off" }).on, false);
});

await test("the flag itself is never switched on in code", () => {
  assert.match(source("src/lib/flags.ts"), /"booking\.calendly": \{ needs: \["CALENDLY_CLIENT_ID", "CALENDLY_CLIENT_SECRET", "CREDENTIALS_KEY"\], explicit: true \}/);
  for (const file of ["Dockerfile", "server.ts", "src/lib/site-flags.ts", "src/lib/marketing.ts", "src/lib/seed-belline.ts"]) {
    assert.doesNotMatch(source(file), /FLAG_BOOKING_CALENDLY\s*[=:]\s*["']?on/, file);
  }
});

await test("with the flag off nothing can be connected and no venue books into Calendly", async () => {
  const { flag } = await import("../src/lib/flags");
  assert.equal(flag("booking.calendly", OFF), false);
  const loc = await connect(salonBase);
  assert.equal(calendlyUsable(loc, OFF), false);
});

await test("the website's integrations strip follows the flag, and says Coming soon until it is on", async () => {
  const { INTEGRATIONS: STRIP, integrationState, renderIntegrations } = await import("./site-integrations");
  const entry = STRIP.find((i) => i.name === "Calendly")!;
  assert.equal(entry.flag, "booking.calendly");
  assert.equal(entry.pending, "soon");
  assert.equal(integrationState(entry, {}), "soon");
  assert.equal(integrationState(entry, ON), "available");
  assert.match(renderIntegrations({}), /data-integration="booking\.calendly" data-state="soon"/);
  assert.match(renderIntegrations(ON), /data-integration="booking\.calendly" data-state="available"/);
  // And it is no longer listed as a partner-gated system, because it is not one.
  assert.ok(!STRIP.some((i) => i.flag === "booking.partner.calendly"));
  for (const page of ["public/landing.html", "public/landing.de.html"]) {
    assert.match(source(page), /data-integration="booking\.calendly" data-state="soon"/, page);
    assert.doesNotMatch(source(page), /booking\.partner\.calendly/, page);
  }
});

await test("the app says 'coming soon' about Calendly only behind the flag, never as fixed copy", () => {
  for (const file of ["src/app/setup/[step]/page.tsx", "src/app/(app)/calendars/page.tsx"]) {
    const text = source(file);
    for (const m of text.matchAll(/Calendly[^"\n]{0,80}(?:coming soon|isn.t available|not available|isn.t connected yet)/gi)) {
      const before = text.slice(Math.max(0, m.index! - 900), m.index);
      assert.match(before, /flag\("booking\.calendly"\)|calendlyOn/, `${file}: "${m[0]}" is not behind the flag`);
    }
  }
  assert.match(source("src/app/(app)/calendars/page.tsx"), /const calendlyOn = flag\("booking\.calendly"\);/);
  assert.match(source("src/app/(app)/calendars/page.tsx"), /\{calendlyOn \? \(/);
});

await test("Belle says the same as the website, by the same flag", async () => {
  const belle = await import("../src/lib/seed-belline");
  assert.match(belle.bookingSystemAnswer(OFF), /Calendly/);
  assert.match(belle.bookingSystemAnswer(OFF), /coming soon/);
  assert.doesNotMatch(belle.bookingSystemAnswer(ON), /soon|not yet/i);
  assert.match(belle.bookingSystemAnswer(ON), /booking page rather than a diary/);
  assert.match(belle.bookingSystemAnswer(ON), /needs the customer's email address/);
  assert.match(belle.routeLine(ON), /Calendly: once they connect it/);
  assert.doesNotMatch(belle.routeLine(ON), /coming soon/i);
});

await test("the pricing catalogue names Calendly only once its flag is on", async () => {
  const { calendarConnectionText, calendarConnectionTextDe } = await import("../src/lib/site-flags");
  assert.equal(calendarConnectionText({ google: false, outlook: false, calendly: true }), "One Calendly connection");
  assert.equal(
    calendarConnectionText({ google: true, outlook: true, calendly: true }),
    "One Google Calendar, Microsoft Outlook or Calendly connection",
  );
  assert.equal(calendarConnectionTextDe({ google: false, outlook: false, calendly: true }), "Eine Verbindung zu Calendly");
  assert.doesNotMatch(calendarConnectionText({ google: true, outlook: true, calendly: false }), /Calendly/);
  // Every shape has its German, or the German pages would ship an English line.
  const { catalogueDe } = await import("../src/lib/billing/speak-de");
  for (const google of [true, false]) {
    for (const outlook of [true, false]) {
      for (const calendly of [true, false]) {
        if (!google && !outlook && !calendly) continue;
        assert.doesNotThrow(() => catalogueDe(calendarConnectionText({ google, outlook, calendly })));
      }
    }
  }
});

await test("the team's exceptions name Calendly's failures and what to do about each", async () => {
  const { EXCEPTION_KINDS, KIND_META } = await import("../src/lib/exceptions");
  for (const kind of [
    "calendly_token_expired",
    "calendly_misconfigured",
    "calendly_connect_abandoned",
    "calendly_plan_blocked",
    "calendly_rate_limited",
    "calendly_booking_failed",
    "calendly_cancel_failed",
  ] as const) {
    assert.ok(EXCEPTION_KINDS.includes(kind), `${kind} is not a known exception`);
    const meta = KIND_META[kind];
    assert.ok(meta.label.length > 0 && meta.next.length > 20, `${kind} has no instruction for whoever picks it up`);
  }
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
