/**
 * The dashboard's finding-and-knowing parts: search, customer profiles and
 * live updates.
 *
 *   npm run check:dashboard
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-dash-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { createUser } = await import("../src/lib/auth");
const { getBooking, getLocation, listBookings, saveBooking } = await import("../src/lib/store");
const { searchEverything } = await import("../src/lib/search");
const { guestKey, guestProfile, searchGuests, updateGuest } = await import("../src/lib/guest-profile");
const { liveStamp } = await import("../src/lib/live");
const { createFromDesk } = await import("../src/lib/booking/desk");
const { findAvailability } = await import("../src/lib/booking");
const { addDays, todayIn } = await import("../src/lib/time");

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

seedIfEmpty();

const made = await signUp({ businessName: "Glow Studio Dubai", email: "owner@glowstudio.test", password: "Correct-Horse-Battery-9", vertical: "salon", timezone: "Asia/Dubai" });
assert.ok(made.ok);
const owner = made.ok ? made.user : null!;
const venueId = made.ok ? made.location.id : "";

// Give the venue a service, a person and hours, so bookings can be taken.
const base = getLocation(venueId)!;
const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ start: 540, end: 1260 }]]));
const { upsertLocation } = await import("../src/lib/store");
upsertLocation({
  ...base,
  // Booked at the desk below, so on the diary, as a pilot account is.
  onboarding: { ...base.onboarding!, destination: { kind: "belline", setAt: new Date().toISOString() } },
  hours,
  salon: {
    ...base.salon!,
    services: [{ id: "svc_cut", name: "Cut", durationMin: 45, bufferMin: 10, price: 180 }],
    staff: [{ id: "stf_layla", name: "Layla", serviceIds: ["svc_cut"], hours, timeOff: [] }],
  },
});
const venue = () => getLocation(venueId)!;

function book(name: string, phone: string, email?: string) {
  const today = todayIn("Asia/Dubai");
  for (let d = 1; d < 10; d++) {
    const date = addDays(today, d);
    const slot = findAvailability(venue(), { locationId: venueId, date, serviceIds: ["svc_cut"], staffOverride: true })[0];
    if (!slot) continue;
    const out = createFromDesk(venue(), { date, startMin: slot.startMin, serviceIds: ["svc_cut"], guestName: name, guestPhone: phone, guestEmail: email });
    if (out.ok) return out.booking;
  }
  throw new Error("could not book");
}

const noor = book("Noor Haddad", "+971 50 111 2233", "noor@example.com");
book("Noor Haddad", "050 111 2233");
const sam = book("Sam Rivers", "+971 55 999 8877");

console.log("\n\x1b[1mSearch (Ctrl+K)\x1b[0m\n");

await test("finds a booking by its reference, first", () => {
  const hits = searchEverything(owner, noor.ref);
  assert.equal(hits[0]?.kind, "booking");
  assert.match(hits[0].href, new RegExp(`open=${noor.id}`));
});

await test("finds a customer by part of their name or number", () => {
  assert.ok(searchEverything(owner, "haddad").some((h) => h.kind === "customer" && h.title === "Noor Haddad"));
  assert.ok(searchEverything(owner, "9998877").some((h) => h.kind === "customer" && h.title === "Sam Rivers"));
});

await test("finds pages, but only the ones this person may open", () => {
  assert.ok(searchEverything(owner, "locat").some((h) => h.kind === "page" && h.href === "/locations"));
  const staff = createUser({ email: "floor@glowstudio.test", name: "Floor", password: "Correct-Horse-Battery-9", role: "staff", tenantId: owner.tenantId });
  assert.ok(staff.ok);
  const theirs = searchEverything(staff.ok ? staff.user : null!, "locat");
  assert.ok(!theirs.some((h) => h.href === "/locations"), "floor staff were offered Locations");
  assert.ok(!searchEverything(staff.ok ? staff.user : null!, "plan").some((h) => h.href === "/billing"));
});

await test("never finds another business's bookings or customers", async () => {
  const other = await signUp({ businessName: "Other Place", email: "owner@otherplace.test", password: "Correct-Horse-Battery-9", vertical: "salon", timezone: "Asia/Dubai" });
  assert.ok(other.ok);
  const hits = searchEverything(other.ok ? other.user : null!, "haddad");
  assert.equal(hits.filter((h) => h.kind !== "page").length, 0);
});

console.log("\n\x1b[1mThe owner's menu\x1b[0m\n");

/**
 * The navigation the founder approved on 2026-09-17.
 *
 * Two things have to stay true at once, and they pull in opposite
 * directions: an owner who never touches a diary is never shown one, and a
 * venue that runs on the diary keeps every page it used yesterday. So the
 * assertions come in that pair, and every page that left the menu is checked
 * for a new home (a tab, a group, or a redirect), never a 404.
 */
const { businessTabs, CHANNEL_TABS, INBOX_TABS, navFor, navItemOn, notOnDiaryHome, SETTINGS_TABS, usesDiary } = await import("../src/lib/nav");

const at = new Date().toISOString();
/** A venue that took the pivot's default: requests, no Belline diary. */
const requestVenue = () => ({ ...venue(), onboarding: { ...venue().onboarding!, destination: { kind: "requests" as const, setAt: at } } });
/** The same venue, on Belline's own diary, as the pilots and fixtures are. */
const diaryVenue = () => ({ ...venue(), onboarding: { ...venue().onboarding!, destination: { kind: "belline" as const, setAt: at } } });
const hrefs = (items: { href: string }[]) => items.map((i) => i.href);
// Billing is its own menu item (founder, f6): "where do I add payment
// details?" has to be answerable from the menu. It keeps its place in
// SETTINGS_TABS, but SETTINGS_MATCH no longer claims it, or Settings and
// Billing would both light up on it.
const OWNER_MENU = ["/", "/requests", "/guests", "/venue", "/channels", "/calendars", "/locations", "/billing"];

await test("an owner's menu is Home, Inbox, Customers, Your business, Channels, Calendars, Settings, Billing", () => {
  const shape = navFor(owner, [requestVenue()], {});
  assert.deepEqual(hrefs(shape.items), OWNER_MENU);
  assert.deepEqual(
    shape.items.map((i) => i.label),
    ["Home", "Inbox", "Customers", "Your business", "Channels", "Calendars", "Settings", "Billing"],
  );
  assert.equal(shape.diary, null, "a request venue was shown the diary");
  assert.equal(shape.staff, null, "a customer was shown Belline's staff tools");
});

await test("a new signup that has not chosen where bookings go is not on the diary", () => {
  const signup = { ...venue(), onboarding: { version: 1 as const, channels: {} } };
  assert.equal(usesDiary(signup), false);
  assert.equal(navFor(owner, [signup], {}).diary, null);
  // A venue from before the journey (no record at all) is, as the backfill says.
  assert.equal(usesDiary({ onboarding: undefined }), true);
});

await test("a venue on Belline's own diary keeps Calendar, Bookings, Waitlist, Recall and Rota", () => {
  const shape = navFor(owner, [diaryVenue()], { dueBack: 3 });
  assert.deepEqual(hrefs(shape.items), OWNER_MENU);
  const diary = hrefs(shape.diary?.items ?? []);
  for (const href of ["/calendar", "/bookings", "/waitlist", "/recall", "/rota"]) {
    assert.ok(diary.includes(href), `${href} is no longer reachable for a venue that runs on the diary`);
  }
  assert.ok(!diary.includes("/floor"), "a salon was offered the restaurant floor plan");
  assert.equal(shape.diary?.items.find((i) => i.href === "/recall")?.badge, 3);
});

await test("the diary fixtures keep their diary", () => {
  for (const id of ["loc_belline", "loc_azure", "loc_lumiere", "loc_meridian"]) {
    const l = getLocation(id);
    if (!l) continue;
    assert.ok(usesDiary(l), `${id} lost its diary`);
  }
});

await test("Bookings is in the menu only when Belline books into a connected calendar", () => {
  assert.ok(!hrefs(navFor(owner, [requestVenue()], {}).items).includes("/bookings"));
  const google = {
    ...venue(),
    onboarding: { ...venue().onboarding!, destination: { kind: "google" as const, setAt: at } },
    google: { sealedToken: "sealed", calendarId: "primary", connectedAt: at } as never,
  };
  const saved = { flag: process.env.FLAG_BOOKING_GOOGLE, id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, key: process.env.CREDENTIALS_KEY };
  Object.assign(process.env, { FLAG_BOOKING_GOOGLE: "on", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", CREDENTIALS_KEY: "k".repeat(64) });
  try {
    const items = hrefs(navFor(owner, [google], {}).items);
    assert.ok(items.includes("/bookings"), "a venue booking into Google has no Bookings");
    assert.equal(navFor(owner, [google], {}).diary, null);
    assert.equal(notOnDiaryHome(google), `/bookings?loc=${google.id}`);
  } finally {
    for (const [k, v] of [["FLAG_BOOKING_GOOGLE", saved.flag], ["GOOGLE_CLIENT_ID", saved.id], ["GOOGLE_CLIENT_SECRET", saved.secret], ["CREDENTIALS_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(notOnDiaryHome(requestVenue()), `/requests?loc=${venueId}`);
});

await test("the retired pages are nowhere in the menu, for anybody", () => {
  for (const locations of [[venue()], [requestVenue()], [diaryVenue()], [requestVenue(), diaryVenue()]]) {
    const shape = navFor(owner, locations, { dueBack: 3 });
    const all = hrefs([...shape.items, ...(shape.diary?.items ?? []), ...(shape.staff?.items ?? [])]);
    for (const href of ["/advanced", "/reports", "/setup", "/demo", "/test", "/golive", "/website", "/integrations", "/prospects"]) {
      assert.ok(!all.includes(href), `${href} is in an owner's menu`);
    }
  }
});

await test("the demo line and Belline's tools are for Belline staff only", async () => {
  // The demo lines moved into the staff console (Settings) on 2026-09-17; /demo redirects there.
  const demo = fs.readFileSync(path.join(process.cwd(), "src", "app", "(internal)", "sales", "settings", "demo-lines", "page.tsx"), "utf8");
  assert.match(demo, /if \(!isBellineStaff\(user\)\) return/, "the demo line opens for customers");
  assert.doesNotMatch(demo, /canManageUsers\(user\)\)/);
  const { getTenant, saveTenant } = await import("../src/lib/store");
  const staffOwner = await signUp({ businessName: "Belline Staff Desk", email: "staff@bellinedesk.test", password: "Correct-Horse-Battery-9", vertical: "salon", timezone: "Asia/Dubai" });
  assert.ok(staffOwner.ok);
  if (!staffOwner.ok) return;
  saveTenant({ ...getTenant(staffOwner.user.tenantId)!, internal: true });
  const staff = navFor(staffOwner.user, [staffOwner.location], {}).staff;
  // One door into the staff console; the demo tools live inside it.
  assert.deepEqual(hrefs(staff?.items ?? []), ["/sales"]);
  assert.ok(!searchEverything(owner, "demo").some((h) => h.href === "/demo"), "search offers a customer the demo line");
});

await test("floor staff get Home, Inbox and Customers, and the diary where there is one", () => {
  const floor = createUser({ email: "nav@glowstudio.test", name: "Nav", password: "Correct-Horse-Battery-9", role: "staff", tenantId: owner.tenantId });
  assert.ok(floor.ok);
  const user = floor.ok ? floor.user : null!;
  assert.deepEqual(hrefs(navFor(user, [requestVenue()], {}).items), ["/", "/requests", "/guests"]);
  const diary = hrefs(navFor(user, [diaryVenue()], {}).diary?.items ?? []);
  assert.ok(diary.includes("/calendar") && !diary.includes("/rota"), "floor staff were offered the rota, or no calendar");
});

await test("each destination is marked current from any of its tabs", () => {
  const items = navFor(owner, [requestVenue()], {}).items;
  const on = (path: string) => items.filter((i) => navItemOn(i, path)).map((i) => i.label);
  assert.deepEqual(on("/"), ["Home"]);
  assert.deepEqual(on("/conversations"), ["Inbox"]);
  assert.deepEqual(on("/calls/call_1"), ["Inbox"]);
  assert.deepEqual(on("/agents"), ["Your business"]);
  assert.deepEqual(on("/venue/rules"), ["Your business"]);
  assert.deepEqual(on("/channels/phone"), ["Channels"]);
  // Exactly one menu item lights up on Billing, now that it has its own.
  assert.deepEqual(on("/billing"), ["Billing"]);
  assert.deepEqual(on("/team"), ["Settings"]);
});

// Three questions the founder asked of the built dashboard (f6/15-17), each of
// which had an answer you could only find by already knowing it.
await test("adding a location, the agent's face and payment details are reachable from where the question is asked", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  // "If I needed to add another location, where and how?" — the row of venue
  // names at the top of every page ends in the way to a new one, and it lands
  // with the form already open. Owners only: only an owner may add one.
  const tabs = read("src/components/LocationTabs.tsx");
  assert.match(tabs, /href="\/locations\?add=1"/);
  assert.match(tabs, /canManageUsers\(user\) \? \(/);
  assert.match(tabs, /Add a location/);
  // Shown for a business with one venue too — that is the whole case.
  assert.match(tabs, /if \(locations\.length === 1\) \{[\s\S]{0,700}\{addLocation\}/);
  const manager = read("src/app/(app)/locations/LocationsManager.tsx");
  assert.match(manager, /useSearchParams\(\)\.get\("add"\) === "1" && canManage && add\.allowed/);

  // "Where can I change the face of the Agent?" — linked from the website
  // settings, and only where that picker is really on the agent page.
  const sections = read("src/app/(app)/channels/sections.tsx");
  assert.match(sections, /facePicker=\{videoSettable\(location\)\}/);
  assert.match(read("src/app/(app)/agents/page.tsx"), /videoSettable\(location\) \? \(/, "the link's condition and the picker's have drifted apart");
  const editor = read("src/app/(app)/website/WidgetEditor.tsx");
  assert.match(editor, /\{facePicker && \(/);
  assert.match(editor, /href="\/agents"/);

  // Billing is its own menu item, not the third tab under something called
  // Settings — and still a neighbour of Locations and Team from those pages.
  const items = navFor(owner, [requestVenue()], {}).items;
  assert.ok(items.some((i) => i.href === "/billing" && i.label === "Billing"), "Billing is not in the menu");
  assert.deepEqual(hrefs(SETTINGS_TABS), ["/locations", "/team", "/billing"]);
});

await test("payment details say what can be done today, and never draw a card form", () => {
  const panel = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "billing", "PaymentDetails.tsx"), "utf8");
  // Three states, each true of itself. The closed one is the one that is true
  // today: billing.stripe is off, so there is nothing to add, and it says so.
  assert.match(panel, /Card payments are not open yet/);
  assert.match(panel, /nothing is being charged/);
  assert.match(panel, /Belline never sees or stores a card number/);
  // No card form in any state: not a field, not a form, nowhere for a card
  // number to be typed into Belline at all.
  assert.doesNotMatch(panel, /<input|<form|autoComplete="cc-|cardNumber|cvc/i, "a card form on a page with no processor behind it");
  const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "billing", "page.tsx"), "utf8");
  assert.match(page, /paymentsOpen=\{stripeEnabled\(\)\}/);
  // On the no-plan page too: "where do I add a card?" comes before a plan.
  assert.equal(page.split("<PaymentDetails").length, 3, "payment details are on only one of the two billing states");
});

await test("the tabs inside each destination are the approved ones", () => {
  assert.deepEqual(hrefs(INBOX_TABS), ["/requests", "/conversations"]);
  assert.deepEqual(hrefs(CHANNEL_TABS), ["/channels", "/channels/website", "/channels/phone", "/channels/link", "/channels/whatsapp"]);
  assert.equal(CHANNEL_TABS[0].label, "Try it");
  assert.deepEqual(hrefs(SETTINGS_TABS), ["/locations", "/team", "/billing"]);
  assert.deepEqual(hrefs(businessTabs(requestVenue())), ["/venue", "/venue/rules", "/agents"]);
  assert.deepEqual(hrefs(businessTabs(diaryVenue())), ["/venue", "/venue/rules", "/agents", "/venue/diary"]);
});

await test("the language settings stay mounted inside the agent editor, which Your business renders", () => {
  const agents = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "agents", "page.tsx"), "utf8");
  assert.match(agents, /<AgentEditor\b/);
  assert.match(agents, /<SectionTabs tabs=\{businessTabs\(location\)\}/);
});

await test("rules are edited in place on the dashboard, never by a link into setup", () => {
  const rules = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "venue", "rules", "page.tsx"), "utf8");
  assert.match(rules, /<RulesForm\s+stay/);
  const actions = fs.readFileSync(path.join(process.cwd(), "src", "app", "setup", "StepActions.tsx"), "utf8");
  assert.match(actions, /if \(stay\) \{[\s\S]*setSaved\(true\);[\s\S]*return;[\s\S]*\}\s*go\(out\.next\);/);
  for (const file of ["nav.ts", "search.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(process.cwd(), "src", "lib", file), "utf8"), /"\/setup\/rules"|"\/setup"[,}]/, `${file} still links into setup`);
  }
});

await test("every retired address redirects to its new home", () => {
  const config = fs.readFileSync(path.join(process.cwd(), "next.config.mjs"), "utf8");
  const routes: [string, string][] = [
    ["/advanced", "/"],
    ["/reports", "/"],
    ["/test", "/channels"],
    ["/website", "/channels/website"],
    ["/golive", "/channels/phone"],
    ["/integrations", "/calendars"],
    ["/settings", "/locations"],
    ["/setup/channels", "/setup/website"],
  ];
  for (const [from, to] of routes) {
    assert.match(config, new RegExp(`source: "${from.replace(/\//g, "\\/")}", destination: "${to.replace(/\//g, "\\/")}"`), `${from} does not redirect to ${to}`);
    // A page left at the old address would never be reached, and would rot.
    const page = path.join(process.cwd(), "src", "app", "(app)", from.slice(1), "page.tsx");
    if (!from.startsWith("/setup")) assert.ok(!fs.existsSync(page), `${from}/page.tsx is still there behind its redirect`);
  }
});

await test("every menu destination and tab is a real route", () => {
  const shape = navFor(owner, [diaryVenue()], {});
  const all = [...shape.items, ...(shape.diary?.items ?? []), ...INBOX_TABS, ...CHANNEL_TABS, ...SETTINGS_TABS, ...businessTabs(diaryVenue())].map((i) => i.href);
  for (const href of new Set(all)) {
    const page = path.join(process.cwd(), "src", "app", "(app)", ...href.split("/").filter(Boolean), "page.tsx");
    assert.ok(fs.existsSync(page), `${href} is in the menu but has no page`);
  }
});

await test("search reaches the diary pages only for a diary account, and the new homes for everybody", async () => {
  assert.ok(searchEverything(owner, "phone").some((h) => h.href === "/channels/phone"));
  assert.ok(searchEverything(owner, "rules").some((h) => h.href === "/venue/rules"));
  // The fixture venue is on the diary, so the rota is found; a request account is never offered it.
  assert.ok(searchEverything(owner, "rota").some((h) => h.href === "/rota"));
  const requests = await signUp({ businessName: "Requests Only Studio", email: "owner@requestsonly.test", password: "Correct-Horse-Battery-9", vertical: "salon", timezone: "Asia/Dubai" });
  assert.ok(requests.ok);
  if (!requests.ok) return;
  upsertLocation({ ...requests.location, onboarding: { ...requests.location.onboarding!, destination: { kind: "requests", setAt: at } } });
  assert.ok(!searchEverything(requests.user, "rota").some((h) => h.href === "/rota"), "a request venue was offered the rota");
  assert.ok(!searchEverything(requests.user, "calend").some((h) => h.href === "/calendar"), "a request venue was offered the calendar");
});

await test("the phone menu lists the same groups as the sidebar", () => {
  const shell = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "layout.tsx"), "utf8");
  assert.match(shell, /<MobileNav items=\{shape\.items\} groups=\{groups\} \/>/);
  assert.match(shell, /<SidebarNav items=\{shape\.items\} groups=\{groups\} \/>/);
  const mobile = fs.readFileSync(path.join(process.cwd(), "src", "components", "MobileNav.tsx"), "utf8");
  assert.match(mobile, /groups\.map/);
});

console.log("\n\x1b[1mCustomer profiles\x1b[0m\n");

await test("one person across differently written numbers is one profile, with every booking", () => {
  const profile = guestProfile(venue(), guestKey("+971501112233"))!;
  assert.ok(profile, "no profile");
  assert.equal(profile.bookings.length, 2);
  assert.equal(profile.email, "noor@example.com");
});

await test("customers can be searched by email too", () => {
  assert.ok(searchGuests(venue(), "noor@exam").some((g) => g.name === "Noor Haddad"));
});

await test("a corrected name and email reach every booking under that number", () => {
  const out = updateGuest(venue(), guestKey("0501112233"), { name: "Noor Al Haddad", email: "noor.h@example.com" });
  assert.ok(out.ok && out.updated === 2, JSON.stringify(out));
  const mine = listBookings({ locationId: venueId }).filter((b) => guestKey(b.guestPhone) === guestKey("0501112233"));
  assert.ok(mine.every((b) => b.guestName === "Noor Al Haddad" && b.guestEmail === "noor.h@example.com"));
  assert.equal(getBooking(sam.id)!.guestName, "Sam Rivers", "someone else was renamed");
});

await test("a bad email or empty name is refused", () => {
  assert.equal(updateGuest(venue(), guestKey("0501112233"), { email: "noor@" }).ok, false);
  assert.equal(updateGuest(venue(), guestKey("0501112233"), { name: "  " }).ok, false);
});

console.log("\n\x1b[1mLive updates\x1b[0m\n");

await test("the stamp is stable until something changes, then moves", () => {
  const first = liveStamp([venue()]);
  assert.equal(liveStamp([venue()]).stamp, first.stamp);
  book("Walk In", "+971 52 000 1111");
  assert.notEqual(liveStamp([venue()]).stamp, first.stamp);
});

await test("a booking Belle took is reported; one taken at the desk is not", () => {
  const before = liveStamp([venue()]).latestFromBelle;
  assert.equal(before, null, "a desk booking was reported as Belle's");
  const desk = book("Phone Guest", "+971 52 000 2222");
  saveBooking({ ...desk, source: "phone" as never, createdAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(liveStamp([venue()]).latestFromBelle?.id, desk.id);
});

console.log("\n\x1b[1mThe signed-in header on a phone\x1b[0m\n");

// Below 860px the sidebar becomes one row: brand, search, Menu, sign out. The
// search button kept its desktop `width: 100%` and `.sidebar > *` forbids
// shrinking, so it claimed the whole row and pushed Menu and Sign out off the
// screen — every signed-in page scrolled 313px sideways at 375px and at 768px.
await test("below 860px the search button shrinks instead of pushing Menu off the screen", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
  const phone = [...css.matchAll(/@media \(max-width: 860px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  const rule = phone.match(/\.sidebar > \.palette-trigger\s*\{([^}]*)\}/);
  assert.ok(rule, "no phone rule for the search button in the 860px blocks");
  assert.match(rule[1], /width:\s*auto/);
  assert.match(rule[1], /flex:\s*1 1 auto/);
  assert.match(rule[1], /min-width:\s*0/);
  assert.match(rule[1], /margin:\s*0/);
});

console.log("\n\x1b[1mText on tinted surfaces stays readable\x1b[0m\n");

// axe measured the grey on the tinted surfaces at 4.34:1 (on --panel-2) and
// 4.04:1 (on --accent-soft), and the venue-type label at 2.55:1 because of an
// opacity. The fix is where the grey is used, never the tokens: --muted is
// Apple's #6E6E73 on purpose (not the lighter #86868B, 3.62:1 on white) and
// must not be lightened.
const shellCss = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const match = shellCss.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[2] : "";
}

await test("the text tokens keep their checked values", () => {
  // Apple look: the app maps onto the shared brand tokens, whose values were
  // checked for contrast (muted 4.66 on the grey band, 4.67 on blue tint;
  // white on blue 4.70). --bl-indigo is kept as an alias of --bl-blue. Hover
  // rows use the grey band: muted is only 4.15 on --bl-sunken.
  const tokensCss = fs.readFileSync(path.join(process.cwd(), "public", "brand", "tokens.css"), "utf8");
  assert.match(shellCss, /--muted:\s*var\(--bl-muted\);/);
  assert.match(shellCss, /--brass:\s*var\(--bl-indigo\);/);
  assert.match(tokensCss, /--bl-muted:\s*#6E6E73;/);
  assert.match(tokensCss, /--bl-blue:\s*#0071E3;/);
  assert.match(shellCss, /--hover:\s*var\(--bl-surface\);/);
  assert.match(tokensCss, /--bl-indigo:\s*var\(--bl-blue\);/);
});

await test("pills, table headers and calendar headings use the darker text on tint", () => {
  for (const selector of [".pill", "th", ".cal-head-sub"]) {
    assert.match(ruleBody(selector), /color:\s*var\(--text-2\)/, `${selector} still uses --muted on a tinted background`);
  }
});

await test("today's day in the week strip and the signed-in panel are readable on their tint", () => {
  assert.match(
    ruleBody(".cal-week-day.on .cal-week-name,\n.cal-week-day.on .cal-week-sub"),
    /color:\s*var\(--text-2\)/,
    "today's week-strip labels still use --muted on --accent-soft",
  );
  assert.match(ruleBody(".who .muted,\n.who button"), /color:\s*var\(--text-2\)/, "the signed-in panel still uses --muted on --panel-2");
});

await test("sign out and the 'needs fixing' details are not grey on a tint", () => {
  const signOut = fs.readFileSync(path.join(process.cwd(), "src", "components", "SignOutButton.tsx"), "utf8");
  assert.doesNotMatch(signOut, /color:\s*"var\(--muted\)"/, "Sign out is still --muted on --panel-2 (4.34:1)");
  const home = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "page.tsx"), "utf8");
  const unwell = home.slice(home.indexOf("{unwell.map("), home.indexOf("{unwell.map(") + 600);
  assert.doesNotMatch(unwell, /className="muted"/, "the red 'needs fixing' panel still sets .muted text on --bad-soft (4.15:1)");
});

await test("the venue type in the location tabs is not faded below AA", () => {
  const tabs = fs.readFileSync(path.join(process.cwd(), "src", "components", "LocationTabs.tsx"), "utf8");
  assert.doesNotMatch(tabs, /opacity:\s*0\.65/, "inactive venue-type label is still at opacity 0.65 (2.55:1)");
});

console.log("\n\x1b[1mZoom, labels and landmarks\x1b[0m\n");

const read = (...parts: string[]) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

await test("people can pinch-zoom; phones get 16px inputs so iOS does not zoom on focus instead", () => {
  assert.doesNotMatch(read("src", "app", "layout.tsx"), /maximumScale/, "maximumScale still blocks zoom");
  assert.match(shellCss, /@media \(pointer: coarse\)\s*\{[^}]*input[^}]*font-size:\s*16px/, "no 16px input rule for touch screens");
});

await test("there is an .sr-only utility for labels only a screen reader needs", () => {
  assert.match(ruleBody(".sr-only"), /clip/);
});

await test("every venue field and cell names its control after its label", () => {
  const fields = read("src", "app", "(app)", "venue", "fields.tsx");
  assert.match(fields, /useId\(\)/, "labels have no stable id");
  assert.match(fields, /aria-labelledby/, "controls are not tied to their label");
});

await test("the login page has a main landmark and a heading", () => {
  const login = read("src", "app", "login", "page.tsx");
  assert.match(login, /<main\b/);
  assert.match(login, /<h1\b/);
});

await test("the setup website box accepts a bare domain and has a name", () => {
  const wizard = read("src", "app", "setup", "SetupWizard.tsx");
  const input = wizard.slice(wizard.indexOf("value={website}") - 200, wizard.indexOf("value={website}") + 500);
  assert.doesNotMatch(input, /type="url"/, "type=url refuses 'marinahair.ae' without https://");
  assert.match(input, /inputMode="url"/);
  assert.match(input, /aria-label=|aria-labelledby=/);
});

await test("the console's number box and the change note have names", () => {
  assert.match(read("src", "app", "(app)", "test", "Console.tsx"), /aria-label="Your number \(optional\)"/);
  assert.match(read("src", "app", "(app)", "venue", "VenueEditor.tsx"), /aria-label="Change note"/);
});

await test("labels and quiet text inside a venue row are readable on its tint", () => {
  // Rows sit on --panel-2, where --muted measures 4.34:1 — 81 failures on /venue.
  assert.match(read("src", "app", "(app)", "venue", "fields.tsx"), /className="field-row"/, "Row has no class to hang the colour on");
  assert.match(ruleBody(".field-row label,\n.field-row .muted"), /color:\s*var\(--text-2\)/);
});

await test("the console's status pill is not grey on its tint", () => {
  assert.doesNotMatch(read("src", "app", "(app)", "test", "Console.tsx"), /color:\s*connected \? "var\(--ok\)" : "var\(--muted\)"/, "status pill is --muted on --panel-2");
});

console.log("\n\x1b[1mLayout at 375\x1b[0m\n");

await test("the Set up with Belle chat stacks on a phone instead of shrinking to 77px", () => {
  const assistant = read("src", "app", "setup", "assistant", "SetupAssistant.tsx");
  assert.doesNotMatch(assistant, /gridTemplateColumns: "minmax\(0, 1fr\) 230px"/, "the grid is still inline, where no media query can reach it");
  assert.match(ruleBody(".setup-assistant"), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*230px/);
  assert.match(shellCss, /@media \(max-width:\s*760px\)\s*\{\s*\.setup-assistant\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(assistant, /role="log"[^>]*tabIndex=\{0\}|tabIndex=\{0\}[^>]*role="log"/, "the scrollable conversation cannot be reached by keyboard");
});

await test("the Go live dial codes are not pushed off a phone screen by the 640px table floor", () => {
  // The codes table moved into the phone flow's client component.
  assert.match(read("src", "app", "(app)", "golive", "PhoneSetup.tsx"), /<table className="forward-table">/);
  assert.match(shellCss, /\.table-wrap > table:not\(\.booking-table\):not\(\.forward-table\)/);
});

console.log("\n\x1b[1mKeyboard focus and the current page\x1b[0m\n");

await test("closing the phone menu with Escape puts focus back on the Menu button, not the page top", () => {
  const nav = read("src", "components", "MobileNav.tsx");
  assert.match(nav, /ref=\{toggleRef\}/, "the toggle has no ref to return focus to");
  assert.match(nav, /toggleRef\.current\?\.focus\(\)/, "Escape closes the menu and drops focus on <body>");
});

await test("the desktop sidebar marks the page you are on", () => {
  assert.match(read("src", "app", "(app)", "layout.tsx"), /<SidebarNav\b/, "the sidebar links are rendered by the server layout, which cannot know the path");
  const sidebar = read("src", "components", "SidebarNav.tsx");
  assert.match(sidebar, /usePathname\(\)/);
  assert.match(sidebar, /aria-current=\{on \? "page" : undefined\}/);
  // Ink + Indigo: the current page is indigo on the indigo tint (7.07:1), where
  // every other link is muted on white.
  const current = ruleBody('.navlink[aria-current="page"]');
  assert.match(current, /background:\s*var\(--accent-soft\)/, "the current page looks like every other link");
  assert.match(current, /color:\s*var\(--accent-hover\)/, "the current page looks like every other link");
});

console.log("\n\x1b[1mWhen the database cannot be reached\x1b[0m\n");

// Inbox and Integrations used to throw straight out of the page on a
// connection error, so a Postgres blip was a 500 for the whole screen. An
// address that can never resolve reproduces that without touching any real
// database.
process.env.DATABASE_URL = "postgres://nobody:nothing@disabled.invalid:5432/none";

await test("the inbox says messages cannot be loaded instead of failing the page", async () => {
  const mod = await import("../src/lib/reception/inbox-view").catch(() => null);
  assert.ok(mod, "src/lib/reception/inbox-view.ts does not exist");
  const view = await mod.loadInbox(owner, undefined);
  assert.equal(view.state, "unavailable");
});

await test("the WhatsApp card says its status could not be checked, not 'Not connected'", async () => {
  const whatsapp = await import("../src/lib/whatsapp");
  assert.equal(typeof (whatsapp as Record<string, unknown>).whatsappStatus, "function", "whatsappStatus is not exported");
  const status = await (whatsapp as unknown as { whatsappStatus: (l: unknown) => Promise<{ state: string }> }).whatsappStatus(venue());
  assert.equal(status.state, "unavailable");
});

await test("with no database configured at all, WhatsApp is simply not connected", async () => {
  delete process.env.DATABASE_URL;
  const whatsapp = await import("../src/lib/whatsapp");
  assert.equal(typeof (whatsapp as Record<string, unknown>).whatsappStatus, "function", "whatsappStatus is not exported");
  const status = await (whatsapp as unknown as { whatsappStatus: (l: unknown) => Promise<{ state: string }> }).whatsappStatus(venue());
  assert.equal(status.state, "none");
});

await (globalThis as { __bellineDbPool?: { end(): Promise<void> } }).__bellineDbPool?.end().catch(() => {});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
