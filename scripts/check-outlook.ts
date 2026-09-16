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
const { getLocation, listLocations, upsertLocation } = await import("../src/lib/store");
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

// __MORE__

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

void resetCustomerErrors;
void errorsDuring;
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
