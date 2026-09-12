/**
 * Belline on somebody else's website.
 *
 * A public widget that spends money on every tap. The things worth pinning are
 * all about who is allowed to make it spend.
 *
 * The key is public by design — it sits in the customer's page source — so
 * none of the safety here depends on it staying secret. What does the work is
 * the origin allowlist and the daily cap, and both are tested for the ways
 * they fail *open*: an empty list allowing everything, a missing origin being
 * treated as ours, `www.` counting as a different site, a cap that counts the
 * wrong calls.
 *
 * There is also one property that would be easy to lose later: turning the
 * widget on for a customer's venue must not make that venue's *telephone*
 * behave like a demo line, and the venue's telephone being busy must not
 * switch the website widget off. Separate channels, separate budgets.
 *
 *   npm run check:embed
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-embed-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, saveCall } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const {
  enableEmbed,
  disableEmbed,
  originAllowed,
  normaliseOrigin,
  checkEmbedGate,
  embedSnippet,
  newEmbedKey,
  EMBED_DEFAULTS,
} = await import("../src/lib/embed");
const { mayStreamTo } = await import("../src/lib/voice/entitlement");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");

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

const signed = await signUp({
  businessName: "Marina Hair Studio",
  email: "owner@embedtest.test",
  password: "Correct-Horse-Battery-9",
  vertical: "salon",
  timezone: "Asia/Dubai",
});
assert.ok(signed.ok, "could not create the test account");
let venue = signed.ok ? signed.location : null!;

console.log("\n\x1b[1mOff until somebody turns it on\x1b[0m\n");

await test("a new venue has no widget and cannot be streamed to", () => {
  assert.equal(venue.embed, undefined);
  assert.equal(mayStreamTo(venue), false, "a customer's venue was streamable before it was enabled");
});

await test("a key is public, prefixed and not guessable", () => {
  const keys = new Set(Array.from({ length: 200 }, () => newEmbedKey()));
  assert.equal(keys.size, 200, "keys collided");
  for (const key of keys) {
    assert.ok(key.startsWith("be_"));
    assert.ok(key.length >= 14, `too short to be unguessable: ${key}`);
  }
});

venue = enableEmbed(venue, ["https://marinahair.ae", "  www.marinahair.ae  "]);

await test("turning it on mints a key and records the origins", () => {
  assert.ok(venue.embed?.enabled);
  assert.ok(venue.embed?.key.startsWith("be_"));
  assert.deepEqual(venue.embed?.allowedOrigins, ["https://marinahair.ae", "https://www.marinahair.ae"]);
  assert.equal(venue.embed?.maxCallsPerDay, EMBED_DEFAULTS.maxCallsPerDay);
});

await test("an enabled widget makes the venue streamable", () => {
  assert.equal(mayStreamTo(getLocation(venue.id)), true);
});

await test("turning it off keeps the key but refuses the stream", () => {
  const off = disableEmbed(getLocation(venue.id)!);
  assert.equal(off.embed?.enabled, false);
  // The key survives: switching the widget off for an afternoon must not mean
  // re-editing the customer's website to switch it back on.
  assert.equal(off.embed?.key, venue.embed!.key);
  assert.equal(mayStreamTo(off), false);
  venue = enableEmbed(off, off.embed!.allowedOrigins);
});

console.log("\n\x1b[1mOnly from the site it belongs to\x1b[0m\n");

await test("the registered origin is allowed", () => {
  assert.equal(originAllowed(venue.embed!, "https://marinahair.ae"), true);
});

await test("www and bare are the same site, in both directions", () => {
  // Forcing a venue to register both is a support ticket dressed as a control:
  // they list one, it works on staging and fails on their live site.
  assert.equal(originAllowed(venue.embed!, "https://www.marinahair.ae"), true);
  const bareOnly = { ...venue.embed!, allowedOrigins: ["https://marinahair.ae"] };
  assert.equal(originAllowed(bareOnly, "https://www.marinahair.ae"), true);
  const wwwOnly = { ...venue.embed!, allowedOrigins: ["https://www.marinahair.ae"] };
  assert.equal(originAllowed(wwwOnly, "https://marinahair.ae"), true);
});

await test("somebody else's site is refused", () => {
  assert.equal(originAllowed(venue.embed!, "https://not-marinahair.ae"), false);
  assert.equal(originAllowed(venue.embed!, "https://marinahair.ae.evil.com"), false);
  // A prefix match would let this through, which is the classic version of
  // this bug.
  assert.equal(originAllowed(venue.embed!, "https://marinahair.aegis.com"), false);
});

await test("no origin at all is refused, not treated as ours", () => {
  // A direct visit to the embed URL — somebody pasted it — sends no framing
  // origin. Allowing that makes the widget a public page anybody can spend.
  assert.equal(originAllowed(venue.embed!, null), false);
  assert.equal(originAllowed(venue.embed!, ""), false);
});

await test("an empty allowlist allows nothing", () => {
  // The other classic: a list that is empty because nobody filled it in, read
  // as "no restrictions".
  const none = { ...venue.embed!, allowedOrigins: [] };
  assert.equal(originAllowed(none, "https://marinahair.ae"), false);
});

await test("a disabled widget refuses even a registered origin", () => {
  const off = { ...venue.embed!, enabled: false };
  assert.equal(originAllowed(off, "https://marinahair.ae"), false);
});

await test("an origin is a scheme and a host, never a path", () => {
  // A browser sends an origin, and an origin has no path. An allowlist entry
  // with one would never match anything.
  assert.equal(normaliseOrigin("https://marinahair.ae/book?ref=1"), "https://marinahair.ae");
  assert.equal(normaliseOrigin("marinahair.ae"), "https://marinahair.ae");
  assert.equal(normaliseOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normaliseOrigin("   "), null);
  assert.equal(normaliseOrigin("javascript:alert(1)"), null);
});

console.log("\n\x1b[1mThe day's budget\x1b[0m\n");

await test("a fresh widget is within its cap", () => {
  const gate = checkEmbedGate(getLocation(venue.id)!);
  assert.equal(gate.allowed, true);
  assert.equal(gate.used, 0);
});

await test("the cap counts website calls and stops at the limit", () => {
  const live = getLocation(venue.id)!;
  for (let i = 0; i < live.embed!.maxCallsPerDay; i++) {
    saveCall(startCall(live, "embed", "+971500000000"));
  }
  const gate = checkEmbedGate(getLocation(venue.id)!);
  assert.equal(gate.allowed, false);
  assert.equal(gate.used, live.embed!.maxCallsPerDay);
  // And what a visitor is told is a sentence, not a status code.
  assert.ok(gate.message && !/cap|limit|quota|error/i.test(gate.message), gate.message);
  assert.ok(gate.message?.includes("ring us"));
});

await test("a busy telephone does not switch the website widget off", async () => {
  // Separate channels, separate budgets. Conflating them would make a good day
  // on the phone look like an outage on the site.
  //
  // On its own venue, deliberately: the one above has already had its day's
  // worth of *browser* calls, so reusing it would prove nothing — the first
  // version of this test did exactly that and failed for the wrong reason.
  const second = await signUp({
    businessName: "Busy Line Salon",
    email: "owner@busyline.test",
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
  });
  assert.ok(second.ok);
  const quiet = enableEmbed(second.ok ? second.location : null!, ["https://busyline.ae"]);

  for (let i = 0; i < 100; i++) {
    saveCall(startCall(quiet, "phone", "+971500000001"));
  }
  assert.equal(checkEmbedGate(getLocation(quiet.id)!).allowed, true);
});

await test("another venue's calls do not count against this one", () => {
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  for (let i = 0; i < 100; i++) saveCall(startCall(belline, "embed", "+971500000002"));
  assert.equal(checkEmbedGate(getLocation(venue.id)!).allowed, false, "state changed unexpectedly");
  // The venue we just filled is still the one that is full, not this one.
  const other = getLocation(BELLINE_LOCATION_ID)!;
  assert.notEqual(other.id, venue.id);
});

console.log("\n\x1b[1mThe snippet\x1b[0m\n");

await test("the snippet is one line and carries the venue's own key", () => {
  const snippet = embedSnippet(getLocation(venue.id)!);
  assert.equal(snippet.split("\n").length, 1, "a snippet somebody has to read is one nobody pastes");
  assert.ok(snippet.includes(getLocation(venue.id)!.embed!.key));
  assert.ok(snippet.includes("https://app.belline.ai/embed.js"));
  assert.ok(snippet.includes("async"));
});

await test("the snippet never contains anything secret", () => {
  const snippet = embedSnippet(getLocation(venue.id)!);
  // It goes in a customer's page source, so this is not paranoia: it is the
  // one place a session id or a stream token would be catastrophic.
  for (const forbidden of ["belline_session", "sk_", "whsec_", "Bearer", "token"]) {
    assert.equal(
      snippet.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `the snippet leaks ${forbidden}`,
    );
  }
});

await test("the widget script is served and has no secrets in it either", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "embed.js"), "utf8");
  assert.ok(js.includes("data-belline"));
  assert.ok(js.includes("microphone"), "the iframe cannot ask for a microphone");
  // It runs on somebody else's page; it must never throw into their console
  // for a missing attribute.
  assert.ok(js.includes("console.warn"), "a missing key fails silently");
  assert.equal(/sk_|whsec_|belline_session/.test(js), false);
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
