/**
 * Booksy: the check that a gated API is not a usable one.
 *
 * Booksy has an API. Its own documentation host answers 401 to the public,
 * which is the strongest evidence available that one exists — and no help
 * whatever in writing against it. So this check does two jobs.
 *
 * First, the Fresha job: prove that no combination of flags, keys and venue
 * records can make Belline quote a Booksy time or claim a Booksy booking.
 *
 * Second, and the reason this file is longer than Fresha's: pin the trap.
 * Because the real reference is behind a 401, third-party directories publish
 * detailed reconstructions of it — a public-api base URL, an RS256
 * partner-keypair auth flow, exact rate limits — that look official at a
 * glance and are not. They are the most plausible thing a future implementer
 * could build against by mistake. If any of it lands in this repository, this
 * check fails.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches Booksy.
 *
 *   npm run check:booksy
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-booksy-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 15).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_BOOKSY_") || key === "FLAG_BOOKING_PARTNER_BOOKSY" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, listBookings } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const { booksyConnector } = await import("../src/lib/integrations/partners/booksy");
const { PARTNER_PROVIDERS } = await import("../src/lib/booking/partner-providers");
const { providerFor, requestOnlyProvider, localProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { INTEGRATIONS } = await import("./site-integrations");
const { BOOKING_TOOL_NAMES, toolsFor } = await import("../src/lib/agent/tools");
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
const OURS = [
  "src/lib/integrations/partners/booksy.ts",
  "src/lib/integrations/partners/registry.ts",
  "docs/integrations/partners.md",
];

seedIfEmpty();
const salon = listLocations().find((l) => l.vertical === "salon" && !l.internal)!;
const facts = PARTNERS.booksy;

const venue = (): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "booksy", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: { booksy: { venueId: "booksy-venue-1", sealedToken: "sealed" } },
  }) as Loc;

/** Everything somebody could set, believing it would switch Booksy on. */
const EVERYTHING = {
  FLAG_STUBS: "on",
  FLAG_BOOKING_PARTNER_BOOKSY: "on",
  PARTNER_BOOKSY_API_KEY: "a-key",
  PARTNER_BOOKSY_ENV: "live",
  PARTNER_BOOKSY_BASE_URL: "https://api.booksy.com/",
};

// ---------------------------------------------------------------------------
head("An API exists, and nothing about it is public");

await test("no readable API means no claimed operation", () => {
  assert.equal(facts.api.documented, false);
  assert.equal(facts.api.availability, false);
  assert.equal(facts.api.create, false);
  assert.equal(facts.api.reschedule, false);
  assert.equal(facts.api.cancel, false);
  assert.equal(facts.sandbox, "none");
  assert.equal(facts.liveNeeds.length, 0, "credentials are listed for an API nobody can read");
});

await test("the 401 is recorded, because it is the difference between Booksy and Fresha", () => {
  // Fresha has nothing to ask for. Booksy has a documentation account to ask
  // for, which is a much smaller and more answerable request.
  assert.match(facts.gate.what, /401|gated/i);
  assert.match(facts.gate.what, /documentation account/i);
  assert.equal(facts.gate.apply, undefined, "an application URL is recorded for a programme that does not exist");
  assert.ok(facts.limits.some((l) => /no application route/i.test(l)), "that there is no form to fill in is not recorded");
});

await test("no adapter code was written against a guessed endpoint", () => {
  const code = source("src/lib/integrations/partners/booksy.ts");
  assert.ok(!/fetch\(|httpTransport|path:/.test(code), "Booksy has an HTTP client for an API nobody can read");
  assert.match(code, /closedConnector/);
});

// ---------------------------------------------------------------------------
head("The reconstructions are not the API");

/**
 * The trap has to be *named* somewhere or the next person re-finds it cold and
 * believes it — that is what the SevenRooms warning is for, and this is the
 * same shape. So the rule is not "these words never appear": it is that they
 * appear only where they are being warned about, and nowhere else at all.
 */
const INVENTED = [/public-api/i, /RS256/];

await test("the reconstruction is named as a warning, so nobody re-finds it and trusts it", () => {
  const warning = source("src/lib/integrations/partners/booksy.ts");
  for (const guess of INVENTED) {
    assert.ok(guess.test(warning), `the warning no longer describes what to distrust: ${guess}`);
  }
  assert.match(warning, /reconstruction/i, "the third-party guesses are not labelled as reconstructions");
  assert.match(warning, /None of it is Booksy's/i, "the warning does not say whose they are not");
});

await test("the registry names it only where Booksy is being warned about", () => {
  const registry = source("src/lib/integrations/partners/registry.ts");
  const from = registry.indexOf("Booksy: a documentation site");
  assert.ok(from > 0, "Booksy's entry has lost the comment this check anchors on");
  // The entry ends where its own object literal closes, whatever is added after it.
  const to = registry.indexOf("\n  },", registry.indexOf("booksy: {", from));
  assert.ok(to > from, "Booksy's entry could not be bounded");
  const entry = registry.slice(from, to);
  const elsewhere = registry.replace(entry, "");
  for (const guess of INVENTED) {
    assert.ok(guess.test(entry), `Booksy's own entry no longer warns about ${guess}`);
    assert.ok(!guess.test(elsewhere), `another partner's entry quotes Booksy's reconstructed docs: ${guess}`);
  }
});

await test("nothing outside those two places is built against a third party's guess at Booksy's reference", () => {
  // Each of these is from an independent API directory reconstructing a page
  // its author could not open. They look official and they are not.
  const allowed = new Set([
    "src/lib/integrations/partners/booksy.ts",
    "src/lib/integrations/partners/registry.ts",
    "scripts/check-booksy.ts",
  ]);
  const files = [
    ...fs.readdirSync(path.join(ROOT, "src/lib/integrations/partners")).map((f) => `src/lib/integrations/partners/${f}`),
    ...fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => f.endsWith(".ts")).map((f) => `scripts/${f}`),
  ].filter((f) => !allowed.has(f));
  for (const file of files) {
    const text = source(file);
    for (const guess of INVENTED) {
      assert.ok(!guess.test(text), `${file} quotes a third party's reconstruction of Booksy's gated docs: ${guess}`);
    }
  }
});

await test("no adapter anywhere holds a Booksy endpoint, a base URL or a token exchange", () => {
  const code = source("src/lib/integrations/partners/booksy.ts")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join("\n");
  for (const guess of [...INVENTED, /booksy\.com/i, /\/token\//]) {
    assert.ok(!guess.test(code), `Booksy's adapter has code built against a guess: ${guess}`);
  }
});

await test("no Booksy developer portal is cited, because none of them is one", () => {
  // developers.booksy.com and api.booksy.com resolve only to redirect to the
  // consumer marketplace; docs.booksy.com is the 401 and may be named as such.
  for (const file of OURS) {
    const text = source(file);
    assert.ok(!/https?:\/\/(developers|api)\.booksy\.com/.test(text), `${file} cites a Booksy developer site that is a redirect`);
  }
});

// ---------------------------------------------------------------------------
head("Nothing can switch it on");

await test("every flag, key and setting at once still leaves it unconnected", () => {
  assert.equal(booksyConnector.usable(venue(), EVERYTHING), false);
  assert.equal(booksyConnector.apiFor(venue(), EVERYTHING), null);
  assert.equal(partnerLive("booksy", EVERYTHING), false);
});

await test("a Booksy salon takes requests, and the agent has no tool that could book", () => {
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "Booksy fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("the provider refuses in words, and no booking is left behind", async () => {
  const provider = PARTNER_PROVIDERS.booksy;
  const ctx = { location: venue() };
  const before = listBookings({ locationId: salon.id }).length;
  assert.deepEqual(await provider.checkAvailability(ctx, { locationId: salon.id, date: "2026-09-21" }), []);
  const made = await provider.createBooking(ctx, {
    date: "2026-09-21",
    startMin: 10 * 60,
    guestName: "Layla",
    guestPhone: "+971501234567",
    serviceIds: ["svc-1"],
  });
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.detail, /Booksy cannot take a booking/);
  assert.match(made.detail, /message/i);
  assert.equal(listBookings({ locationId: salon.id }).length, before);
});

await test("Booksy is not on the website's strip", () => {
  assert.equal(INTEGRATIONS.some((i) => i.flag === "booking.partner.booksy"), false);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
