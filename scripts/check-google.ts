/**
 * Google Calendar, two-way (P1-1), against a fake Google.
 *
 * Busy times in the calendar take slots away and never add one; the same
 * booking twice is one event; a decline goes back to requests with no loop;
 * the OAuth state is signed and single use; the refresh token is sealed and
 * never sits in the location file; and a token Google stops accepting puts
 * the venue on requests, tells the team and tells the owner.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches
 * Google.
 *
 *   npm run check:google
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-google-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.FLAG_STUBS = "on";
process.env.FLAG_BOOKING_GOOGLE = "on";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { installFetchGuard, blockedFetches, fakeGoogleApi } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listBookings, listLocations, upsertLocation } = await import("../src/lib/store");
const google = await import("../src/lib/integrations/google");
const { GOOGLE_SCOPES, zonedInstant } = await import("../src/lib/integrations/google-api");
const { googleCalendarProvider } = await import("../src/lib/booking/google-provider");
const { localProvider, providerFor, requestOnlyProvider } = await import("../src/lib/booking/provider");
const { googleUsable, takesRequestsOnly } = await import("../src/lib/booking/destination");
const { openCredentials } = await import("../src/lib/db/credentials");
const { NO_FACTS, recordStep } = await import("../src/lib/onboarding/journey");
const { integrationErrorText, resetCustomerErrors } = await import("../src/lib/errors/customer");
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

/** Capture console.error lines while `fn` runs. */
async function errorsDuring(fn: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  const warn = console.warn;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.warn = () => {};
  try {
    await fn();
  } finally {
    console.error = original;
    console.warn = warn;
  }
  return lines;
}

seedIfEmpty();
const now = new Date("2026-09-15T10:00:00.000Z");
const at = now.toISOString();
const venues = listLocations();
const salonBase = venues.find((l) => l.vertical === "salon" && !l.internal && (l.salon?.staff.length ?? 0) >= 2)!;
const restaurantBase = venues.find((l) => l.vertical === "restaurant" && !l.internal)!;

const fake = fakeGoogleApi({
  calendars: [
    { id: "primary", name: "Main calendar", primary: true },
    { id: "staff-a@group.calendar.google.com", name: "First stylist", primary: false },
  ],
});
google.setGoogleApi(fake.api);

/** Connect through the real code path, and optionally choose Google as the destination. */
async function connect(base: Loc, destination = true): Promise<Loc> {
  let loc = await google.completeConnection(base, "stub-code", "http://localhost:3000/api/integrations/google", "user_owner", now);
  if (destination) {
    loc = { ...loc, onboarding: { version: 1, channels: {}, ...base.onboarding, destination: { kind: "google", setAt: at } } };
  }
  return upsertLocation(loc);
}

const iso = (l: Loc, date: string, min: number) => new Date(zonedInstant(date, min, l.timezone)).toISOString();

// ---------------------------------------------------------------------------
head("OAuth: exact scopes, signed single-use state, no loop on a decline");

await test("the scopes are exactly calendar.events and calendarlist.readonly", () => {
  assert.deepEqual([...GOOGLE_SCOPES], [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  ]);
});

await test("the auth URL asks for offline access with those scopes, and the state is not the bare venue id", () => {
  const { state } = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const url = new URL(google.authUrl(state, "http://localhost:3000/api/integrations/google"));
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("scope"), GOOGLE_SCOPES.join(" "));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.notEqual(url.searchParams.get("state"), salonBase.id);
  assert.ok(!url.searchParams.get("state")!.includes(salonBase.id));
});

await test("a state verifies once, for the same user and browser, and never twice", () => {
  const { state, nonce } = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "integrations" });
  const first = google.verifyState(state, { userId: "user_owner", cookieNonce: nonce });
  assert.deepEqual(first, { ok: true, locationId: salonBase.id, returnTo: "integrations" });
  const again = google.verifyState(state, { userId: "user_owner", cookieNonce: nonce });
  assert.ok(!again.ok && again.reason === "used");
});

await test("a forged, expired, other user's or cookieless state is refused", () => {
  const a = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const [body, sig] = a.state.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), l: "loc_someone_else" })).toString("base64url");
  const forged = google.verifyState(`${forgedBody}.${sig}`, { userId: "user_owner", cookieNonce: a.nonce });
  assert.ok(!forged.ok && forged.reason === "signature");

  const b = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" }, Date.now() - 11 * 60_000);
  const expired = google.verifyState(b.state, { userId: "user_owner", cookieNonce: b.nonce });
  assert.ok(!expired.ok && expired.reason === "expired");

  const c = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const other = google.verifyState(c.state, { userId: "user_attacker", cookieNonce: c.nonce });
  assert.ok(!other.ok && other.reason === "user");

  const d = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const noCookie = google.verifyState(d.state, { userId: "user_owner" });
  assert.ok(!noCookie.ok && noCookie.reason === "cookie");
  assert.ok(!google.verifyState("locationid-only", { userId: "user_owner" }).ok);
});

await test("a decline lands on the bookings step with 'No problem — requests for now', never on Google", () => {
  const setup = google.returnPath("setup", salonBase.id, "declined");
  assert.equal(setup, "/setup/bookings?google=declined");
  assert.equal(google.returnPath("integrations", salonBase.id, "declined"), `/integrations?loc=${salonBase.id}&error=google_declined`);
  assert.match(integrationErrorText("google_declined")!, /^No problem — requests for now\./);
  const page = source("src/app/setup/[step]/page.tsx");
  assert.match(page, /code === "declined"\) return integrationErrorText\("google_declined"\)/);
  const route = source("src/app/api/integrations/google/route.ts");
  assert.match(route, /oauthError === "access_denied"\) return land\(request, checked\.returnTo, location\.id, "declined"\)/);
  // The callback branch never builds a Google URL: authUrl is called once, in the start branch.
  assert.equal(route.match(/authUrl\(/g)?.length, 1);
  assert.ok(route.indexOf("authUrl(") < route.indexOf("verifyState("));
});

await test("the route verifies the signed state before trusting a venue, and the flag gates the start", () => {
  const route = source("src/app/api/integrations/google/route.ts");
  assert.match(route, /verifyState\(state, \{ userId: auth\.user\.id, cookieNonce/);
  assert.match(route, /getLocation\(checked\.locationId\)/);
  assert.doesNotMatch(route, /searchParams\.get\("state"\) \?\?/);
  assert.match(route, /!flag\("booking\.google"\) \|\| !credentialsConfigured\(\)/);
  assert.doesNotMatch(route, /refreshToken/);
});

await test("under stubs with nothing injected, the auth URL comes straight back here, never to Google", () => {
  google.setGoogleApi(null);
  try {
    const url = new URL(google.authUrl("s.t", "http://localhost:3000/api/integrations/google"));
    assert.equal(url.hostname, "localhost");
    assert.equal(url.searchParams.get("code"), "stub-code");
  } finally {
    google.setGoogleApi(fake.api);
  }
});

// ---------------------------------------------------------------------------
head("The token is sealed, never plain");

await test("connecting stores a sealed token that opens, and no plain token anywhere in the data", async () => {
  const loc = await connect(salonBase, false);
  const link = loc.google!;
  assert.ok(link.sealedToken?.startsWith("v1."));
  assert.equal(link.refreshToken, undefined);
  const plain = openCredentials(link.sealedToken!).refreshToken;
  assert.match(plain, /^stub-refresh-/);
  assert.ok(!JSON.stringify(getLocation(loc.id)).includes(plain), "token in the location JSON");
  assert.ok(!dataOnDisk().includes(plain), "token in DATA_DIR");
  assert.equal(link.scope, GOOGLE_SCOPES.join(" "));
});

await test("a plain token from before is sealed on boot, or dropped and marked when there is no key", async () => {
  const legacy = upsertLocation({
    ...restaurantBase,
    google: { calendarId: "primary", refreshToken: "plain-legacy-token-123", connectedAt: at, connectedBy: "user_owner" },
  });
  assert.equal(google.sealLegacyGoogleTokens(), 1);
  const sealed = getLocation(legacy.id)!.google!;
  assert.equal(openCredentials(sealed.sealedToken!).refreshToken, "plain-legacy-token-123");
  assert.ok(!dataOnDisk().includes("plain-legacy-token-123"));
  assert.equal(google.sealLegacyGoogleTokens(), 0, "second boot changes nothing");

  upsertLocation({ ...legacy, google: { calendarId: "primary", refreshToken: "plain-no-key-456", connectedAt: at, connectedBy: "u" } });
  const key = process.env.CREDENTIALS_KEY;
  delete process.env.CREDENTIALS_KEY;
  try {
    const lines = await errorsDuring(() => google.sealLegacyGoogleTokens());
    const dropped = getLocation(legacy.id)!.google!;
    assert.equal(dropped.refreshToken, undefined);
    assert.ok(dropped.expiredAt);
    assert.ok(!dataOnDisk().includes("plain-no-key-456"));
    assert.ok(lines.some((l) => l.startsWith(`[exception] google:unsealed:${legacy.id}`)));
  } finally {
    process.env.CREDENTIALS_KEY = key;
    upsertLocation(restaurantBase);
  }
});

// ---------------------------------------------------------------------------
head("Availability is Belline's rules, less what the calendar says is busy");

const { findAvailability } = await import("../src/lib/booking");
const usedDays = new Set<string>();
/** A day, not used by another test yet, when the salon's first service has at least three times. */
function openDay(l: Loc): string {
  for (let i = 3; i < 60; i++) {
    const date = addDays(todayIn(l.timezone), i);
    if (usedDays.has(date)) continue;
    if (findAvailability(l, { locationId: l.id, date, serviceIds: [l.salon!.services[0].id] }, { limit: 200 }).length >= 3) {
      usedDays.add(date);
      return date;
    }
  }
  throw new Error("the fixture salon has no open day in the next two months");
}
const day = openDay(salonBase);

await test("with the flag on and a connection, a Google destination gets the Google provider and diary tools", async () => {
  const loc = await connect(salonBase);
  assert.equal(providerFor(loc), googleCalendarProvider);
  assert.equal(takesRequestsOnly(loc), false);
  assert.equal(googleUsable(loc, {}), false, "flag off in an empty env");
  assert.equal(takesRequestsOnly({ ...loc, google: undefined }), true);
});

await test("a busy block in the calendar removes that slot, and only overlapping slots", async () => {
  const loc = getLocation(salonBase.id)!;
  const service = loc.salon!.services[0];
  const query = { locationId: loc.id, date: day, serviceIds: [service.id] };
  const rules = findAvailability(loc, query, { limit: 200 });
  assert.ok(rules.length > 2, `the fixture salon has ${rules.length} slots on ${day}`);
  const target = rules[0];
  fake.calendar.addBusy("primary", iso(loc, day, target.startMin), iso(loc, day, target.endMin));
  const offered = await googleCalendarProvider.checkAvailability({ location: loc }, query);
  assert.ok(!offered.some((s) => s.startMin < target.endMin && s.endMin > target.startMin), "an overlapping slot is still offered");
  assert.ok(offered.length > 0, "a busy block took every time away");
  // The calendar can only take times away.
  for (const slot of offered) assert.ok(rules.some((r) => r.startMin === slot.startMin && r.staffId === slot.staffId));
});

await test("an event marked 'free' in Google does not block", async () => {
  const loc = getLocation(salonBase.id)!;
  const query = { locationId: loc.id, date: openDay(loc), serviceIds: [loc.salon!.services[0].id] };
  const before = await googleCalendarProvider.checkAvailability({ location: loc }, query);
  const slot = before[0];
  await fake.calendar.upsertEvent("primary", {
    id: "freeevent1",
    start: iso(loc, query.date, slot.startMin),
    end: iso(loc, query.date, slot.endMin),
    transparent: true,
  });
  const after = await googleCalendarProvider.checkAvailability({ location: loc }, query);
  assert.equal(after.length, before.length);
});

await test("a person's own calendar blocks only them", async () => {
  const [first, second] = salonBase.salon!.staff;
  const picked = await google.chooseCalendars(getLocation(salonBase.id)!, {
    calendarId: "primary",
    staffCalendars: { [first.id]: "staff-a@group.calendar.google.com" },
  });
  assert.ok(picked.ok);
  if (!picked.ok) return;
  const loc = upsertLocation(picked.location);
  assert.equal(loc.google!.calendarName, "Main calendar");
  // The engine offers one person per time when nobody is asked for, so ask for
  // each, on a day both of them work (the fixture has rota days off).
  const serviceIds = [loc.salon!.services[0].id];
  let date = "";
  for (let i = 3; i < 60 && !date; i++) {
    const d = addDays(todayIn(loc.timezone), i);
    if (usedDays.has(d)) continue;
    const both = [first.id, second.id].every(
      (staffId) => findAvailability(loc, { locationId: loc.id, date: d, serviceIds, staffId }, { limit: 200 }).length > 0,
    );
    if (both) {
      usedDays.add(d);
      date = d;
    }
  }
  assert.ok(date, "no day in the next two months when both people work");
  const forPerson = (staffId: string) =>
    googleCalendarProvider.checkAvailability({ location: getLocation(loc.id)! }, { locationId: loc.id, date, serviceIds, staffId });
  const firstBefore = await forPerson(first.id);
  const secondBefore = await forPerson(second.id);
  const shared = firstBefore.find((s) => secondBefore.some((o) => o.startMin === s.startMin));
  assert.ok(shared, "no time where both people are free in the fixture");
  fake.calendar.addBusy("staff-a@group.calendar.google.com", iso(loc, date, shared!.startMin), iso(loc, date, shared!.endMin));
  const firstAfter = await forPerson(first.id);
  const secondAfter = await forPerson(second.id);
  assert.ok(!firstAfter.some((s) => s.startMin === shared!.startMin), "the busy person is still offered");
  assert.ok(secondAfter.some((s) => s.startMin === shared!.startMin), "the other person lost the time too");
});

await test("the picker refuses a calendar the account cannot write to, or a stranger", async () => {
  const loc = getLocation(salonBase.id)!;
  const bad = await google.chooseCalendars(loc, { calendarId: "someone-elses@group.calendar.google.com" });
  assert.ok(!bad.ok && /not one your Google account/.test(bad.error));
  const stranger = await google.chooseCalendars(loc, { calendarId: "primary", staffCalendars: { staff_nobody: "primary" } });
  assert.ok(!stranger.ok);
});

// ---------------------------------------------------------------------------
head("Create and cancel, with idempotency keys and stored event ids");

await test("the same key twice gives one event and one booking, the second read back as a duplicate", async () => {
  const loc = getLocation(salonBase.id)!;
  const date = openDay(loc);
  const query = { locationId: loc.id, date, serviceIds: [loc.salon!.services[0].id] };
  const [slot] = await googleCalendarProvider.checkAvailability({ location: loc }, query);
  const input = { date, startMin: slot.startMin, guestName: "Layla Haddad", guestPhone: "+971501234567", serviceIds: query.serviceIds, staffId: slot.staffId };
  const beforeEvents = fake.calendar.events("primary").length + fake.calendar.events("staff-a@group.calendar.google.com").length;
  const one = await googleCalendarProvider.createBooking({ location: loc }, input, "call_42:book:1");
  assert.ok(one.ok, one.ok ? "" : one.detail);
  if (!one.ok) return;
  const two = await googleCalendarProvider.createBooking({ location: getLocation(loc.id)! }, input, "call_42:book:1");
  assert.ok(two.ok && two.duplicate && two.booking.id === one.booking.id);
  const afterEvents = fake.calendar.events("primary").length + fake.calendar.events("staff-a@group.calendar.google.com").length;
  assert.equal(afterEvents - beforeEvents, 1);
  assert.equal(one.booking.calendarEventId, google.eventIdFor(loc.id, "call_42:book:1"));
  assert.match(one.booking.calendarEventId!, /^[a-v0-9]{5,1024}$/, "not a valid Google event id");
  assert.equal(getLocation(loc.id)!.google!.lastError, undefined);
});

await test("a time taken in the calendar is refused before anything is written", async () => {
  const loc = getLocation(salonBase.id)!;
  const date = openDay(loc);
  const query = { locationId: loc.id, date, serviceIds: [loc.salon!.services[0].id] };
  const [slot] = await googleCalendarProvider.checkAvailability({ location: loc }, query);
  fake.calendar.addBusy("primary", iso(loc, date, slot.startMin), iso(loc, date, slot.endMin));
  const inserts = fake.calls.filter((c) => c.method === "insertEvent").length;
  const out = await googleCalendarProvider.createBooking(
    { location: loc },
    { date, startMin: slot.startMin, guestName: "Omar Saleh", guestPhone: "+971509876543", serviceIds: query.serviceIds, staffId: slot.staffId },
    "call_43:book:1",
  );
  assert.ok(!out.ok && out.reason === "unavailable");
  assert.equal(fake.calls.filter((c) => c.method === "insertEvent").length, inserts);
  assert.ok(!listBookings({ locationId: loc.id, status: "confirmed" }).some((b) => b.guestName === "Omar Saleh"));
});

await test("cancelling removes the event by its stored id and cancels the booking", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "Layla Haddad")!;
  const out = await googleCalendarProvider.cancelBooking({ location: loc }, booking, "Guest asked");
  assert.ok(out.ok);
  const event = fake.calendar.events(booking.calendarId!).find((e) => e.id === booking.calendarEventId);
  assert.equal(event?.status, "cancelled");
  if (out.ok) assert.equal(out.booking.status, "cancelled");
});

await test("Belline's own events do not block the next table at the same time", async () => {
  const loc = await connect(restaurantBase);
  const date = addDays(todayIn(loc.timezone), 6);
  const query = { locationId: loc.id, date, partySize: 2 };
  const [slot] = await googleCalendarProvider.checkAvailability({ location: loc }, query);
  assert.ok(slot, "the fixture restaurant has no slot");
  const made = await googleCalendarProvider.createBooking(
    { location: loc },
    { date, startMin: slot.startMin, guestName: "Sara Khan", guestPhone: "+971501112233", partySize: 2 },
    "call_44:book:1",
  );
  assert.ok(made.ok, made.ok ? "" : made.detail);
  const again = await googleCalendarProvider.checkAvailability({ location: getLocation(loc.id)! }, query);
  const local = await localProvider.checkAvailability({ location: getLocation(loc.id)! }, query);
  assert.equal(again.length, local.length, "Belline's own event was counted as busy");
});

// ---------------------------------------------------------------------------
head("Bookings made anywhere else reach the calendar: the desk, a guest's link, the sweep");

const { createFromDesk, updateFromDesk } = await import("../src/lib/booking/desk");
const { cancelBooking: cancelLocal, createBooking: createLocal, modifyBooking: modifyLocal } = await import("../src/lib/booking");
const { getBooking } = await import("../src/lib/store");
// The sync module is new with these tests. Against the code before it, the
// module is absent and the helpers below fall back to letting fire-and-forget
// writes land, so the old behaviour fails on its assertions rather than on an import.
const sync = (await import("../src/lib/integrations/google-sync").catch(() => null)) as null | typeof import("../src/lib/integrations/google-sync");
const settle = async () => {
  if (sync) await sync.settleGoogleSync();
  else await new Promise((r) => setTimeout(r, 50));
};
const CALENDARS = ["primary", "staff-a@group.calendar.google.com"];
/** Every live event in the fake Google that belongs to this booking, and where. */
const liveEventsOf = (bookingId: string) =>
  CALENDARS.flatMap((calendarId) =>
    fake.calendar
      .events(calendarId)
      .filter((e) => e.bellineBookingId === bookingId && e.status !== "cancelled")
      .map((e) => ({ calendarId, ...e })),
  );

/** A day, not used yet, when both of the salon's first two people can take the first service at the same time. */
function sharedSlot(l: Loc): { date: string; startMin: number } {
  const [first, second] = l.salon!.staff;
  const serviceIds = [l.salon!.services[0].id];
  for (let i = 3; i < 90; i++) {
    const date = addDays(todayIn(l.timezone), i);
    if (usedDays.has(date)) continue;
    const a = findAvailability(l, { locationId: l.id, date, serviceIds, staffId: first.id }, { limit: 200 });
    const b = findAvailability(l, { locationId: l.id, date, serviceIds, staffId: second.id }, { limit: 200 });
    const both = a.find((s) => b.some((o) => o.startMin === s.startMin));
    if (both) {
      usedDays.add(date);
      return { date, startMin: both.startMin };
    }
  }
  throw new Error("no time in the next three months when both people are free");
}

await test("a booking taken at the desk at a Google venue becomes an event, with the id stored, and blocks the time", async () => {
  const loc = getLocation(salonBase.id)!;
  assert.equal(providerFor(loc), googleCalendarProvider, "the salon should be booking into Google here");
  const [, second] = loc.salon!.staff;
  const { date, startMin } = sharedSlot(loc);
  const out = createFromDesk(loc, { date, startMin, serviceIds: [loc.salon!.services[0].id], staffId: second.id, guestName: "Desk Guest One", guestPhone: "+971500000101" });
  assert.ok(out.ok, out.ok ? "" : out.error);
  if (!out.ok) return;
  await settle();
  const saved = getBooking(out.booking.id)!;
  const events = liveEventsOf(saved.id);
  assert.equal(events.length, 1, `expected one event in Google for the desk booking, found ${events.length}`);
  assert.equal(events[0].calendarId, "primary", "the event is not on the calendar for that person");
  assert.equal(saved.calendarEventId, events[0].id, "the event id is not stored on the booking");
  assert.equal(saved.calendarId, "primary");
  assert.equal(Date.parse(events[0].start), zonedInstant(date, startMin, loc.timezone));
  // The agent is never offered what a person at the desk has just taken.
  const offered = await googleCalendarProvider.checkAvailability(
    { location: getLocation(loc.id)! },
    { locationId: loc.id, date, serviceIds: [loc.salon!.services[0].id], staffId: second.id },
  );
  assert.ok(!offered.some((s) => s.startMin === startMin), "the agent is still offered the desk booking's time");
});

await test("moving it at the desk moves that event, by its id, and never makes a second", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "Desk Guest One")!;
  const later = findAvailability(loc, { locationId: loc.id, date: booking.date, serviceIds: booking.serviceIds, staffId: booking.staffId, excludeBookingId: booking.id }, { limit: 200 })
    .find((s) => s.startMin > booking.startMin + 60);
  assert.ok(later, "no later time that day to move to");
  const out = updateFromDesk(loc, booking, { startMin: later!.startMin });
  assert.ok(out.ok, out.ok ? "" : out.error);
  await settle();
  const events = liveEventsOf(booking.id);
  assert.equal(events.length, 1, `a move left ${events.length} events`);
  assert.equal(events[0].id, getBooking(booking.id)!.calendarEventId);
  assert.equal(Date.parse(events[0].start), zonedInstant(booking.date, later!.startMin, loc.timezone), "the event did not move");
});

await test("renaming the guest at the desk updates the event text", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "Desk Guest One")!;
  const out = updateFromDesk(loc, booking, { guestName: "Desk Guest Renamed" });
  assert.ok(out.ok);
  await settle();
  const events = liveEventsOf(booking.id);
  assert.equal(events.length, 1);
  assert.match(events[0].summary ?? "", /^Desk Guest Renamed/);
});

await test("cancelling at the desk cancels the event", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "Desk Guest Renamed")!;
  cancelLocal(booking, loc, "Cancelled at the desk");
  await settle();
  assert.deepEqual(liveEventsOf(booking.id), [], "the cancelled desk booking is still an event in Google");
});

await test("a guest moving and then cancelling from their link: one event that follows, then none", async () => {
  const loc = getLocation(salonBase.id)!;
  const { date, startMin } = sharedSlot(loc);
  const serviceIds = [loc.salon!.services[0].id];
  // The quick-book route and the manage link call exactly these.
  const made = createLocal(loc, { date, startMin, serviceIds, guestName: "Link Guest", guestPhone: "+971500000102", source: "manual", staffOverride: true });
  assert.ok(made.ok, made.ok ? "" : made.detail);
  if (!made.ok) return;
  await settle();
  assert.equal(liveEventsOf(made.booking.id).length, 1, "the booking never reached Google");
  const next = findAvailability(loc, { locationId: loc.id, date, serviceIds, staffId: made.booking.staffId, excludeBookingId: made.booking.id }, { limit: 200 })
    .find((s) => s.startMin !== made.booking.startMin && s.staffId === made.booking.staffId);
  assert.ok(next, "nowhere to move the guest to");
  const moved = modifyLocal(getLocation(loc.id)!, getBooking(made.booking.id)!, { date, startMin: next!.startMin });
  assert.ok(moved.ok, moved.ok ? "" : moved.detail);
  await settle();
  const events = liveEventsOf(made.booking.id);
  assert.equal(events.length, 1);
  assert.equal(Date.parse(events[0].start), zonedInstant(date, next!.startMin, loc.timezone));
  cancelLocal(getBooking(made.booking.id)!, getLocation(loc.id)!, "Cancelled by the guest from their confirmation link");
  await settle();
  assert.deepEqual(liveEventsOf(made.booking.id), []);
});

await test("the agent's own booking is written once: the desk path never adds a second event for it", async () => {
  const loc = getLocation(salonBase.id)!;
  const { date, startMin } = sharedSlot(loc);
  const serviceIds = [loc.salon!.services[0].id];
  const [, second] = loc.salon!.staff;
  const made = await googleCalendarProvider.createBooking({ location: loc }, { date, startMin, guestName: "Agent Guest", guestPhone: "+971500000103", serviceIds, staffId: second.id }, "call_60:book:1");
  assert.ok(made.ok, made.ok ? "" : made.detail);
  if (!made.ok) return;
  await settle();
  assert.equal(liveEventsOf(made.booking.id).length, 1);
  // The same guest, the same time, typed in at the desk: the same booking.
  const desk = createFromDesk(getLocation(loc.id)!, { date, startMin, serviceIds, staffId: second.id, guestName: "Agent Guest", guestPhone: "+971500000103" });
  assert.ok(desk.ok && desk.duplicate);
  await settle();
  assert.equal(liveEventsOf(made.booking.id).length, 1);
});

await test("Google failing does not lose the booking: recorded, the owner told, retried, and raised for the team", async () => {
  assert.ok(sync, "no sync module");
  resetCustomerErrors();
  const { listExceptions } = await import("../src/lib/exceptions");
  const loc = getLocation(salonBase.id)!;
  const { date, startMin } = sharedSlot(loc);
  const [, second] = loc.salon!.staff;
  fake.failNext("putEvent", 2);
  let bookingId = "";
  await errorsDuring(async () => {
    const out = createFromDesk(loc, { date, startMin, serviceIds: [loc.salon!.services[0].id], staffId: second.id, guestName: "Retry Guest", guestPhone: "+971500000104" });
    assert.ok(out.ok, out.ok ? "" : out.error);
    if (out.ok) bookingId = out.booking.id;
    await settle();
  });
  let saved = getBooking(bookingId)!;
  assert.equal(saved.status, "confirmed", "the booking was lost with the calendar write");
  assert.equal(saved.calendarSync?.state, "failed");
  assert.equal(saved.calendarSync?.attempts, 1);
  assert.equal(liveEventsOf(bookingId).length, 0);
  const state = google.connectionState(getLocation(loc.id)!);
  assert.ok(!state.healthy && /did not accept/.test(state.detail), `the owner is not told: ${state.detail}`);
  assert.equal(listExceptions({ locationId: loc.id, kind: "google_sync_failed" }).length, 0, "one blip is not yet the team's problem");

  // Not before its time.
  const early = await sync!.retryGoogleSyncs(new Date());
  assert.equal(early.attempted, 0, "retried before the back-off");
  await errorsDuring(() => sync!.retryGoogleSyncs(new Date(Date.now() + 2 * 60_000)));
  saved = getBooking(bookingId)!;
  assert.equal(saved.calendarSync?.attempts, 2);
  const raised = listExceptions({ locationId: loc.id, kind: "google_sync_failed" });
  assert.equal(raised.length, 1, "a second failure should be in the team's queue");

  const later = await sync!.retryGoogleSyncs(new Date(Date.now() + 60 * 60_000));
  assert.equal(later.synced, 1);
  saved = getBooking(bookingId)!;
  assert.equal(saved.calendarSync?.state, "synced");
  assert.equal(liveEventsOf(bookingId).length, 1, "the retry did not write the event");
  assert.ok(google.connectionState(getLocation(loc.id)!).healthy, "the owner's warning outlived the fix");
});

// ---------------------------------------------------------------------------
head("Choosing Google on the bookings step");

await test("Google can be chosen with a working connection, is refused unconnected (with the way to connect), and not at all with the flag off", async () => {
  const fresh = { ...salonBase, google: undefined, onboarding: { version: 1 as const, channels: {}, reviewedAt: at } };
  const unconnected = recordStep(fresh, { kind: "destination", destination: "google" }, NO_FACTS, now);
  assert.ok(!unconnected.ok && unconnected.status === 409 && /Connect Google Calendar first/.test(unconnected.error));
  if (!unconnected.ok) assert.match(unconnected.fix!, /^\/api\/integrations\/google\?locationId=.*&from=setup$/);

  const connected = { ...getLocation(salonBase.id)!, onboarding: fresh.onboarding };
  const ok = recordStep(connected, { kind: "destination", destination: "google" }, NO_FACTS, now);
  assert.ok(ok.ok && ok.location.onboarding!.destination!.kind === "google");

  delete process.env.FLAG_BOOKING_GOOGLE;
  try {
    assert.equal(recordStep(connected, { kind: "destination", destination: "google" }, NO_FACTS, now).ok, false);
    assert.equal(takesRequestsOnly({ ...connected, onboarding: { ...fresh.onboarding, destination: { kind: "google", setAt: at } } }), true);
  } finally {
    process.env.FLAG_BOOKING_GOOGLE = "on";
  }
});

await test("the bookings step and integrations page read the flag and the connection, and keep 'Coming soon' with it off", () => {
  const page = source("src/app/setup/[step]/page.tsx");
  assert.match(page, /if \(!flag\("booking\.google"\)\) \{\s*return \{ id: "google", title, state: "soon"/);
  const integrations = source("src/app/(app)/integrations/page.tsx");
  assert.match(integrations, /const googleOn = flag\("booking\.google"\)/);
  assert.match(integrations, /GOOGLE_EXPIRED_TEXT/);
  assert.match(integrations, /GoogleCalendarControls/);
});

// ---------------------------------------------------------------------------
head("An expired token: exception, owner banner, requests");

await test("Google refusing the token marks the link, raises one exception, offers nothing, and falls back to requests", async () => {
  resetCustomerErrors();
  const loc = getLocation(salonBase.id)!;
  const withDest = upsertLocation({ ...loc, onboarding: { version: 1, channels: {}, destination: { kind: "google", setAt: at } } });
  assert.equal(providerFor(withDest), googleCalendarProvider);
  fake.expire();
  google.setGoogleApi(fake.api); // clears the cached access token
  try {
    const query = { locationId: loc.id, date: openDay(loc), serviceIds: [loc.salon!.services[0].id] };
    let offered: unknown[] = ["unset"];
    const lines = await errorsDuring(async () => {
      offered = await googleCalendarProvider.checkAvailability({ location: withDest }, query);
      await googleCalendarProvider.checkAvailability({ location: withDest }, query);
    });
    assert.deepEqual(offered, []);
    assert.equal(lines.filter((l) => l.startsWith(`[exception] google:expired:${loc.id}`)).length, 1);
    const after = getLocation(loc.id)!;
    assert.ok(after.google!.expiredAt);
    assert.equal(providerFor(after), requestOnlyProvider);
    assert.equal(takesRequestsOnly(after), true);
    const state = google.connectionState(after);
    assert.ok(state.connected && !state.healthy && state.expired);
    assert.equal(state.detail, google.GOOGLE_EXPIRED_TEXT);
    assert.doesNotMatch(state.detail, /invalid_grant|401|token/i);
    const created = await googleCalendarProvider.createBooking(
      { location: after },
      { date: query.date, startMin: 600, guestName: "Nadia", guestPhone: "+971500000001", serviceIds: query.serviceIds },
      "call_45:book:1",
    );
    assert.ok(!created.ok);
  } finally {
    fake.restore();
  }
});

await test("the owner's home banner carries the calendar line", async () => {
  const { overviewFor, visibleHealth } = await import("../src/lib/overview");
  const loc = getLocation(salonBase.id)!;
  const overview = await overviewFor(loc);
  const line = visibleHealth(overview.health, false).find((h) => h.label === "Calendar");
  assert.ok(line && !line.ok && line.detail === google.GOOGLE_EXPIRED_TEXT);
});

await test("reconnecting keeps the calendars picked, and clears the expiry", async () => {
  const loc = getLocation(salonBase.id)!;
  const again = upsertLocation(await google.completeConnection(loc, "stub-code", "http://localhost/cb", "user_owner", now));
  assert.equal(again.google!.expiredAt, undefined);
  assert.equal(again.google!.calendarId, "primary");
  assert.ok(again.google!.staffCalendars && Object.keys(again.google!.staffCalendars).length === 1);
  assert.equal(providerFor(again), googleCalendarProvider);
});

await test("disconnecting revokes at Google, drops the link and puts the venue back on requests", async () => {
  const loc = getLocation(salonBase.id)!;
  const sealedToken = openCredentials(loc.google!.sealedToken!).refreshToken;
  const out = upsertLocation(await google.disconnectGoogle(loc, now));
  assert.equal(out.google, undefined);
  assert.equal(out.onboarding!.destination!.kind, "requests");
  assert.ok(fake.revoked.includes(sealedToken));
  assert.equal(providerFor(out), requestOnlyProvider);
});

// ---------------------------------------------------------------------------
head("The privacy page");

await test("the privacy page carries the Limited Use statement without claiming the connection is live", () => {
  const html = source("public/privacy.html");
  assert.match(html, /Google API Services User Data Policy<\/a>, including the Limited Use requirements/);
  assert.match(html, /developers\.google\.com\/terms\/api-services-user-data-policy/);
  assert.match(html, /Connecting a Google Calendar is not available yet/);
  assert.match(html, /No calendar can be connected yet/);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
