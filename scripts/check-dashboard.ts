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
// opacity. The fix is where the grey is used, never the tokens: brass and
// --muted were darkened on purpose and must not be lightened back.
const shellCss = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const match = shellCss.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[2] : "";
}

await test("the text tokens keep their checked values", () => {
  // Direction C: the app maps onto the shared brand tokens, whose values were
  // checked for contrast (stone 4.56 on brass tint, desk brass 4.99 on it).
  const tokensCss = fs.readFileSync(path.join(process.cwd(), "public", "brand", "tokens.css"), "utf8");
  assert.match(shellCss, /--muted:\s*var\(--bl-stone\);/);
  assert.match(shellCss, /--brass:\s*var\(--bl-brass-desk\);/);
  assert.match(tokensCss, /--bl-stone:\s*#6E6961;/);
  assert.match(tokensCss, /--bl-brass-desk:\s*#7E5E28;/);
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
  assert.match(read("src", "app", "(app)", "golive", "page.tsx"), /<table className="forward-table">/);
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
  assert.match(ruleBody('.navlink[aria-current="page"]'), /color:\s*var\(--text\)/, "the current page looks like every other link");
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
