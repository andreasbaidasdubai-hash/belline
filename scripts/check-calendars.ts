/**
 * The Calendars page (founder feedback item 9), against a fake Google and a
 * fake Microsoft.
 *
 * Owners come back from Google or Microsoft to /calendars with the same query
 * as before, or to setup when they started there; the people a calendar venue
 * books with can be added, renamed and removed without that venue turning into
 * a diary venue; who uses which calendar is checked against what the account
 * can write to, and a person removed takes their mapping with them; and the
 * Bookings page answers each kind of venue differently.
 *
 * Every outbound fetch is blocked for the whole run.
 *
 *   npm run check:calendars
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-calendars-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.FLAG_STUBS = "on";
process.env.FLAG_BOOKING_GOOGLE = "on";
process.env.FLAG_BOOKING_OUTLOOK = "on";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.MICROSOFT_CLIENT_ID;
delete process.env.MICROSOFT_CLIENT_SECRET;

const { installFetchGuard, blockedFetches, fakeGoogleApi, fakeMicrosoftApi } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listLocations, upsertLocation } = await import("../src/lib/store");
const google = await import("../src/lib/integrations/google");
const outlook = await import("../src/lib/integrations/outlook");
const { signOAuthState, verifyOAuthState } = await import("../src/lib/integrations/oauth-state");
const { canEditCalendarPeople, changeCalendarPeople } = await import("../src/lib/integrations/calendar-people");
const { destinationOf, onBellineDiary, takesRequestsOnly } = await import("../src/lib/booking/destination");
const { googleCalendarProvider } = await import("../src/lib/booking/google-provider");
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

seedIfEmpty();
const now = new Date("2026-09-15T10:00:00.000Z");
const at = now.toISOString();
const venues = listLocations().filter((l) => !l.internal);
const salons = venues.filter((l) => l.vertical !== "restaurant" && (l.salon?.services.length ?? 0) > 0);
assert.ok(salons.length >= 2, "the fixture needs two appointment venues");
const [googleBase, outlookBase] = salons;
const restaurantBase = venues.find((l) => l.vertical === "restaurant")!;

const fakeG = fakeGoogleApi({
  calendars: [
    { id: "primary", name: "Main calendar", primary: true },
    { id: "sam@group.calendar.google.com", name: "Sam", primary: false },
  ],
});
google.setGoogleApi(fakeG.api);
const fakeM = fakeMicrosoftApi({
  calendars: [
    { id: "AAMkAD-default", name: "Calendar", primary: true },
    { id: "AAMkAD-sam", name: "Sam", primary: false },
  ],
});
outlook.setMicrosoftApi(fakeM.api);

/**
 * A venue that books into its calendar, set up after the pivot: a journey
 * record naming the calendar, and nobody on the team list yet.
 */
async function calendarVenue(base: Loc, kind: "google" | "outlook"): Promise<Loc> {
  const bare: Loc = {
    ...base,
    salon: { ...base.salon!, staff: [] },
    onboarding: { version: 1, channels: {}, activatedAt: at, destination: { kind, setAt: at } },
  };
  const linked =
    kind === "google"
      ? await google.completeConnection(bare, "stub-code", "http://localhost:3000/api/integrations/google", "user_owner", now)
      : await outlook.completeOutlookConnection(bare, "stub-code", "http://localhost:3000/api/integrations/microsoft", "user_owner", now);
  return upsertLocation(linked);
}

const ok = <T extends { ok: boolean }>(out: T): Extract<T, { ok: true }> => {
  assert.ok(out.ok, JSON.stringify(out));
  return out as Extract<T, { ok: true }>;
};

// ---------------------------------------------------------------------------
head("Back from Google or Microsoft: /calendars, or setup when it started there");

await test("a connection started on the Calendars page returns there, with connected=1 or the error code", () => {
  assert.equal(google.returnPath("calendars", "loc_1", "connected"), "/calendars?loc=loc_1&connected=1");
  assert.equal(google.returnPath("calendars", "loc_1", "google_failed"), "/calendars?loc=loc_1&error=google_failed");
  assert.equal(google.returnPath("calendars", undefined, "google_failed"), "/calendars?error=google_failed");
  assert.equal(outlook.outlookReturnPath("calendars", "loc_1", "connected"), "/calendars?loc=loc_1&connected=1");
  assert.equal(outlook.outlookReturnPath("calendars", "loc_1", "outlook_admin_approval"), "/calendars?loc=loc_1&error=outlook_admin_approval");
  assert.equal(outlook.outlookReturnPath("calendars", "loc_1", "declined"), "/calendars?loc=loc_1&error=outlook_declined");
});

await test("a connection started on the setup step still returns to setup", () => {
  assert.equal(google.returnPath("setup", "loc_1", "connected"), "/setup/bookings?google=connected");
  assert.equal(outlook.outlookReturnPath("setup", "loc_1", "declined"), "/setup/bookings?outlook=declined");
  for (const route of ["src/app/api/integrations/google/route.ts", "src/app/api/integrations/microsoft/route.ts"]) {
    const text = source(route);
    assert.match(text, /url\.searchParams\.get\("from"\) === "setup" \? "setup" : "calendars"/, route);
    assert.doesNotMatch(text, /"integrations"/, route);
  }
});

await test("a state signed before the move, naming /integrations, lands on /calendars", () => {
  for (const provider of ["google", "outlook"] as const) {
    const legacy = signOAuthState(provider, { locationId: googleBase.id, userId: "user_owner", returnTo: "integrations" as never });
    const checked = verifyOAuthState(provider, legacy.state, { userId: "user_owner", cookieNonce: legacy.nonce });
    assert.deepEqual(checked, { ok: true, locationId: googleBase.id, returnTo: "calendars" });
    const setup = signOAuthState(provider, { locationId: googleBase.id, userId: "user_owner", returnTo: "setup" });
    assert.equal(verifyOAuthState(provider, setup.state, { userId: "user_owner", cookieNonce: setup.nonce }).ok && "setup", "setup");
  }
});

await test("nothing sends an owner to /integrations for a calendar or a deposit any more", () => {
  assert.match(source("src/app/api/payments/connect/route.ts"), /\/calendars\?loc=\$\{encodeURIComponent\(location\.id\)\}&payments=1/);
  for (const file of ["src/lib/integrations/google.ts", "src/lib/integrations/outlook.ts", "src/app/api/payments/connect/route.ts"]) {
    assert.doesNotMatch(source(file), /`\/integrations\?|\/integrations\?loc/, file);
  }
});

// ---------------------------------------------------------------------------
head("The pages: what moved, who may see it");

await test("the Calendars page is for owners and managers, with the notices, sections and rules that moved", () => {
  const page = source("src/app/(app)/calendars/page.tsx");
  assert.match(page, /if \(!canEditAgent\(user, location\.id\)\) notFound\(\)/);
  assert.match(page, /integrationErrorText\(error\)/);
  for (const moved of ["GOOGLE_ABANDONED_TEXT", "GOOGLE_EXPIRED_TEXT", "OUTLOOK_ADMIN_APPROVAL_TEXT", "OUTLOOK_ABANDONED_TEXT", "PARTNER_GATED", "Belline uses one calendar per venue", "<RemindersForm", "Deposits", "After a booking"]) {
    assert.ok(page.includes(moved), moved);
  }
  // Reminders and deposits only where a booking is made, or a deposit rule exists.
  assert.match(page, /const afterBooking = !takesRequestsOnly\(venue\) \|\| Boolean\(venue\.policy\?\.deposit\)/);
  // Before going live the choice is the setup step's; a live venue's switch posts the setup action.
  assert.match(page, /href="\/setup\/bookings"/);
  assert.match(source("src/app/(app)/calendars/DestinationSwitch.tsx"), /\/api\/setup\/journey[\s\S]{0,200}action: "destination"/);
});

await test("the Integrations page is gone: calendars at /calendars, WhatsApp under Channels", () => {
  // 2026-09-17: the last thing on it, the WhatsApp card, moved to Channels → WhatsApp.
  assert.ok(!fs.existsSync(path.join(ROOT, "src", "app", "(app)", "integrations", "page.tsx")), "the integrations page is still there");
  assert.match(source("next.config.mjs"), /source: "\/integrations", destination: "\/calendars"/);
  assert.match(source("src/app/(app)/channels/sections.tsx"), /<WhatsAppCard/);
  const whatsapp = source("src/app/(app)/channels/whatsapp/page.tsx");
  for (const gone of ["Google", "Outlook", "RemindersForm", "Deposits", "PARTNER_GATED", "Fresha"]) {
    assert.ok(!whatsapp.includes(gone), `${gone} is on the WhatsApp tab`);
  }
});

await test("the Bookings page branches on the destination: diary table, calendar list, or Requests", () => {
  const page = source("src/app/(app)/bookings/page.tsx");
  const branch = page.indexOf("if (!onBellineDiary(location))");
  assert.ok(branch > 0, "no diary branch");
  assert.ok(branch < page.indexOf("listBookings({ locationId: location.id })"), "the diary query runs before the branch");
  assert.match(page, /kind === "google" && googleUsable\(location\)\) return <CalendarBookings location=\{location\} service="google" \/>/);
  assert.match(page, /kind === "outlook" && outlookUsable\(location\)\) return <CalendarBookings location=\{location\} service="outlook" \/>/);
  assert.match(page, /redirect\(`\/requests\?loc=\$\{encodeURIComponent\(location\.id\)\}`\)/);
  const list = source("src/app/(app)/bookings/CalendarBookings.tsx");
  assert.match(list, /sort\(\(a, b\) => b\.createdAt\.localeCompare\(a\.createdAt\)\)/);
  assert.match(list, /href=\{`\/calls\/\$\{call\.id\}`\}/);
  assert.match(list, /has not booked anything into your/);
});

// ---------------------------------------------------------------------------
head("People on a calendar venue");

let gVenue: Loc;

await test("adding a person gives the engine a bookable record and does not turn the diary on", async () => {
  gVenue = await calendarVenue(googleBase, "google");
  assert.equal(onBellineDiary(gVenue), false);
  assert.ok(canEditCalendarPeople(gVenue));
  const added = ok(changeCalendarPeople(gVenue, { action: "add", name: "  Sam   Lee " })).location;
  const sam = added.salon!.staff.find((s) => s.name === "Sam Lee");
  assert.ok(sam, "Sam was not added");
  assert.deepEqual(sam!.serviceIds, gVenue.salon!.services.map((s) => s.id));
  assert.deepEqual(sam!.hours, gVenue.hours);
  assert.deepEqual(sam!.timeOff, []);
  // Where bookings go is untouched, and so is every diary gate.
  assert.equal(onBellineDiary(added), false);
  assert.equal(destinationOf(added), "google");
  assert.deepEqual(added.onboarding, gVenue.onboarding);
  gVenue = upsertLocation(added);
  const again = ok(changeCalendarPeople(gVenue, { action: "add", name: "Alex" })).location;
  gVenue = upsertLocation(again);
  assert.equal(gVenue.salon!.staff.length, 2);
});

await test("the calendar provider offers times with a person added here", async () => {
  const loc = getLocation(gVenue.id)!;
  const serviceIds = [loc.salon!.services.find((s) => s.durationMin > 0 && s.online !== false && !s.addOnOnly && !s.role)!.id];
  let offered = 0;
  for (let i = 1; i < 14 && offered === 0; i++) {
    const date = addDays(todayIn(loc.timezone), i);
    offered = (await googleCalendarProvider.checkAvailability({ location: loc }, { locationId: loc.id, date, serviceIds })).length;
  }
  assert.ok(offered > 0, "no time offered in two weeks with people on the list");
});

await test("names are checked: empty, too long and a second of the same name are refused", () => {
  assert.equal(changeCalendarPeople(gVenue, { action: "add", name: "   " }).ok, false);
  assert.equal(changeCalendarPeople(gVenue, { action: "add", name: "x".repeat(61) }).ok, false);
  const dup = changeCalendarPeople(gVenue, { action: "add", name: "sam lee" });
  assert.ok(!dup.ok && /already on the list/.test(dup.error));
  const alex = gVenue.salon!.staff.find((s) => s.name === "Alex")!;
  assert.equal(changeCalendarPeople(gVenue, { action: "rename", staffId: alex.id, name: "Sam Lee" }).ok, false);
  const renamed = ok(changeCalendarPeople(gVenue, { action: "rename", staffId: alex.id, name: "Alex Morgan" })).location;
  assert.equal(renamed.salon!.staff.find((s) => s.id === alex.id)!.name, "Alex Morgan");
  assert.equal(changeCalendarPeople(gVenue, { action: "remove", staffId: "stf_nobody" }).ok, false);
});

await test("a diary venue and a restaurant cannot edit people here", () => {
  const diary = { ...googleBase, google: gVenue.google };
  assert.equal(onBellineDiary(diary), true);
  assert.equal(canEditCalendarPeople(diary), false);
  const refused = changeCalendarPeople(diary, { action: "add", name: "Someone" });
  assert.ok(!refused.ok && /Venue page/.test(refused.error));
  const restaurant = { ...restaurantBase, google: gVenue.google, onboarding: gVenue.onboarding };
  assert.equal(changeCalendarPeople(restaurant, { action: "add", name: "Someone" }).ok, false);
  const unlinked = { ...gVenue, google: undefined };
  assert.equal(changeCalendarPeople(unlinked, { action: "add", name: "Someone" }).ok, false);
});

// ---------------------------------------------------------------------------
head("Who uses which calendar");

await test("Google: a person's calendar is saved; an unknown calendar or a stranger is refused", async () => {
  const sam = gVenue.salon!.staff.find((s) => s.name === "Sam Lee")!;
  const unknown = await google.chooseCalendars(getLocation(gVenue.id)!, { calendarId: "primary", staffCalendars: { [sam.id]: "not-theirs@group.calendar.google.com" } });
  assert.ok(!unknown.ok && /not one your Google account/.test(unknown.error));
  const stranger = await google.chooseCalendars(getLocation(gVenue.id)!, { calendarId: "primary", staffCalendars: { stf_nobody: "sam@group.calendar.google.com" } });
  assert.ok(!stranger.ok);
  const saved = await google.chooseCalendars(getLocation(gVenue.id)!, { calendarId: "primary", staffCalendars: { [sam.id]: "sam@group.calendar.google.com" } });
  gVenue = upsertLocation(ok(saved).location);
  assert.deepEqual(gVenue.google!.staffCalendars, { [sam.id]: "sam@group.calendar.google.com" });
  assert.equal(google.calendarFor(gVenue.google!, sam.id), "sam@group.calendar.google.com");
});

await test("Google: removing a person clears their calendar, and the last person cannot go while the venue books", () => {
  const sam = gVenue.salon!.staff.find((s) => s.name === "Sam Lee")!;
  const removed = ok(changeCalendarPeople(getLocation(gVenue.id)!, { action: "remove", staffId: sam.id })).location;
  assert.ok(!removed.salon!.staff.some((s) => s.id === sam.id));
  assert.deepEqual(removed.google!.staffCalendars, {});
  assert.equal(google.calendarFor(removed.google!, sam.id), "primary");
  gVenue = upsertLocation(removed);
  const last = gVenue.salon!.staff[0];
  assert.equal(takesRequestsOnly(gVenue), false);
  const refused = changeCalendarPeople(gVenue, { action: "remove", staffId: last.id });
  assert.ok(!refused.ok && /keep at least one/.test(refused.error));
  // Taking requests, nobody is booked, so the list may be emptied.
  const onRequests = { ...gVenue, onboarding: { ...gVenue.onboarding!, destination: { kind: "requests" as const, setAt: at } } };
  assert.equal(changeCalendarPeople(onRequests, { action: "remove", staffId: last.id }).ok, true);
});

await test("Outlook: the same mapping, and removing a person clears it", async () => {
  let oVenue = await calendarVenue(outlookBase, "outlook");
  oVenue = upsertLocation(ok(changeCalendarPeople(oVenue, { action: "add", name: "Sam" })).location);
  oVenue = upsertLocation(ok(changeCalendarPeople(oVenue, { action: "add", name: "Jo" })).location);
  const sam = oVenue.salon!.staff.find((s) => s.name === "Sam")!;
  const unknown = await outlook.chooseOutlookCalendars(oVenue, { calendarId: "AAMkAD-default", staffCalendars: { [sam.id]: "AAMkAD-elsewhere" } });
  assert.equal(unknown.ok, false);
  oVenue = upsertLocation(ok(await outlook.chooseOutlookCalendars(oVenue, { calendarId: "AAMkAD-default", staffCalendars: { [sam.id]: "AAMkAD-sam" } })).location);
  assert.equal(outlook.outlookCalendarFor(oVenue.outlook!, sam.id), "AAMkAD-sam");
  const removed = ok(changeCalendarPeople(oVenue, { action: "remove", staffId: sam.id })).location;
  assert.deepEqual(removed.outlook!.staffCalendars, {});
  assert.equal(removed.google, undefined, "a Google link appeared on an Outlook venue");
  assert.equal(onBellineDiary(removed), false);
});

await test("the people route checks the role, and moves a removed person's bookings to the venue calendar", () => {
  const route = source("src/app/api/calendars/people/route.ts");
  assert.match(route, /!canEditAgent\(auth\.user, location\.id\)/);
  assert.match(route, /if \(change\.action === "remove"\) resyncMovedCalendars\(saved\)/);
  // The picker is shown only with a usable calendar, and the people list only for appointments.
  const page = source("src/app/(app)/calendars/page.tsx");
  assert.match(page, /googleUsable\(googleVenue\) && googleVenue\.google && \(\s*<CalendarControls/);
  assert.match(page, /outlookUsable\(venue\) && venue\.outlook && \(\s*<CalendarControls/);
  assert.match(page, /const mapsPeople = venue\.vertical !== "restaurant"/);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
