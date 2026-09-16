/**
 * Outlook (Microsoft 365 and Outlook.com), against a fake Microsoft.
 *
 * The same promises check:google holds Google Calendar to, and Microsoft's
 * own: the OAuth state is signed and single use and cannot be replayed at
 * Google's callback; the refresh token is sealed, and the new one Microsoft
 * hands back on every refresh is the one kept; busy times take slots away and
 * never add one; the same booking twice is one event; a move across calendars
 * leaves nothing behind; failures are retried and raised; an expired
 * connection puts the venue on requests; Microsoft's refusals (a wrong client
 * or secret, an organisation that needs its IT admin to approve Belline, a
 * mailbox with no calendar) are said plainly; and every page and Belle say
 * Outlook works exactly while `booking.outlook` is on.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches
 * Microsoft or Google.
 *
 *   npm run check:outlook
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-outlook-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.FLAG_STUBS = "on";
process.env.FLAG_BOOKING_OUTLOOK = "on";
delete process.env.FLAG_BOOKING_GOOGLE;
delete process.env.MICROSOFT_CLIENT_ID;
delete process.env.MICROSOFT_CLIENT_SECRET;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { installFetchGuard, blockedFetches, fakeMicrosoftApi } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listBookings, listLocations, upsertLocation } = await import("../src/lib/store");
const listBookingsAt = (locationId: string) => listBookings({ locationId, status: "confirmed" });
const outlook = await import("../src/lib/integrations/outlook");
const msApi = await import("../src/lib/integrations/microsoft-api");
const google = await import("../src/lib/integrations/google");
const { openCredentials } = await import("../src/lib/db/credentials");
const { integrationErrorText, resetCustomerErrors } = await import("../src/lib/errors/customer");
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

/** Capture console.error lines while `fn` runs; warnings are silenced. */
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

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
};

seedIfEmpty();
const now = new Date("2026-09-15T10:00:00.000Z");
const at = now.toISOString();
const venues = listLocations();
const salonBase = venues.find((l) => l.vertical === "salon" && !l.internal && (l.salon?.staff.length ?? 0) >= 2)!;
const restaurantBase = venues.find((l) => l.vertical === "restaurant" && !l.internal)!;
/** A customer venue the tests never connect otherwise. */
const spareVenue = () => {
  const v = listLocations().find((l) => !l.internal && l.id !== salonBase.id && l.id !== restaurantBase.id && !l.outlook);
  assert.ok(v, "the fixture has no third venue");
  return v!;
};

const STAFF_CAL = "AAMkAD-staff-a";
const fake = fakeMicrosoftApi({
  calendars: [
    { id: "AAMkAD-default", name: "Calendar", primary: true },
    { id: STAFF_CAL, name: "First stylist", primary: false },
  ],
});
outlook.setMicrosoftApi(fake.api);

const CALLBACK = "http://localhost:3000/api/integrations/microsoft";

/** Connect through the real code path, and optionally choose Outlook as the destination. */
async function connect(base: Loc, destination = true): Promise<Loc> {
  let loc = await outlook.completeOutlookConnection(base, "stub-code", CALLBACK, "user_owner", now);
  if (destination) {
    loc = { ...loc, onboarding: { version: 1, channels: {}, ...base.onboarding, destination: { kind: "outlook", setAt: at } } };
  }
  return upsertLocation(loc);
}

// ---------------------------------------------------------------------------
head("OAuth: the common endpoint, exact scopes, signed single-use state, no loop on a decline");

await test("the scopes are exactly offline_access, User.Read and Calendars.ReadWrite, on the common endpoint", () => {
  assert.deepEqual([...msApi.MICROSOFT_SCOPES], ["offline_access", "User.Read", "Calendars.ReadWrite"]);
  assert.equal(msApi.MICROSOFT_AUTHORITY, "https://login.microsoftonline.com/common/oauth2/v2.0");
});

await test("the auth URL goes to Microsoft's common authorize endpoint with those scopes, and the state is not the venue id", () => {
  outlook.setMicrosoftApi(fake.api);
  process.env.MICROSOFT_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
  try {
    const { state } = outlook.signOutlookState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
    const url = new URL(outlook.outlookAuthUrl(state, CALLBACK));
    assert.equal(`${url.origin}${url.pathname}`, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    assert.equal(url.searchParams.get("scope"), "offline_access User.Read Calendars.ReadWrite");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("redirect_uri"), CALLBACK);
    assert.equal(url.searchParams.get("client_id"), "11111111-2222-3333-4444-555555555555");
    assert.ok(!url.searchParams.get("state")!.includes(salonBase.id));
  } finally {
    delete process.env.MICROSOFT_CLIENT_ID;
  }
});

await test("a state verifies once, for the same user and browser; forged, expired, other user's and cookieless ones are refused", () => {
  const a = outlook.signOutlookState({ locationId: salonBase.id, userId: "user_owner", returnTo: "integrations" });
  assert.deepEqual(outlook.verifyOutlookState(a.state, { userId: "user_owner", cookieNonce: a.nonce }), { ok: true, locationId: salonBase.id, returnTo: "integrations" });
  const again = outlook.verifyOutlookState(a.state, { userId: "user_owner", cookieNonce: a.nonce });
  assert.ok(!again.ok && again.reason === "used");

  const b = outlook.signOutlookState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const [body, sig] = b.state.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), l: "loc_someone_else" })).toString("base64url");
  const forged = outlook.verifyOutlookState(`${forgedBody}.${sig}`, { userId: "user_owner", cookieNonce: b.nonce });
  assert.ok(!forged.ok && forged.reason === "signature");

  const c = outlook.signOutlookState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" }, Date.now() - 11 * 60_000);
  const expired = outlook.verifyOutlookState(c.state, { userId: "user_owner", cookieNonce: c.nonce });
  assert.ok(!expired.ok && expired.reason === "expired");

  const d = outlook.signOutlookState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const other = outlook.verifyOutlookState(d.state, { userId: "user_attacker", cookieNonce: d.nonce });
  assert.ok(!other.ok && other.reason === "user");

  const e = outlook.signOutlookState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const noCookie = outlook.verifyOutlookState(e.state, { userId: "user_owner" });
  assert.ok(!noCookie.ok && noCookie.reason === "cookie");
  assert.ok(!dataOnDisk().includes(e.nonce), "a nonce itself is written to the data");
});

await test("an Outlook state is refused at Google's callback, and a Google state at Outlook's", () => {
  const o = outlook.signOutlookState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const atGoogle = google.verifyState(o.state, { userId: "user_owner", cookieNonce: o.nonce });
  assert.ok(!atGoogle.ok && atGoogle.reason === "signature");
  const g = google.signState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const atOutlook = outlook.verifyOutlookState(g.state, { userId: "user_owner", cookieNonce: g.nonce });
  assert.ok(!atOutlook.ok && atOutlook.reason === "signature");
  // Google's pending row is untouched by the attempt, and still good once.
  assert.ok(google.verifyState(g.state, { userId: "user_owner", cookieNonce: g.nonce }).ok);
});

await test("a restart between 'Connect' and Microsoft's answer does not make the owner start again", () => {
  const { state, nonce } = outlook.signOutlookState({ locationId: salonBase.id, userId: "user_owner", returnTo: "setup" });
  const g = globalThis as Record<string, unknown>;
  for (const key of ["__bellineDb", "__bellineStamps", "__bellineCheckedAt", "__bellineOutlookAccess"]) delete g[key];
  assert.deepEqual(outlook.verifyOutlookState(state, { userId: "user_owner", cookieNonce: nonce }), { ok: true, locationId: salonBase.id, returnTo: "setup" });
});

await test("a decline lands where the owner started with 'No problem — requests for now', never on Microsoft", () => {
  assert.equal(outlook.outlookReturnPath("setup", salonBase.id, "declined"), "/setup/bookings?outlook=declined");
  assert.equal(outlook.outlookReturnPath("integrations", salonBase.id, "declined"), `/integrations?loc=${salonBase.id}&error=outlook_declined`);
  assert.match(integrationErrorText("outlook_declined")!, /^No problem — requests for now\./);
  const route = source("src/app/api/integrations/microsoft/route.ts");
  assert.match(route, /oauthError === "access_denied"\) return land\(checked\.returnTo, location\.id, "declined"\)/);
  assert.equal(route.match(/outlookAuthUrl\(/g)?.length, 1, "the callback builds a Microsoft URL");
  assert.ok(route.indexOf("outlookAuthUrl(") < route.indexOf("verifyOutlookState("));
});

await test("the route verifies the state before trusting a venue, the flag gates the start, and landing uses appOrigin()", () => {
  const route = source("src/app/api/integrations/microsoft/route.ts");
  assert.match(route, /verifyOutlookState\(state, \{ userId: auth\.user\.id, cookieNonce/);
  assert.match(route, /getLocation\(checked\.locationId\)/);
  assert.match(route, /!flag\("booking\.outlook"\) \|\| !credentialsConfigured\(\)/);
  assert.match(route, /new URL\(outlookReturnPath\(returnTo, locationId, outcome\), appOrigin\(\)\)/);
  assert.match(route, /x-forwarded-proto/);
  assert.doesNotMatch(route, /request\.url\)\)/, "a redirect is resolved against request.url");
  assert.doesNotMatch(route, /refreshToken/);
});

await test("under stubs with nothing injected, the auth URL comes straight back here, never to Microsoft", () => {
  outlook.setMicrosoftApi(null);
  try {
    const url = new URL(outlook.outlookAuthUrl("s.t", CALLBACK));
    assert.equal(url.hostname, "localhost");
    assert.equal(url.searchParams.get("code"), "stub-code");
  } finally {
    outlook.setMicrosoftApi(fake.api);
  }
});

await test("one calendar per venue: Outlook will not start over a Google connection, nor Google over Outlook", () => {
  assert.match(source("src/app/api/integrations/microsoft/route.ts"), /if \(location\.google\) return land\(returnTo, location\.id, "outlook_in_use"\)/);
  assert.match(source("src/app/api/integrations/google/route.ts"), /if \(location\.outlook\) return land\(request, returnTo, location\.id, "google_in_use"\)/);
  assert.match(integrationErrorText("outlook_in_use")!, /Disconnect Google Calendar first/);
  assert.match(integrationErrorText("google_in_use")!, /Disconnect Outlook first/);
});

// ---------------------------------------------------------------------------
head("The token: sealed, never plain, and the newest one kept");

await test("connecting stores a sealed token that opens, no plain token anywhere, and picks the default calendar", async () => {
  const loc = await connect(salonBase, false);
  const link = loc.outlook!;
  assert.ok(link.sealedToken?.startsWith("v1."));
  const plain = openCredentials(link.sealedToken!).refreshToken;
  assert.match(plain, /^stub-ms-refresh-/);
  assert.ok(!dataOnDisk().includes(plain), "token in DATA_DIR");
  assert.equal(link.calendarId, "AAMkAD-default");
  assert.equal(link.calendarName, "Calendar");
});

await test("a refresh that rotates the token stores the new one, sealed; the old one is not needed again", async () => {
  outlook.setMicrosoftApi(fake.api); // no cached access token
  fake.revokeOnRotate(true);
  try {
    const before = getLocation(salonBase.id)!.outlook!;
    const oldPlain = openCredentials(before.sealedToken!).refreshToken;
    await outlook.listOutlookCalendarsFor(getLocation(salonBase.id)!);
    const after = getLocation(salonBase.id)!.outlook!;
    const newPlain = openCredentials(after.sealedToken!).refreshToken;
    assert.notEqual(newPlain, oldPlain, "the rotated refresh token was not stored");
    assert.ok(!fake.accepts(oldPlain), "the fixture did not revoke the old token");
    assert.ok(!dataOnDisk().includes(newPlain));
    // A second refresh, from a stale copy of the venue, still works: the stored token is used.
    outlook.setMicrosoftApi(fake.api);
    await outlook.listOutlookCalendarsFor({ ...salonBase, outlook: before });
    assert.equal(getLocation(salonBase.id)!.outlook!.expiredAt, undefined, "a stale copy of the venue expired the connection");
  } finally {
    fake.revokeOnRotate(false);
  }
});

await test("a code Microsoft refuses is not a connection, and nothing is stored", async () => {
  const venue = spareVenue();
  const err = await rejection(outlook.completeOutlookConnection(venue, "spent-code", CALLBACK, "user_owner", now));
  assert.ok(err instanceof msApi.MicrosoftApiError, String(err));
  assert.equal(getLocation(venue.id)!.outlook, undefined);
});

await test("an account with no calendar it can write to is refused before anything is stored", async () => {
  const venue = spareVenue();
  fake.setCalendars([]);
  try {
    const err = await rejection(outlook.completeOutlookConnection(venue, "stub-code", CALLBACK, "user_owner", now));
    assert.ok(err instanceof outlook.OutlookNoCalendarError, String(err));
  } finally {
    fake.setCalendars([
      { id: "AAMkAD-default", name: "Calendar", primary: true },
      { id: STAFF_CAL, name: "First stylist", primary: false },
    ]);
  }
});

await test("a grant without Calendars.ReadWrite is refused, full-URI scopes are understood", async () => {
  assert.deepEqual(outlook.missingOutlookScopes("https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read"), []);
  assert.deepEqual(outlook.missingOutlookScopes("openid profile User.Read"), ["Calendars.ReadWrite"]);
  fake.grant("User.Read openid profile");
  try {
    const err = await rejection(outlook.completeOutlookConnection(spareVenue(), "stub-code", CALLBACK, "user_owner", now));
    assert.ok(err instanceof outlook.OutlookScopeError, String(err));
  } finally {
    fake.grant("Calendars.ReadWrite User.Read profile openid email");
  }
});

// ---------------------------------------------------------------------------
head("Availability is Belline's rules, less what Outlook says is busy");

const { outlookCalendarProvider } = await import("../src/lib/booking/outlook-provider");
const { localProvider, providerFor, requestOnlyProvider } = await import("../src/lib/booking/provider");
const { outlookUsable, takesRequestsOnly } = await import("../src/lib/booking/destination");
const { findAvailability } = await import("../src/lib/booking");
const { addDays, todayIn } = await import("../src/lib/time");
const { zonedInstant } = await import("../src/lib/integrations/google-api");
const iso = (l: Loc, date: string, min: number) => new Date(zonedInstant(date, min, l.timezone)).toISOString();

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

await test("with the flag on and a connection, an Outlook destination gets the Outlook provider; without either, requests", async () => {
  const loc = await connect(salonBase);
  assert.equal(providerFor(loc), outlookCalendarProvider);
  assert.equal(outlookCalendarProvider.name, "outlook");
  assert.equal(takesRequestsOnly(loc), false);
  assert.equal(outlookUsable(loc, {}), false, "flag off in an empty env");
  assert.equal(providerFor({ ...loc, outlook: undefined }), requestOnlyProvider);
  assert.equal(takesRequestsOnly({ ...loc, outlook: undefined }), true);
});

await test("a busy event in Outlook removes the overlapping slot, and only overlapping ones", async () => {
  const loc = getLocation(salonBase.id)!;
  const date = openDay(loc);
  const query = { locationId: loc.id, date, serviceIds: [loc.salon!.services[0].id] };
  const rules = findAvailability(loc, query, { limit: 200 });
  const target = rules[0];
  fake.addBusy("AAMkAD-default", iso(loc, date, target.startMin), iso(loc, date, target.endMin));
  const offered = await outlookCalendarProvider.checkAvailability({ location: loc }, query);
  assert.ok(!offered.some((s) => s.startMin < target.endMin && s.endMin > target.startMin), "an overlapping slot is still offered");
  assert.ok(offered.length > 0, "a busy block took every time away");
  for (const slot of offered) assert.ok(rules.some((r) => r.startMin === slot.startMin && r.staffId === slot.staffId), "Outlook added a time");
});

await test("an event shown as free does not block", async () => {
  const loc = getLocation(salonBase.id)!;
  const query = { locationId: loc.id, date: openDay(loc), serviceIds: [loc.salon!.services[0].id] };
  const before = await outlookCalendarProvider.checkAvailability({ location: loc }, query);
  fake.addBusy("AAMkAD-default", iso(loc, query.date, before[0].startMin), iso(loc, query.date, before[0].endMin), { free: true });
  const after = await outlookCalendarProvider.checkAvailability({ location: loc }, query);
  assert.equal(after.length, before.length);
});

await test("the picker saves a person's own calendar, which blocks only them, and refuses a calendar the account cannot write to", async () => {
  const [first, second] = salonBase.salon!.staff;
  const bad = await outlook.chooseOutlookCalendars(getLocation(salonBase.id)!, { calendarId: "AAMkAD-someone-elses" });
  assert.ok(!bad.ok && /not one your Microsoft account/.test(bad.error));
  const stranger = await outlook.chooseOutlookCalendars(getLocation(salonBase.id)!, { calendarId: "AAMkAD-default", staffCalendars: { staff_nobody: STAFF_CAL } });
  assert.ok(!stranger.ok);
  const picked = await outlook.chooseOutlookCalendars(getLocation(salonBase.id)!, { calendarId: "AAMkAD-default", staffCalendars: { [first.id]: STAFF_CAL } });
  assert.ok(picked.ok);
  if (!picked.ok) return;
  const loc = upsertLocation(picked.location);
  const serviceIds = [loc.salon!.services[0].id];
  let date = "";
  for (let i = 3; i < 60 && !date; i++) {
    const d = addDays(todayIn(loc.timezone), i);
    if (usedDays.has(d)) continue;
    if ([first.id, second.id].every((staffId) => findAvailability(loc, { locationId: loc.id, date: d, serviceIds, staffId }, { limit: 200 }).length > 0)) {
      usedDays.add(d);
      date = d;
    }
  }
  const forPerson = (staffId: string) =>
    outlookCalendarProvider.checkAvailability({ location: getLocation(loc.id)! }, { locationId: loc.id, date, serviceIds, staffId });
  assert.ok(date, "no day in the next two months when both people work");
  const secondBefore = await forPerson(second.id);
  const both = (await forPerson(first.id)).find((s) => secondBefore.some((o) => o.startMin === s.startMin));
  assert.ok(both, "no time where both people are free in the fixture");
  fake.addBusy(STAFF_CAL, iso(loc, date, both!.startMin), iso(loc, date, both!.endMin));
  assert.ok(!(await forPerson(first.id)).some((s) => s.startMin === both!.startMin), "the busy person is still offered");
  assert.ok((await forPerson(second.id)).some((s) => s.startMin === both!.startMin), "the other person lost the time too");
});

// ---------------------------------------------------------------------------
head("Create, update and cancel: idempotency keys and stored event ids");

const liveEventsOf = (bookingId: string) =>
  ["AAMkAD-default", STAFF_CAL].flatMap((calendarId) => fake.events(calendarId).filter((e) => e.bellineBookingId === bookingId).map((e) => ({ calendarId, ...e })));

await test("the same key twice is one event and one booking; Graph's id and the key are stored", async () => {
  const loc = getLocation(salonBase.id)!;
  const date = openDay(loc);
  const query = { locationId: loc.id, date, serviceIds: [loc.salon!.services[0].id] };
  const [slot] = await outlookCalendarProvider.checkAvailability({ location: loc }, query);
  const input = { date, startMin: slot.startMin, guestName: "Layla Haddad", guestPhone: "+971501234567", serviceIds: query.serviceIds, staffId: slot.staffId };
  const creates = fake.calls.filter((c) => c.method === "createEvent").length;
  const one = await outlookCalendarProvider.createBooking({ location: loc }, input, "call_42:book:1");
  assert.ok(one.ok, one.ok ? "" : one.detail);
  if (!one.ok) return;
  const two = await outlookCalendarProvider.createBooking({ location: getLocation(loc.id)! }, input, "call_42:book:1");
  assert.ok(two.ok && two.duplicate && two.booking.id === one.booking.id);
  assert.equal(fake.calls.filter((c) => c.method === "createEvent").length - creates, 1, "a second event was created");
  assert.equal(liveEventsOf(one.booking.id).length, 1);
  assert.equal(one.booking.calendarEventKey, outlook.outlookConnector.keyOf(one.booking));
  assert.equal(one.booking.calendarEventKey, (await import("../src/lib/integrations/calendar-connector")).eventIdFor(loc.id, "call_42:book:1"));
  assert.match(one.booking.calendarEventId!, /^AAMkAD-evt-/, "Graph's id is not stored");
  assert.equal(one.booking.calendarSync?.provider, "outlook");
  const [event] = liveEventsOf(one.booking.id);
  assert.equal(Date.parse(event.start), zonedInstant(date, slot.startMin, loc.timezone), "the event is not at the booking's time");
});

await test("a create whose answer was lost is found by its key on the next try, not made twice", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookingsAt(loc.id).find((b) => b.guestName === "Layla Haddad")!;
  const key = "bl-lost-answer-key-0001";
  fake.failNext("createEvent", 1, { afterWrite: true });
  const lost = await rejection(outlook.outlookConnector.insert(loc, booking, "AAMkAD-default", key));
  assert.ok(lost instanceof msApi.MicrosoftApiError, String(lost));
  const landed = fake.events("AAMkAD-default").filter((e) => e.key === key);
  assert.equal(landed.length, 1, "the fixture did not land the write");
  const creates = fake.calls.filter((c) => c.method === "createEvent").length;
  assert.equal(await outlook.outlookConnector.insert(loc, booking, "AAMkAD-default", key), landed[0].id);
  // And a create-or-replace for the same key replaces it.
  assert.equal(await outlook.outlookConnector.put(loc, booking, "AAMkAD-default", key), landed[0].id);
  assert.equal(fake.calls.filter((c) => c.method === "createEvent").length, creates, "an event with this key was created again");
  await outlook.outlookConnector.remove(loc, booking, { calendarId: "AAMkAD-default", eventId: key });
  assert.equal(fake.events("AAMkAD-default").filter((e) => e.key === key).length, 0);
});

await test("a time taken in Outlook is refused before anything is written", async () => {
  const loc = getLocation(salonBase.id)!;
  const date = openDay(loc);
  const query = { locationId: loc.id, date, serviceIds: [loc.salon!.services[0].id] };
  const [slot] = await outlookCalendarProvider.checkAvailability({ location: loc }, query);
  fake.addBusy("AAMkAD-default", iso(loc, date, slot.startMin), iso(loc, date, slot.endMin));
  fake.addBusy(STAFF_CAL, iso(loc, date, slot.startMin), iso(loc, date, slot.endMin));
  const creates = fake.calls.filter((c) => c.method === "createEvent").length;
  const out = await outlookCalendarProvider.createBooking(
    { location: loc },
    { date, startMin: slot.startMin, guestName: "Omar Saleh", guestPhone: "+971509876543", serviceIds: query.serviceIds, staffId: slot.staffId },
    "call_43:book:1",
  );
  assert.ok(!out.ok && out.reason === "unavailable");
  assert.equal(fake.calls.filter((c) => c.method === "createEvent").length, creates);
});

await test("cancelling deletes the event by its stored Graph id and cancels the booking", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookingsAt(loc.id).find((b) => b.guestName === "Layla Haddad")!;
  const out = await outlookCalendarProvider.cancelBooking({ location: loc }, booking, "Guest asked");
  assert.ok(out.ok);
  assert.ok(fake.calls.some((c) => c.method === "deleteEvent" && c.id === booking.calendarEventId), "not deleted by the stored id");
  assert.deepEqual(liveEventsOf(booking.id), []);
  if (out.ok) assert.equal(out.booking.status, "cancelled");
});

await test("Belline's own events do not block the next table at the same time", async () => {
  const loc = await connect(restaurantBase);
  const date = addDays(todayIn(loc.timezone), 6);
  const query = { locationId: loc.id, date, partySize: 2 };
  const [slot] = await outlookCalendarProvider.checkAvailability({ location: loc }, query);
  assert.ok(slot, "the fixture restaurant has no slot");
  const made = await outlookCalendarProvider.createBooking(
    { location: loc },
    { date, startMin: slot.startMin, guestName: "Sara Khan", guestPhone: "+971501112233", partySize: 2 },
    "call_44:book:1",
  );
  assert.ok(made.ok, made.ok ? "" : made.detail);
  const again = await outlookCalendarProvider.checkAvailability({ location: getLocation(loc.id)! }, query);
  const local = await localProvider.checkAvailability({ location: getLocation(loc.id)! }, query);
  assert.equal(again.length, local.length, "Belline's own event was counted as busy");
});

await test("disconnecting drops the sealed token and the link, puts the venue on requests, and says where to remove Belline at Microsoft", async () => {
  const venue = spareVenue();
  const connected = upsertLocation({
    ...(await outlook.completeOutlookConnection(venue, "stub-code", CALLBACK, "user_owner", now)),
    onboarding: { version: 1, channels: {}, destination: { kind: "outlook", setAt: at } },
  });
  assert.equal(providerFor(connected), outlookCalendarProvider);
  const out = upsertLocation(outlook.disconnectOutlook(connected, now));
  assert.equal(out.outlook, undefined);
  assert.equal(out.onboarding!.destination!.kind, "requests");
  assert.equal(providerFor(out), requestOnlyProvider);
  assert.match(outlook.OUTLOOK_DISCONNECTED_TEXT, /remove Belline/);
  assert.match(source("src/app/api/integrations/microsoft/route.ts"), /export async function DELETE[\s\S]*disconnectOutlook\(location\)[\s\S]*OUTLOOK_DISCONNECTED_TEXT/);
  upsertLocation(venue);
});

await test("Google's provider is the same shared provider, still named google", async () => {
  const { googleCalendarProvider } = await import("../src/lib/booking/google-provider");
  assert.equal(googleCalendarProvider.name, "google");
  assert.match(source("src/lib/booking/google-provider.ts"), /calendarProvider\(\(\) => googleConnector\)/);
});

// ---------------------------------------------------------------------------
head("Bookings made anywhere else reach Outlook: the desk, a guest's link, the sweep");

const { createFromDesk, updateFromDesk } = await import("../src/lib/booking/desk");
const { cancelBooking: cancelLocal, createBooking: createLocal, modifyBooking: modifyLocal } = await import("../src/lib/booking");
const { getBooking } = await import("../src/lib/store");
const sync = await import("../src/lib/integrations/calendar-sync");
const { listExceptions } = await import("../src/lib/exceptions");
const settle = () => sync.settleCalendarSync();

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

await test("a booking taken at the desk becomes an Outlook event, with Graph's id stored, and blocks the time for the agent", async () => {
  const loc = getLocation(salonBase.id)!;
  assert.equal(providerFor(loc), outlookCalendarProvider, "the salon should be booking into Outlook here");
  const [, second] = loc.salon!.staff;
  const { date, startMin } = sharedSlot(loc);
  const out = createFromDesk(loc, { date, startMin, serviceIds: [loc.salon!.services[0].id], staffId: second.id, guestName: "Desk Guest One", guestPhone: "+971500000101" });
  assert.ok(out.ok, out.ok ? "" : out.error);
  if (!out.ok) return;
  await settle();
  const saved = getBooking(out.booking.id)!;
  const events = liveEventsOf(saved.id);
  assert.equal(events.length, 1, `expected one Outlook event for the desk booking, found ${events.length}`);
  assert.equal(events[0].calendarId, "AAMkAD-default");
  assert.equal(saved.calendarEventId, events[0].id, "Graph's id is not stored on the booking");
  assert.equal(saved.calendarEventKey, events[0].key);
  assert.equal(saved.calendarSync?.state, "synced");
  assert.equal(Date.parse(events[0].start), zonedInstant(date, startMin, loc.timezone));
  const offered = await outlookCalendarProvider.checkAvailability(
    { location: getLocation(loc.id)! },
    { locationId: loc.id, date, serviceIds: [loc.salon!.services[0].id], staffId: second.id },
  );
  assert.ok(!offered.some((s) => s.startMin === startMin), "the agent is still offered the desk booking's time");
});

await test("moving it at the desk updates that event by its id; renaming the guest changes its subject; never a second event", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookingsAt(loc.id).find((b) => b.guestName === "Desk Guest One")!;
  const later = findAvailability(loc, { locationId: loc.id, date: booking.date, serviceIds: booking.serviceIds, staffId: booking.staffId, excludeBookingId: booking.id }, { limit: 200 })
    .find((s) => s.startMin > booking.startMin + 60);
  assert.ok(later, "no later time that day to move to");
  const creates = fake.calls.filter((c) => c.method === "createEvent").length;
  assert.ok(updateFromDesk(loc, booking, { startMin: later!.startMin }).ok);
  await settle();
  let events = liveEventsOf(booking.id);
  assert.equal(events.length, 1, `a move left ${events.length} events`);
  assert.equal(events[0].id, booking.calendarEventId, "the move made a new event instead of updating the stored one");
  assert.equal(Date.parse(events[0].start), zonedInstant(booking.date, later!.startMin, loc.timezone), "the event did not move");
  assert.ok(updateFromDesk(getLocation(loc.id)!, getBooking(booking.id)!, { guestName: "Desk Guest Renamed" }).ok);
  await settle();
  events = liveEventsOf(booking.id);
  assert.equal(events.length, 1);
  assert.match(events[0].subject ?? "", /^Desk Guest Renamed/);
  assert.equal(fake.calls.filter((c) => c.method === "createEvent").length, creates);
});

await test("cancelling at the desk deletes the event", async () => {
  const loc = getLocation(salonBase.id)!;
  const booking = listBookingsAt(loc.id).find((b) => b.guestName === "Desk Guest Renamed")!;
  cancelLocal(booking, loc, "Cancelled at the desk");
  await settle();
  assert.deepEqual(liveEventsOf(booking.id), [], "the cancelled desk booking is still an event in Outlook");
});

await test("a guest moving and then cancelling from their manage link: one event that follows, then none", async () => {
  const loc = getLocation(salonBase.id)!;
  const { date, startMin } = sharedSlot(loc);
  const serviceIds = [loc.salon!.services[0].id];
  const made = createLocal(loc, { date, startMin, serviceIds, guestName: "Link Guest", guestPhone: "+971500000102", source: "manual", staffOverride: true });
  assert.ok(made.ok, made.ok ? "" : made.detail);
  if (!made.ok) return;
  await settle();
  assert.equal(liveEventsOf(made.booking.id).length, 1, "the booking never reached Outlook");
  const next = findAvailability(loc, { locationId: loc.id, date, serviceIds, staffId: made.booking.staffId, excludeBookingId: made.booking.id }, { limit: 200 })
    .find((s) => s.startMin !== made.booking.startMin && s.staffId === made.booking.staffId);
  assert.ok(next, "nowhere to move the guest to");
  assert.ok(modifyLocal(getLocation(loc.id)!, getBooking(made.booking.id)!, { date, startMin: next!.startMin }).ok);
  await settle();
  const events = liveEventsOf(made.booking.id);
  assert.equal(events.length, 1);
  assert.equal(Date.parse(events[0].start), zonedInstant(date, next!.startMin, loc.timezone));
  cancelLocal(getBooking(made.booking.id)!, getLocation(loc.id)!, "Cancelled by the guest from their confirmation link");
  await settle();
  assert.deepEqual(liveEventsOf(made.booking.id), []);
});

await test("the agent's own booking is written once: the same booking typed in at the desk adds no second event", async () => {
  const loc = getLocation(salonBase.id)!;
  const { date, startMin } = sharedSlot(loc);
  const serviceIds = [loc.salon!.services[0].id];
  const [, second] = loc.salon!.staff;
  const made = await outlookCalendarProvider.createBooking({ location: loc }, { date, startMin, guestName: "Agent Guest", guestPhone: "+971500000103", serviceIds, staffId: second.id }, "call_60:book:1");
  assert.ok(made.ok, made.ok ? "" : made.detail);
  if (!made.ok) return;
  await settle();
  const desk = createFromDesk(getLocation(loc.id)!, { date, startMin, serviceIds, staffId: second.id, guestName: "Agent Guest", guestPhone: "+971500000103" });
  assert.ok(desk.ok && desk.duplicate);
  await settle();
  assert.equal(liveEventsOf(made.booking.id).length, 1);
});

await test("Outlook failing does not lose the booking: recorded, the owner told, retried with back-off, raised on the second failure", async () => {
  resetCustomerErrors();
  const loc = getLocation(salonBase.id)!;
  const { date, startMin } = sharedSlot(loc);
  const [, second] = loc.salon!.staff;
  fake.failNext("createEvent", 2);
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
  const state = outlook.outlookConnectionState(getLocation(loc.id)!);
  assert.ok(!state.healthy && /Outlook did not accept/.test(state.detail), `the owner is not told: ${state.detail}`);
  assert.equal(listExceptions({ locationId: loc.id, kind: "outlook_sync_failed" }).length, 0, "one blip is not yet the team's problem");

  assert.equal((await sync.retryCalendarSyncs(new Date())).attempted, 0, "retried before the back-off");
  await errorsDuring(() => sync.retryCalendarSyncs(new Date(Date.now() + 2 * 60_000)));
  saved = getBooking(bookingId)!;
  assert.equal(saved.calendarSync?.attempts, 2);
  const raised = listExceptions({ locationId: loc.id, kind: "outlook_sync_failed" });
  assert.equal(raised.length, 1, "a second failure should be in the team's queue");
  assert.equal(listExceptions({ locationId: loc.id, kind: "google_sync_failed" }).length, 0, "raised under Google's name");

  const later = await sync.retryCalendarSyncs(new Date(Date.now() + 60 * 60_000));
  assert.equal(later.synced, 1);
  assert.equal(getBooking(bookingId)!.calendarSync?.state, "synced");
  assert.equal(liveEventsOf(bookingId).length, 1, "the retry did not write the event");
  assert.ok(outlook.outlookConnectionState(getLocation(loc.id)!).healthy, "the owner's warning outlived the fix");
});

// ---------------------------------------------------------------------------
head("Moving a booking to a person with another calendar moves the event");

await test("to a person with their own calendar: deleted from the first, exactly one on the second, and back through the agent", async () => {
  const loc = getLocation(salonBase.id)!;
  const [first, second] = loc.salon!.staff;
  assert.equal(outlook.outlookCalendarFor(loc.outlook!, first.id), STAFF_CAL);
  const { date, startMin } = sharedSlot(loc);
  const serviceIds = [loc.salon!.services[0].id];
  const made = await outlookCalendarProvider.createBooking({ location: loc }, { date, startMin, guestName: "Mover Guest", guestPhone: "+971500000105", serviceIds, staffId: second.id }, "call_61:book:1");
  assert.ok(made.ok, made.ok ? "" : made.detail);
  if (!made.ok) return;
  assert.deepEqual(liveEventsOf(made.booking.id).map((e) => e.calendarId), ["AAMkAD-default"]);

  assert.ok(modifyLocal(getLocation(loc.id)!, getBooking(made.booking.id)!, { staffId: first.id, staffOverride: true }).ok);
  await settle();
  assert.deepEqual(liveEventsOf(made.booking.id).map((e) => e.calendarId), [STAFF_CAL], "after the move");
  assert.equal(getBooking(made.booking.id)!.calendarId, STAFF_CAL);

  const back = await outlookCalendarProvider.rescheduleBooking({ location: getLocation(loc.id)! }, getBooking(made.booking.id)!, { staffId: second.id });
  assert.ok(back.ok, back.ok ? "" : back.detail);
  await settle();
  assert.deepEqual(liveEventsOf(made.booking.id).map((e) => e.calendarId), ["AAMkAD-default"], "after moving back");

  const cancelled = await outlookCalendarProvider.cancelBooking({ location: getLocation(loc.id)! }, getBooking(made.booking.id)!, "Guest asked");
  assert.ok(cancelled.ok);
  await settle();
  assert.deepEqual(liveEventsOf(made.booking.id), []);
});

await test("an old event Outlook would not delete is retried until it is gone, never left as a duplicate", async () => {
  const loc = getLocation(salonBase.id)!;
  const [first, second] = loc.salon!.staff;
  const { date, startMin } = sharedSlot(loc);
  const made = createFromDesk(loc, { date, startMin, serviceIds: [loc.salon!.services[0].id], staffId: second.id, guestName: "Stuck Guest", guestPhone: "+971500000106" });
  assert.ok(made.ok);
  if (!made.ok) return;
  await settle();
  fake.failNext("deleteEvent", 1);
  await errorsDuring(async () => {
    updateFromDesk(getLocation(loc.id)!, getBooking(made.booking.id)!, { staffId: first.id });
    await settle();
  });
  const stuck = getBooking(made.booking.id)!;
  assert.equal(stuck.calendarSync?.state, "failed");
  assert.deepEqual(stuck.calendarSync?.stale, [{ calendarId: "AAMkAD-default", eventId: stuck.calendarEventKey }], "the old event is not recorded for clean-up");
  await sync.retryCalendarSyncs(new Date(Date.now() + 60 * 60_000));
  assert.deepEqual(liveEventsOf(made.booking.id).map((e) => e.calendarId), [STAFF_CAL]);
  assert.equal(getBooking(made.booking.id)!.calendarSync?.stale, undefined);
});

await test("a write that reached Outlook but whose answer was lost is cleaned up when the booking moves again", async () => {
  const loc = getLocation(salonBase.id)!;
  const [first, second] = loc.salon!.staff;
  const booking = listBookingsAt(loc.id).find((b) => b.guestName === "Stuck Guest")!;
  fake.failNext("createEvent", 1, { afterWrite: true });
  await errorsDuring(async () => {
    updateFromDesk(getLocation(loc.id)!, getBooking(booking.id)!, { staffId: second.id });
    await settle();
  });
  assert.equal(getBooking(booking.id)!.calendarSync?.inflight?.calendarId, "AAMkAD-default");
  assert.equal(fake.events("AAMkAD-default").filter((e) => e.bellineBookingId === booking.id).length, 1, "the fixture did not land the write");
  updateFromDesk(getLocation(loc.id)!, getBooking(booking.id)!, { staffId: first.id });
  await settle();
  assert.deepEqual(liveEventsOf(booking.id).map((e) => e.calendarId), [STAFF_CAL], "an orphan was left on the calendar the write reached");
});

await test("changing which calendar a person uses moves their upcoming bookings' events", async () => {
  const loc = getLocation(salonBase.id)!;
  const [first] = loc.salon!.staff;
  const booking = listBookingsAt(loc.id).find((b) => b.guestName === "Stuck Guest")!;
  const picked = await outlook.chooseOutlookCalendars(loc, { calendarId: "AAMkAD-default", staffCalendars: {} });
  assert.ok(picked.ok);
  if (!picked.ok) return;
  sync.resyncMovedCalendars(upsertLocation(picked.location));
  await settle();
  assert.deepEqual(liveEventsOf(booking.id).map((e) => e.calendarId), ["AAMkAD-default"]);
  const back = await outlook.chooseOutlookCalendars(getLocation(loc.id)!, { calendarId: "AAMkAD-default", staffCalendars: { [first.id]: STAFF_CAL } });
  assert.ok(back.ok);
  if (back.ok) sync.resyncMovedCalendars(upsertLocation(back.location));
  await settle();
  assert.deepEqual(liveEventsOf(booking.id).map((e) => e.calendarId), [STAFF_CAL]);
});

await test("a booking last written to Google, at a venue now on Outlook, starts clean: nothing of Google's is asked of Microsoft", async () => {
  const loc = getLocation(salonBase.id)!;
  const { date, startMin } = sharedSlot(loc);
  const made = createLocal(loc, { date, startMin, serviceIds: [loc.salon!.services[0].id], guestName: "Switched Guest", guestPhone: "+971500000109", source: "manual", staffOverride: true });
  assert.ok(made.ok);
  if (!made.ok) return;
  await settle();
  // As if Google had written it: a Google id and calendar, stale Google refs, no provider mark.
  const { saveBooking } = await import("../src/lib/store");
  const googleShaped = saveBooking({
    ...getBooking(made.booking.id)!,
    calendarEventId: "bellinegoogleid",
    calendarId: "primary",
    calendarEventKey: undefined,
    calendarSync: { state: "pending", attempts: 0, rev: 5, stale: [{ calendarId: "primary", eventId: "bellinegoogleid" }] },
  });
  for (const id of fake.events("AAMkAD-default").filter((e) => e.bellineBookingId === googleShaped.id).map((e) => e.id)) {
    await fake.api.deleteEvent(`stub-ms-access-${fake.issued[0]}`, "AAMkAD-default", id);
  }
  const before = fake.calls.length;
  await sync.syncBooking(googleShaped.id);
  const asked = fake.calls.slice(before);
  assert.ok(!asked.some((c) => c.calendarId === "primary"), `Google's calendar was asked of Microsoft: ${JSON.stringify(asked)}`);
  const after = getBooking(googleShaped.id)!;
  assert.equal(after.calendarSync?.state, "synced");
  assert.equal(after.calendarSync?.provider, "outlook");
  assert.equal(liveEventsOf(googleShaped.id).length, 1);
});

// ---------------------------------------------------------------------------
head("An expired token: exception, owner banner, requests, and back after reconnecting");

await test("Microsoft refusing the token marks the link, raises one exception, offers nothing, and falls back to requests", async () => {
  resetCustomerErrors();
  const loc = getLocation(salonBase.id)!;
  assert.equal(providerFor(loc), outlookCalendarProvider);
  fake.expire();
  outlook.setMicrosoftApi(fake.api); // clears the cached access token
  try {
    const query = { locationId: loc.id, date: openDay(loc), serviceIds: [loc.salon!.services[0].id] };
    let offered: unknown[] = ["unset"];
    const lines = await errorsDuring(async () => {
      offered = await outlookCalendarProvider.checkAvailability({ location: loc }, query);
      await outlookCalendarProvider.checkAvailability({ location: loc }, query);
    });
    assert.deepEqual(offered, []);
    assert.equal(lines.filter((l) => l.startsWith(`[exception] outlook:expired:${loc.id}`)).length, 1);
    const after = getLocation(loc.id)!;
    assert.ok(after.outlook!.expiredAt);
    assert.equal(providerFor(after), requestOnlyProvider);
    assert.equal(takesRequestsOnly(after), true);
    const state = outlook.outlookConnectionState(after);
    assert.ok(state.connected && !state.healthy && state.expired);
    assert.equal(state.detail, outlook.OUTLOOK_EXPIRED_TEXT);
    assert.doesNotMatch(state.detail, /invalid_grant|AADSTS|401|token/i);
    const created = await outlookCalendarProvider.createBooking({ location: after }, { date: query.date, startMin: 600, guestName: "Nadia", guestPhone: "+971500000001", serviceIds: query.serviceIds }, "call_45:book:1");
    assert.ok(!created.ok);
    assert.equal(listExceptions({ locationId: loc.id, kind: "outlook_token_expired" }).length, 1, "no outlook_token_expired exception for the team");
  } finally {
    fake.restore();
  }
});

await test("a desk booking while the connection is down is kept and waits; the owner's home banner carries the calendar line", async () => {
  const loc = getLocation(salonBase.id)!;
  const { date, startMin } = sharedSlot(loc);
  const out = createFromDesk(loc, { date, startMin, serviceIds: [loc.salon!.services[0].id], staffId: loc.salon!.staff[1].id, guestName: "While Down", guestPhone: "+971500000107" });
  assert.ok(out.ok, out.ok ? "" : out.error);
  await settle();
  const saved = listBookingsAt(loc.id).find((b) => b.guestName === "While Down")!;
  assert.equal(saved.calendarSync?.state, "pending");
  assert.match(saved.calendarSync?.lastError ?? "", /Waiting for Outlook/);
  assert.equal(liveEventsOf(saved.id).length, 0);
  const { overviewFor, visibleHealth } = await import("../src/lib/overview");
  const line = visibleHealth((await overviewFor(loc)).health, false).find((h) => h.label === "Calendar");
  assert.ok(line && !line.ok && line.detail === outlook.OUTLOOK_EXPIRED_TEXT, `the banner says: ${line?.detail}`);
});

await test("reconnecting keeps the calendars picked and clears the expiry; the sweep then writes what was booked while down", async () => {
  const loc = getLocation(salonBase.id)!;
  const again = upsertLocation(await outlook.completeOutlookConnection(loc, "stub-code", CALLBACK, "user_owner", now));
  assert.equal(again.outlook!.expiredAt, undefined);
  assert.equal(again.outlook!.calendarId, "AAMkAD-default");
  assert.equal(Object.keys(again.outlook!.staffCalendars ?? {}).length, 1);
  assert.equal(providerFor(again), outlookCalendarProvider);
  await sync.sweepCalendars(new Date());
  const booking = listBookingsAt(salonBase.id).find((b) => b.guestName === "While Down")!;
  assert.equal(getBooking(booking.id)!.calendarSync?.state, "synced");
  assert.equal(liveEventsOf(booking.id).length, 1);
});

await test("a wrong client secret is ours: requests, the owner told it is Belline's to fix, the team given the fix, and back once it answers", async () => {
  resetCustomerErrors();
  const loc = getLocation(restaurantBase.id)!;
  assert.equal(providerFor(loc), outlookCalendarProvider);
  fake.failTokens({
    status: 401,
    body: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.", error_codes: [7000215] },
  });
  outlook.setMicrosoftApi(fake.api);
  try {
    const lines = await errorsDuring(async () => {
      const offered = await outlookCalendarProvider.checkAvailability({ location: loc }, { locationId: loc.id, date: addDays(todayIn(loc.timezone), 9), partySize: 2 });
      assert.deepEqual(offered, []);
    });
    const after = getLocation(loc.id)!;
    assert.ok(after.outlook!.misconfiguredAt, "the venue is not marked");
    assert.equal(after.outlook!.expiredAt, undefined, "a bad secret was read as the owner's expired connection");
    assert.equal(providerFor(after), requestOnlyProvider);
    const state = outlook.outlookConnectionState(after);
    assert.equal(state.detail, outlook.OUTLOOK_MISCONFIGURED_TEXT);
    assert.doesNotMatch(state.detail, /AADSTS|secret|client|Entra/i);
    assert.equal(lines.filter((l) => l.startsWith(`[exception] outlook:misconfigured:${loc.id}`)).length, 1);
    const queued = listExceptions({ locationId: loc.id, kind: "outlook_misconfigured" });
    assert.equal(queued.length, 1);
    assert.match(queued[0].reason, /AADSTS7000215[\s\S]*Certificates & secrets/);
    assert.equal((await sync.sweepCalendars(new Date())).recovered, 0, "cleared while Microsoft still refuses");
  } finally {
    fake.failTokens(null);
  }
  assert.equal((await sync.sweepCalendars(new Date())).recovered, 1);
  assert.equal(getLocation(loc.id)!.outlook!.misconfiguredAt, undefined);
  assert.equal(providerFor(getLocation(loc.id)!), outlookCalendarProvider);
});

await test("a connection that never came back is raised once, after ten minutes, with the IT admin's approval link", async () => {
  const venue = spareVenue();
  const started = Date.now();
  outlook.signOutlookState({ locationId: venue.id, userId: "user_owner", returnTo: "setup" }, started);
  const other = outlook.signOutlookState({ locationId: restaurantBase.id, userId: "user_owner", returnTo: "integrations" }, started);
  assert.ok(outlook.verifyOutlookState(other.state, { userId: "user_owner", cookieNonce: other.nonce, now: started }).ok);
  // A Google connection pending at the same time is Google's sweep's, not this one's.
  google.signState({ locationId: venue.id, userId: "user_owner", returnTo: "setup" }, started);
  assert.equal(outlook.sweepAbandonedOutlookConnects(new Date(started + 5 * 60_000)), 0, "raised before the ten minutes were up");
  let raised = 0;
  await errorsDuring(() => {
    raised = outlook.sweepAbandonedOutlookConnects(new Date(started + 11 * 60_000));
  });
  // Other connections this run started and never finished count too.
  assert.ok(raised >= 1);
  assert.equal(listExceptions({ locationId: restaurantBase.id, kind: "outlook_connect_abandoned" }).length, 0, "a connection that came back was raised");
  const queued = listExceptions({ locationId: venue.id, kind: "outlook_connect_abandoned" });
  assert.equal(queued.length, 1);
  assert.match(queued[0].reason, /Need admin approval[\s\S]*login\.microsoftonline\.com\/organizations\/v2\.0\/adminconsent\?client_id=/);
  assert.equal(listExceptions({ locationId: venue.id, kind: "google_connect_abandoned" }).length, 0, "Outlook's sweep took Google's pending row");
  assert.ok(getLocation(venue.id)!.outlookConnectAbandonedAt);
  assert.match(outlook.OUTLOOK_ABANDONED_TEXT, /IT admin/);
  assert.doesNotMatch(outlook.OUTLOOK_ABANDONED_TEXT, /AADSTS|consent|tenant|Entra|OAuth/i);
  const connected = await outlook.completeOutlookConnection(getLocation(venue.id)!, "stub-code", CALLBACK, "user_owner", now);
  assert.equal(connected.outlookConnectAbandonedAt, undefined);
  upsertLocation(venue);
});

await test("a quiet venue's token is refreshed by the sweep before Microsoft idles it out, and the new one kept", async () => {
  const loc = getLocation(salonBase.id)!;
  const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
  upsertLocation({ ...loc, outlook: { ...loc.outlook!, refreshedAt: eightDays } });
  const before = openCredentials(getLocation(loc.id)!.outlook!.sealedToken!).refreshToken;
  fake.revokeOnRotate(true);
  try {
    assert.equal(await outlook.keepOutlookTokensFresh(new Date()), 1);
    const link = getLocation(loc.id)!.outlook!;
    assert.notEqual(openCredentials(link.sealedToken!).refreshToken, before, "the rotated token was not kept");
    assert.ok(Date.parse(link.refreshedAt!) > Date.parse(eightDays));
    assert.equal(await outlook.keepOutlookTokensFresh(new Date()), 0, "refreshed again inside the week");
    outlook.setMicrosoftApi(fake.api);
    await outlook.listOutlookCalendarsFor(getLocation(loc.id)!);
    assert.equal(getLocation(loc.id)!.outlook!.expiredAt, undefined);
  } finally {
    fake.revokeOnRotate(false);
  }
});

await test("the server runs one sweep for both calendars", () => {
  const server = source("server.ts");
  assert.match(server, /import\("\.\/src\/lib\/integrations\/calendar-sync"\)/);
  assert.match(server, /sweepCalendars/);
});

// __MORE__

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

void resetCustomerErrors;
void errorsDuring;
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
