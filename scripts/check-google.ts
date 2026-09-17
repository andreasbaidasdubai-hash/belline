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
  const { state, nonce } = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "calendars" });
  const first = google.verifyState(state, { userId: "user_owner", cookieNonce: nonce });
  assert.deepEqual(first, { ok: true, locationId: salonBase.id, returnTo: "calendars" });
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

/** What a restart looks like to this process: every in-memory cache gone, the data directory kept. */
function restart(): void {
  const g = globalThis as Record<string, unknown>;
  for (const key of ["__bellineDb", "__bellineStamps", "__bellineCheckedAt", "__bellineGoogleNonces", "__bellineGoogleAccess"]) delete g[key];
}

await test("a restart between 'Connect' and Google's answer does not make the owner start again", () => {
  const { state, nonce } = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  restart();
  const back = google.verifyState(state, { userId: "user_owner", cookieNonce: nonce });
  assert.deepEqual(back, { ok: true, locationId: salonBase.id, returnTo: "setup" }, `refused after a restart: ${JSON.stringify(back)}`);
  assert.ok(!dataOnDisk().includes(nonce), "the nonce itself is written to the data");
  // And still single use after the restart.
  restart();
  const again = google.verifyState(state, { userId: "user_owner", cookieNonce: nonce });
  assert.ok(!again.ok && again.reason === "used");
});

await test("a connection whose record is gone fails gracefully: back where it started, told to connect again", () => {
  const { state, nonce } = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  // The pending record lost, as it was on every restart before it was stored.
  const stateFile = path.join(process.env.DATA_DIR!, "oauthStates.json");
  if (fs.existsSync(stateFile)) fs.writeFileSync(stateFile, "[]");
  restart();
  let checked: ReturnType<typeof google.verifyState> | undefined;
  assert.doesNotThrow(() => {
    checked = google.verifyState(state, { userId: "user_owner", cookieNonce: nonce });
  });
  assert.ok(checked && !checked.ok && checked.reason === "used" && checked.returnTo === "setup");
  const route = source("src/app/api/integrations/google/route.ts");
  assert.match(route, /if \(!checked\.ok\) \{[\s\S]{0,200}land\(request, checked\.returnTo \?\? "calendars", undefined, "google_failed"\)/);
  assert.equal(google.returnPath("setup", undefined, "google_failed"), "/setup/bookings?google=google_failed");
  assert.match(integrationErrorText("google_failed")!, /Please connect again/);
  // The setup step shows that sentence for this code.
  assert.match(source("src/app/setup/[step]/page.tsx"), /code === "google_failed"\) return integrationErrorText\(code\)/);
});

await test("a decline lands on the bookings step with 'No problem — requests for now', never on Google", () => {
  const setup = google.returnPath("setup", salonBase.id, "declined");
  assert.equal(setup, "/setup/bookings?google=declined");
  assert.equal(google.returnPath("calendars", salonBase.id, "declined"), `/calendars?loc=${salonBase.id}&error=google_declined`);
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
head("Moving a booking to a person with another calendar moves the event");

await test("to a person with their own calendar: gone from the first, exactly one on the second", async () => {
  const loc = getLocation(salonBase.id)!;
  const [first, second] = loc.salon!.staff;
  assert.equal(google.calendarFor(loc.google!, first.id), "staff-a@group.calendar.google.com");
  assert.equal(google.calendarFor(loc.google!, second.id), "primary");
  const { date, startMin } = sharedSlot(loc);
  const serviceIds = [loc.salon!.services[0].id];
  const made = await googleCalendarProvider.createBooking({ location: loc }, { date, startMin, guestName: "Mover Guest", guestPhone: "+971500000105", serviceIds, staffId: second.id }, "call_61:book:1");
  assert.ok(made.ok, made.ok ? "" : made.detail);
  if (!made.ok) return;
  assert.deepEqual(liveEventsOf(made.booking.id).map((e) => e.calendarId), ["primary"]);

  const moved = modifyLocal(getLocation(loc.id)!, getBooking(made.booking.id)!, { staffId: first.id, staffOverride: true });
  assert.ok(moved.ok, moved.ok ? "" : moved.detail);
  await settle();
  const events = liveEventsOf(made.booking.id);
  assert.deepEqual(events.map((e) => e.calendarId), ["staff-a@group.calendar.google.com"], `after the move: ${JSON.stringify(events.map((e) => e.calendarId))}`);
  assert.equal(getBooking(made.booking.id)!.calendarId, "staff-a@group.calendar.google.com");
});

await test("and back again through the agent's reschedule: one event, on the first calendar, none stranded", async () => {
  const loc = getLocation(salonBase.id)!;
  const [, second] = loc.salon!.staff;
  const booking = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "Mover Guest")!;
  const out = await googleCalendarProvider.rescheduleBooking({ location: loc }, booking, { staffId: second.id });
  assert.ok(out.ok, out.ok ? "" : out.detail);
  await settle();
  assert.deepEqual(liveEventsOf(booking.id).map((e) => e.calendarId), ["primary"]);
  assert.equal(getBooking(booking.id)!.calendarId, "primary");
});

await test("cancelling after a move cancels the event where it is now", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "Mover Guest")!;
  const out = await googleCalendarProvider.cancelBooking({ location: loc }, booking, "Guest asked");
  assert.ok(out.ok);
  await settle();
  assert.deepEqual(liveEventsOf(booking.id), []);
});

await test("an old event Google would not delete is retried until it is gone, never left as a duplicate", async () => {
  assert.ok(sync, "no sync module");
  const loc = getLocation(salonBase.id)!;
  const [first, second] = loc.salon!.staff;
  const { date, startMin } = sharedSlot(loc);
  const made = createFromDesk(loc, { date, startMin, serviceIds: [loc.salon!.services[0].id], staffId: second.id, guestName: "Stuck Guest", guestPhone: "+971500000106" });
  assert.ok(made.ok);
  if (!made.ok) return;
  await settle();
  fake.failNext("cancelEvent", 1);
  await errorsDuring(async () => {
    updateFromDesk(getLocation(loc.id)!, getBooking(made.booking.id)!, { staffId: first.id });
    await settle();
  });
  const stuck = getBooking(made.booking.id)!;
  assert.equal(stuck.calendarSync?.state, "failed");
  assert.deepEqual(stuck.calendarSync?.stale, [{ calendarId: "primary", eventId: stuck.calendarEventId }], "the old event is not recorded for clean-up");
  await sync!.retryGoogleSyncs(new Date(Date.now() + 60 * 60_000));
  assert.deepEqual(liveEventsOf(made.booking.id).map((e) => e.calendarId), ["staff-a@group.calendar.google.com"]);
  assert.equal(getBooking(made.booking.id)!.calendarSync?.stale, undefined);
});

await test("a write that reached Google but whose answer was lost is cleaned up when the booking moves again", async () => {
  assert.ok(sync, "no sync module");
  const loc = getLocation(salonBase.id)!;
  const [first, second] = loc.salon!.staff;
  const booking = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "Stuck Guest")!;
  // Written to the second calendar, then the connection dropped before Google answered.
  fake.failNext("putEvent", 1, { afterWrite: true });
  await errorsDuring(async () => {
    updateFromDesk(getLocation(loc.id)!, getBooking(booking.id)!, { staffId: second.id });
    await settle();
  });
  assert.equal(getBooking(booking.id)!.calendarSync?.inflight?.calendarId, "primary");
  // Before any retry, the booking moves back to the first person.
  updateFromDesk(getLocation(loc.id)!, getBooking(booking.id)!, { staffId: first.id });
  await settle();
  assert.deepEqual(liveEventsOf(booking.id).map((e) => e.calendarId), ["staff-a@group.calendar.google.com"], "an orphan was left on the calendar the write reached");
});

await test("changing which calendar a person uses moves their upcoming bookings' events", async () => {
  assert.ok(sync, "no sync module");
  const loc = getLocation(salonBase.id)!;
  const [first] = loc.salon!.staff;
  const booking = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "Stuck Guest")!;
  assert.equal(booking.staffId, first.id);
  const picked = await google.chooseCalendars(loc, { calendarId: "primary", staffCalendars: {} });
  assert.ok(picked.ok);
  if (!picked.ok) return;
  const saved = upsertLocation(picked.location);
  sync!.resyncMovedCalendars(saved);
  await settle();
  assert.deepEqual(liveEventsOf(booking.id).map((e) => e.calendarId), ["primary"]);
  // Put the person's own calendar back for the tests after this one.
  const back = await google.chooseCalendars(getLocation(loc.id)!, { calendarId: "primary", staffCalendars: { [first.id]: "staff-a@group.calendar.google.com" } });
  assert.ok(back.ok);
  if (back.ok) sync!.resyncMovedCalendars(upsertLocation(back.location));
  await settle();
  assert.deepEqual(liveEventsOf(booking.id).map((e) => e.calendarId), ["staff-a@group.calendar.google.com"]);
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

await test("the bookings step and calendars page read the flag and the connection, and keep 'Coming soon' with it off", () => {
  const page = source("src/app/setup/[step]/page.tsx");
  assert.match(page, /if \(!flag\("booking\.google"\)\) \{\s*return \{ id: "google", title, state: "soon"/);
  const integrations = source("src/app/(app)/calendars/page.tsx");
  assert.match(integrations, /const googleOn = flag\("booking\.google"\)/);
  assert.match(integrations, /GOOGLE_EXPIRED_TEXT/);
  assert.match(integrations, /endpoint="\/api\/integrations\/google"/);
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
    // In the team's queue, not only a log line.
    const { listExceptions } = await import("../src/lib/exceptions");
    const queued = listExceptions({ locationId: loc.id, kind: "google_token_expired" });
    assert.equal(queued.length, 1, "no google_token_expired exception for the team");
  } finally {
    fake.restore();
  }
});

await test("a booking taken at the desk while the connection is down is kept, and waits for the calendar", async () => {
  const loc = getLocation(salonBase.id)!;
  assert.ok(loc.google?.expiredAt, "the salon should still be expired here");
  const { date, startMin } = sharedSlot(loc);
  const out = createFromDesk(loc, { date, startMin, serviceIds: [loc.salon!.services[0].id], staffId: loc.salon!.staff[1].id, guestName: "While Down", guestPhone: "+971500000107" });
  assert.ok(out.ok, out.ok ? "" : out.error);
  await settle();
  const saved = listBookings({ locationId: loc.id, status: "confirmed" }).find((b) => b.guestName === "While Down")!;
  assert.equal(saved.calendarSync?.state, "pending");
  assert.equal(liveEventsOf(saved.id).length, 0);
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

await test("once reconnected, the sweep writes what was booked while it was down", async () => {
  assert.ok(sync, "no sync module");
  await sync!.sweepGoogle(new Date());
  const booking = listBookings({ locationId: salonBase.id, status: "confirmed" }).find((b) => b.guestName === "While Down")!;
  assert.equal(getBooking(booking.id)!.calendarSync?.state, "synced");
  assert.equal(liveEventsOf(booking.id).length, 1);
});

// ---------------------------------------------------------------------------
head("Misconfiguration in the real world: said plainly to the owner, logged and queued for us");

const googleApiLib = await import("../src/lib/integrations/google-api");
/** A customer venue the tests above never connected. */
const spareVenue = () => {
  const v = listLocations().find((l) => !l.internal && l.id !== salonBase.id && l.id !== restaurantBase.id && !l.google);
  assert.ok(v, "the fixture has no third venue");
  return v!;
};

/** Answer the live client's fetches with these, in order, for the length of `fn`. */
async function withGoogleReplies(replies: { status: number; body: unknown }[], fn: () => Promise<void>): Promise<void> {
  const guard = globalThis.fetch;
  const queue = [...replies];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.match(url, /^https:\/\/(oauth2|www)\.googleapis\.com\//, `the live client asked for ${url}`);
    const next = queue.shift();
    assert.ok(next, `an unexpected request to ${url}`);
    return new Response(JSON.stringify(next!.body), { status: next!.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = guard;
  }
}
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
};

await test("the live client reads Google's answers right: API off and a bad client are ours, 401 and a withdrawn permission are the owner's", async () => {
  const { liveGoogleApi, GoogleAuthError, GoogleConfigError, GoogleApiError } = googleApiLib;
  const disabled = {
    error: {
      code: 403,
      message: "Google Calendar API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456 then retry.",
      errors: [{ message: "…", domain: "usageLimits", reason: "accessNotConfigured", extendedHelp: "https://console.developers.google.com" }],
      status: "PERMISSION_DENIED",
    },
  };
  const scope = { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } };
  await withGoogleReplies(
    [
      { status: 403, body: disabled },
      { status: 403, body: disabled },
      { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } },
      { status: 403, body: scope },
      { status: 500, body: { error: { code: 500 } } },
      { status: 401, body: { error: "invalid_client" } },
      { status: 400, body: { error: "redirect_uri_mismatch" } },
      { status: 400, body: { error: "invalid_grant" } },
    ],
    async () => {
      const a = await rejection(liveGoogleApi.listCalendars("t"));
      assert.ok(a instanceof GoogleConfigError && a.reason === "api_disabled", String(a));
      const b = await rejection(liveGoogleApi.listEvents("t", "primary", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"));
      assert.ok(b instanceof GoogleConfigError && b.reason === "api_disabled", String(b));
      assert.ok((await rejection(liveGoogleApi.putEvent("t", "primary", { id: "blx" } as never))) instanceof GoogleAuthError);
      assert.ok((await rejection(liveGoogleApi.cancelEvent("t", "primary", "blx"))) instanceof GoogleAuthError, "a withdrawn permission is not read as a lost connection");
      const e = await rejection(liveGoogleApi.insertEvent("t", "primary", { id: "blx" } as never));
      assert.ok(e instanceof GoogleApiError && !(e instanceof GoogleConfigError));
      const f = await rejection(liveGoogleApi.accessToken("r"));
      assert.ok(f instanceof GoogleConfigError && f.reason === "client", String(f));
      const g = await rejection(liveGoogleApi.exchangeCode("c", "https://app.belline.ai/api/integrations/google"));
      assert.ok(g instanceof GoogleConfigError && g.reason === "client", String(g));
      assert.ok((await rejection(liveGoogleApi.accessToken("r"))) instanceof GoogleAuthError);
    },
  );
});

await test("the Calendar API switched off: requests, the owner told it is ours, the team given the fix, and back by itself once it is on", async () => {
  assert.ok(sync, "no sync module");
  resetCustomerErrors();
  const { listExceptions } = await import("../src/lib/exceptions");
  const loc = getLocation(restaurantBase.id)!;
  assert.equal(providerFor(loc), googleCalendarProvider, "the restaurant should be booking into Google here");
  fake.disableApi();
  google.setGoogleApi(fake.api);
  let bookingId = "";
  try {
    const date = addDays(todayIn(loc.timezone), 9);
    const lines = await errorsDuring(async () => {
      const offered = await googleCalendarProvider.checkAvailability({ location: loc }, { locationId: loc.id, date, partySize: 2 });
      assert.deepEqual(offered, [], "times offered from a calendar Google will not show");
    });
    const after = getLocation(loc.id)!;
    assert.ok(after.google!.misconfiguredAt, "the venue is not marked");
    assert.equal(providerFor(after), requestOnlyProvider);
    assert.equal(takesRequestsOnly(after), true);
    const state = google.connectionState(after);
    assert.ok(state.connected && !state.healthy && !state.expired);
    assert.equal(state.detail, google.GOOGLE_MISCONFIGURED_TEXT);
    assert.doesNotMatch(state.detail, /403|accessNotConfigured|SERVICE_DISABLED|API|project/i);
    assert.equal(lines.filter((l) => l.startsWith(`[exception] google:misconfigured:${loc.id}`)).length, 1, "not logged for us");
    const queued = listExceptions({ locationId: loc.id, kind: "google_misconfigured" });
    assert.equal(queued.length, 1);
    assert.match(queued[0].reason, /Enable the Google Calendar API/);
    const { overviewFor, visibleHealth } = await import("../src/lib/overview");
    const line = visibleHealth((await overviewFor(after)).health, false).find((h) => h.label === "Calendar");
    assert.ok(line && !line.ok && line.detail === google.GOOGLE_MISCONFIGURED_TEXT, "the owner's home banner does not say so");

    // A desk booking in the meantime waits rather than failing.
    const made = createLocal(after, { date, startMin: 19 * 60, partySize: 2, guestName: "API Off Guest", guestPhone: "+971500000108", source: "manual", staffOverride: true });
    assert.ok(made.ok, made.ok ? "" : made.detail);
    if (made.ok) bookingId = made.booking.id;
    await settle();
    assert.equal(getBooking(bookingId)!.calendarSync?.state, "pending");

    // Still off: the sweep leaves it marked.
    const still = await sync!.sweepGoogle(new Date());
    assert.equal(still.recovered, 0);
  } finally {
    fake.enableApi();
  }
  const swept = await sync!.sweepGoogle(new Date());
  assert.equal(swept.recovered, 1);
  const back = getLocation(loc.id)!;
  assert.equal(back.google!.misconfiguredAt, undefined);
  assert.equal(providerFor(back), googleCalendarProvider);
  assert.ok(google.connectionState(back).healthy);
  assert.equal(getBooking(bookingId)!.calendarSync?.state, "synced", "the waiting booking was not written once Google answered");
  assert.equal(fake.calendar.events("primary").filter((e) => e.bellineBookingId === bookingId && e.status !== "cancelled").length, 1);
});

await test("connecting while the API is off never says 'connected': the owner lands on 'not available yet'", async () => {
  const route = source("src/app/api/integrations/google/route.ts");
  assert.match(route, /await listCalendarsFor\(saved\);[\s\S]{0,120}if \(err instanceof GoogleConfigError\) return land\(request, checked\.returnTo, saved\.id, "google_unavailable"\)/);
  assert.ok(route.indexOf("listCalendarsFor(saved)") < route.indexOf('"connected")'), "the probe comes after 'connected'");
  assert.match(route, /if \(err instanceof GoogleConfigError\) \{\s*\/\/[^\n]*\n\s*reportMisconfigured\(location, err\);[\s\S]{0,300}"google_unavailable"\)/);
  assert.match(integrationErrorText("google_unavailable")!, /not available on this account yet/);
  // And the same path, run: a fresh connection, then the probe.
  const venue = spareVenue();
  fake.disableApi();
  try {
    const connected = upsertLocation(await google.completeConnection(venue, "stub-code", "http://localhost/cb", "user_owner", now));
    const err = await errorsDuring(async () => {
      const out = await google.listCalendarsFor(connected).catch((e: unknown) => e);
      assert.ok(out instanceof googleApiLib.GoogleConfigError);
    });
    assert.ok(err.some((l) => l.includes(`google:misconfigured:${venue.id}`)));
    assert.ok(getLocation(venue.id)!.google!.misconfiguredAt);
  } finally {
    fake.enableApi();
    upsertLocation(venue);
  }
});

await test("a permission unticked on Google's screen is refused, the token handed back, and the owner told to allow both", async () => {
  const venue = spareVenue();
  fake.grant([GOOGLE_SCOPES[1]]);
  try {
    const revokedBefore = fake.revoked.length;
    const err = await rejection(google.completeConnection({ ...venue, google: undefined }, "stub-code", "http://localhost/cb", "user_owner", now));
    assert.ok(err instanceof google.GoogleScopeError, String(err));
    assert.deepEqual((err as InstanceType<typeof google.GoogleScopeError>).missing, [GOOGLE_SCOPES[0]]);
    assert.equal(fake.revoked.length, revokedBefore + 1, "the half-granted token was not handed back");
  } finally {
    fake.grant();
  }
  const route = source("src/app/api/integrations/google/route.ts");
  assert.match(route, /if \(err instanceof GoogleScopeError\) \{[\s\S]{0,400}"google_refused"\)/);
  assert.match(integrationErrorText("google_refused")!, /both permissions ticked/);
});

await test("an owner Google stops at 'Access blocked' (not a test user) never returns: the owner is told what to do and the team gets an exception", async () => {
  const { listExceptions } = await import("../src/lib/exceptions");
  const venue = spareVenue();
  const started = Date.now();
  // The owner presses Connect; Google shows "Access blocked" and nothing comes back.
  google.signState({ locationId: venue.id, userId: "user_owner", returnTo: "setup" }, started);
  // Another owner connects normally: no exception for that one.
  const other = google.signState({ locationId: restaurantBase.id, userId: "user_owner", returnTo: "calendars" }, started);
  assert.ok(google.verifyState(other.state, { userId: "user_owner", cookieNonce: other.nonce, now: started }).ok);

  assert.equal(google.sweepAbandonedConnects(new Date(started + 5 * 60_000)), 0, "raised before the ten minutes were up");
  let raised = 0;
  await errorsDuring(() => {
    raised = google.sweepAbandonedConnects(new Date(started + 11 * 60_000));
  });
  assert.ok(raised >= 1);
  const queued = listExceptions({ locationId: venue.id, kind: "google_connect_abandoned" });
  assert.equal(queued.length, 1);
  assert.match(queued[0].reason, /test users/);
  assert.equal(listExceptions({ locationId: restaurantBase.id, kind: "google_connect_abandoned" }).length, 0, "a connection that came back was raised");
  assert.ok(getLocation(venue.id)!.googleConnectAbandonedAt);
  assert.equal(google.sweepAbandonedConnects(new Date(started + 20 * 60_000)), 0, "raised twice");
  // The owner's words, on the page they come back to.
  assert.match(google.GOOGLE_ABANDONED_TEXT, /access is blocked/);
  assert.doesNotMatch(google.GOOGLE_ABANDONED_TEXT, /403|OAuth|consent screen|test user/i);
  const page = source("src/app/(app)/calendars/page.tsx");
  assert.match(page, /googleVenue\.googleConnectAbandonedAt && \([\s\S]{0,300}\{GOOGLE_ABANDONED_TEXT\}/);
  // A decline that does come back is still "requests for now", and logged.
  const route = source("src/app/api/integrations/google/route.ts");
  assert.match(route, /if \(oauthError\) console\.warn\(/);
  // Connecting afterwards clears the notice.
  const connected = await google.completeConnection(getLocation(venue.id)!, "stub-code", "http://localhost/cb", "user_owner", now);
  assert.equal(connected.googleConnectAbandonedAt, undefined);
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
head("'Coming soon' follows the flag: the website, the setup step, the app and Belle");

const { applySiteFlags, strandedSiteCopy, SITE_FLAG_COPY } = await import("../src/lib/site-flags");
const OFF = { FLAG_BOOKING_GOOGLE: "off" } as Record<string, string>;
/** On as production would have it. FLAG_STUBS alone never turns the public copy on. */
const ON = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", CREDENTIALS_KEY: "key", FLAG_BOOKING_GOOGLE: "on" } as Record<string, string>;
const publicPage = (file: string) => source(`public/${file}`);
/** The parts of a page a visitor reads: no comments. */
const visible = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");
/**
 * Only the words: a class name like `cal-soon` is not a sentence. The
 * integrations strip is left out: it is a list of tags, one per system, and
 * check:webchat holds it to the flags on its own.
 */
const words = (html: string) =>
  visible(html.replace(/<section id="connects"[\s\S]*?<\/section>/g, "")).replace(/<[^>]+>/g, " ");
const SOON_CALENDAR = /\bsoon\b[^.<]{0,80}\bcalendar\b|\bcalendar\b[^.<]{0,80}\bsoon\b|not available yet|No calendar can be connected yet/i;

await test("every sentence the flag swaps is still in its page, exactly once", () => {
  assert.ok((SITE_FLAG_COPY["booking.google"] ?? []).length >= 5);
  assert.deepEqual(strandedSiteCopy(publicPage), []);
});

await test("flag off, the website is exactly the page as written: Google Calendar is coming soon", () => {
  for (const file of ["landing.html", "privacy.html"]) {
    assert.equal(applySiteFlags(file, publicPage(file), OFF), publicPage(file), `${file} changed with the flag off`);
    assert.equal(applySiteFlags(file, publicPage(file), {}), publicPage(file), `${file} changed with no env at all`);
  }
  assert.match(visible(publicPage("landing.html")), /Coming soon: books into your calendar/);
  assert.match(visible(publicPage("privacy.html")), /No calendar can be connected yet/);
});

await test("flag on, the website says Google Calendar works, and 'soon' is gone from every calendar sentence", () => {
  const landing = visible(applySiteFlags("landing.html", publicPage("landing.html"), ON));
  assert.doesNotMatch(words(landing), SOON_CALENDAR, "the landing page still says the calendar is coming");
  assert.match(landing, /<span class="state state-available cal-soon">Books into Google Calendar<\/span>/);
  // Google and Outlook are separate entries in "Whatever you book with": Outlook still says it is coming.
  assert.match(landing, /<dd>Connect Google Calendar and Belline checks it for times already taken, then books straight into it\.<\/dd>/);
  assert.match(landing, /<dd>Belline takes booking requests today\. Booking straight into Outlook is coming soon\.<\/dd>/, "Outlook is not kept honest");
  // The hero says what books, and the example books the free time: never "Waiting for your team" beside it.
  assert.match(landing, /<li class="can-cal">Books into Google Calendar<\/li>/);
  assert.match(landing, /<span class="cal-new-state">Confirmed<\/span>/);
  assert.doesNotMatch(landing.replace(/<!--[\s\S]*?-->/g, ""), /Waiting for your team/);
  const privacy = visible(applySiteFlags("privacy.html", publicPage("privacy.html"), ON));
  assert.doesNotMatch(words(privacy), SOON_CALENDAR, "the privacy page still says a calendar cannot be connected");
  assert.match(privacy, /Google API Services User Data Policy<\/a>, including the Limited Use requirements/);
  // check:billing's rule for the legal pages holds in both states.
  assert.doesNotMatch(privacy, /\b(?:books?|booking|booked) (?:straight |directly )?(?:into|against|in) (?:your|the|their) (?:real |existing )?(?:diary|calendar)\b/i);
});

await test("the server swaps the copy as it serves the built site, by the flag it has now", async () => {
  const { serveMarketing } = await import("../src/lib/marketing");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "belline-site-"));
  const cwd = process.cwd();
  fs.mkdirSync(path.join(dir, "site"));
  fs.writeFileSync(path.join(dir, "site", "index.html"), publicPage("landing.html"));
  fs.writeFileSync(path.join(dir, "site", "privacy.html"), publicPage("privacy.html"));
  const get = (url: string) => {
    let body = "";
    const res = { writeHead: () => res, end: (b?: Buffer | string) => void (body = b ? String(b) : "") };
    const served = serveMarketing({ method: "GET", url } as never, res as never);
    assert.ok(served, `${url} was not served`);
    return body;
  };
  process.chdir(dir);
  // The public site ignores FLAG_STUBS, so this is the flag as production has it: credentials and the switch.
  const saved = { ...process.env };
  delete process.env.FLAG_STUBS;
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
  try {
    process.env.FLAG_BOOKING_GOOGLE = "off";
    assert.match(get("/"), /Coming soon: books into your calendar/);
    assert.match(get("/privacy"), /No calendar can be connected yet/);
    process.env.FLAG_BOOKING_GOOGLE = "on";
    assert.doesNotMatch(words(get("/")), SOON_CALENDAR);
    assert.match(get("/"), /Books into Google Calendar/);
    assert.doesNotMatch(words(get("/privacy")), SOON_CALENDAR);
  } finally {
    for (const k of ["FLAG_STUBS", "FLAG_BOOKING_GOOGLE", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("in the app, the destination step, integrations and channels read the flag, never fixed copy", () => {
  const setup = source("src/app/setup/[step]/page.tsx");
  assert.match(setup, /function googleCard\(venue: Location\): DestinationOption \{[\s\S]{0,120}if \(!flag\("booking\.google"\)\) \{\s*return \{ id: "google", title, state: "soon"/);
  // The calendar left Channels on 2026-09-17: it is where bookings go, not a way in.
  assert.doesNotMatch(source("src/app/(app)/channels/page.tsx"), /Google Calendar/);
  assert.match(source("src/app/(app)/calendars/page.tsx"), /const googleOn = flag\("booking\.google"\);/);
  assert.match(source("src/app/(app)/calendars/page.tsx"), /\{googleOn \? \(/);
  // Nowhere in the app is Google "coming soon" in fixed text outside a flag branch.
  for (const file of ["src/app/setup/[step]/page.tsx", "src/app/(app)/channels/page.tsx", "src/app/(app)/calendars/page.tsx"]) {
    const text = source(file);
    for (const m of text.matchAll(/Google Calendar[^"\n]{0,80}(?:coming soon|isn.t available|not available)/gi)) {
      const before = text.slice(Math.max(0, m.index! - 600), m.index);
      assert.match(before, /flag\("booking\.google"\)|googleOn/, `${file}: "${m[0]}" is not behind the flag`);
    }
  }
});

await test("Belle says the same as the website, by the same flag", async () => {
  const belle = await import("../src/lib/seed-belline");
  assert.match(belle.bookingSystemAnswer(OFF), /Google Calendar is coming soon/);
  assert.match(belle.routeLine(OFF), /booking into Google Calendar is coming soon/);
  assert.doesNotMatch(belle.bookingSystemAnswer(ON), /soon|not yet/i);
  assert.match(belle.bookingSystemAnswer(ON), /books straight into it/);
  assert.doesNotMatch(belle.routeLine(ON), /soon/i);
  const features = ["Google Calendar and booking-system integrations", "One Google Calendar or Microsoft Outlook connection", "Something else"];
  assert.deepEqual(belle.notYetForBelle(features, OFF), features);
  assert.ok(belle.notYetForBelle(features, ON).every((f) => !/Google/.test(f)), "Belle would still say Google Calendar does not work");
});

await test("the flag itself is never switched on in code", () => {
  assert.match(source("src/lib/flags.ts"), /"booking\.google": \{ needs: \["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "CREDENTIALS_KEY"\], explicit: true \}/);
  for (const file of ["Dockerfile", "server.ts", "src/lib/site-flags.ts", "src/lib/marketing.ts", "src/lib/seed-belline.ts"]) {
    assert.doesNotMatch(source(file), /FLAG_BOOKING_GOOGLE\s*[=:]\s*["']?on/, file);
  }
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
