/**
 * Research agent — the guarantees, and the crawler's link picking.
 *
 * No key, no network, no database. These are the checks that stand between a
 * model's output and a sentence quoted back to a business owner, so they are
 * tested rather than trusted:
 *
 *   · a claim citing a page we never fetched is discarded
 *   · a signal left unsupported reverts to unknown, not false
 *   · a service Belline does not sell is dropped
 *
 *   npm run check:research
 */

import assert from "node:assert";
import { postCheck, type Research } from "../src/lib/sales/research/agent";
import { pickLinks } from "../src/lib/sales/research/crawl";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

const FETCHED = [
  "https://smiledental.ae/",
  "https://smiledental.ae/services",
  "https://smiledental.ae/team",
];

const ALLOWED = ["missed_call_recovery", "after_hours_answering", "appointment_booking"];

function research(over: Partial<Research> = {}): Research {
  return {
    summary: "A three-branch dental practice in Dubai that takes bookings by phone and opens late.",
    signals: {
      multi_location: true,
      location_count: 3,
      long_hours: true,
      weekend_open: null,
      appointment_based: true,
      online_booking: false,
      booking_provider: null,
      whatsapp_booking: null,
      phone_first: true,
      has_front_desk: null,
      practitioner_count: 6,
      languages_advertised: ["English", "Arabic"],
      premium_positioning: null,
      recent_expansion: null,
      after_hours_gap: true,
      high_ticket: null,
    },
    use_cases: ["missed_call_recovery", "after_hours_answering"],
    evidence: [
      { claim: "multi location", url: "https://smiledental.ae/", quote: "Our three Dubai clinics" },
      { claim: "phone first", url: "https://smiledental.ae/services", quote: "Call us to book" },
    ],
    unknowns: ["Whether they open on Sundays"],
    ...over,
  };
}

console.log("\n  Evidence must cite a page we actually read\n");

test("a claim citing an unfetched page is discarded", () => {
  // The failure this prevents: a model citing a plausible-looking URL it never
  // saw, producing a confident and wrong first email.
  const r = research({
    evidence: [
      { claim: "multi location", url: "https://smiledental.ae/", quote: "Our three Dubai clinics" },
      { claim: "premium positioning", url: "https://smiledental.ae/about-us", quote: "luxury care" },
    ],
  });
  const out = postCheck(r, FETCHED, ALLOWED);
  assert.strictEqual(out.research.evidence.length, 1);
  assert.strictEqual(out.droppedEvidence.length, 1);
  assert.match(out.droppedEvidence[0], /about-us/);
});

test("URL comparison ignores scheme, www and trailing slash", () => {
  const r = research({
    evidence: [
      { claim: "multi location", url: "http://www.smiledental.ae", quote: "three clinics" },
      { claim: "phone first", url: "https://smiledental.ae/services/", quote: "Call us" },
    ],
  });
  const out = postCheck(r, FETCHED, ALLOWED);
  assert.strictEqual(out.droppedEvidence.length, 0, "these are the same pages");
});

test("an entirely invented domain is discarded", () => {
  const r = research({
    evidence: [{ claim: "multi location", url: "https://example.com/about", quote: "x" }],
  });
  const out = postCheck(r, FETCHED, ALLOWED);
  assert.strictEqual(out.research.evidence.length, 0);
});

console.log("\n  Unsupported signals revert to unknown\n");

test("a signal whose evidence was dropped becomes null, not false", () => {
  // The distinction the whole design turns on: "we could not tell whether they
  // have branches" and "they do not have branches" produce different emails,
  // and only one of them is honest.
  const r = research({
    evidence: [{ claim: "multi location", url: "https://fake.example/x", quote: "three clinics" }],
  });
  const out = postCheck(r, FETCHED, ALLOWED);
  assert.strictEqual(out.research.signals.multi_location, null);
  assert.notStrictEqual(out.research.signals.multi_location, false);
});

test("a signal with surviving evidence is untouched", () => {
  const out = postCheck(research(), FETCHED, ALLOWED);
  assert.strictEqual(out.research.signals.multi_location, true);
  assert.strictEqual(out.research.signals.phone_first, true);
});

test("signals the model already marked unknown stay unknown", () => {
  const out = postCheck(research(), FETCHED, ALLOWED);
  assert.strictEqual(out.research.signals.weekend_open, null);
  assert.strictEqual(out.research.signals.booking_provider, null);
});

test("a deliberate false is preserved", () => {
  // online_booking=false means the page showed no booking system — a real
  // finding, and a positive signal for Belline. It must survive.
  const out = postCheck(research(), FETCHED, ALLOWED);
  assert.strictEqual(out.research.signals.online_booking, false);
});

console.log("\n  Use cases come from the catalogue\n");

test("a service Belline does not sell is dropped", () => {
  const r = research({
    use_cases: ["missed_call_recovery", "dental_insurance_billing", "payroll"],
  });
  const out = postCheck(r, FETCHED, ALLOWED);
  assert.deepStrictEqual(out.research.use_cases, ["missed_call_recovery"]);
  assert.deepStrictEqual(out.droppedUseCases, ["dental_insurance_billing", "payroll"]);
});

test("a service outside this agent's configured list is dropped", () => {
  // multilingual_support is a real Belline service, but this agent is not
  // configured to sell it — so it may not be promised.
  const r = research({ use_cases: ["missed_call_recovery", "multilingual_support"] });
  const out = postCheck(r, FETCHED, ALLOWED);
  assert.deepStrictEqual(out.research.use_cases, ["missed_call_recovery"]);
});

console.log("\n  Crawler link picking\n");

const HTML = `
  <a href="/services">Our Services</a>
  <a href="/team">Meet the Dentists</a>
  <a href="/contact">Contact</a>
  <a href="/book-appointment">Book Online</a>
  <a href="/privacy">Privacy Policy</a>
  <a href="/blog/whitening-tips">Teeth whitening tips</a>
  <a href="https://facebook.com/smiledental">Facebook</a>
  <a href="/brochure.pdf">Download brochure</a>
  <a href="mailto:hi@smiledental.ae">Email us</a>
`;
const BASE = new URL("https://smiledental.ae/");

test("signal-bearing pages are picked", () => {
  const links = pickLinks(HTML, BASE, 5).map((l) => l.url);
  assert.ok(links.some((l) => l.endsWith("/services")));
  assert.ok(links.some((l) => l.endsWith("/team")));
  assert.ok(links.some((l) => l.endsWith("/contact")));
});

test("off-site links are never followed", () => {
  const links = pickLinks(HTML, BASE, 10).map((l) => l.url);
  assert.ok(!links.some((l) => l.includes("facebook.com")), "left the origin");
});

test("assets and mailto are skipped", () => {
  const links = pickLinks(HTML, BASE, 10).map((l) => l.url);
  assert.ok(!links.some((l) => l.endsWith(".pdf")));
  assert.ok(!links.some((l) => l.startsWith("mailto:")));
});

test("noise pages are not picked", () => {
  const links = pickLinks(HTML, BASE, 10).map((l) => l.url);
  assert.ok(!links.some((l) => l.includes("/privacy")));
  assert.ok(!links.some((l) => l.includes("/blog/")));
});

test("link text counts, not just the path", () => {
  // A Dubai clinic is as likely to write "Our Doctors" as "/team".
  const links = pickLinks(`<a href="/de/aerzte">Our Doctors</a>`, BASE, 5);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].role, "team");
});

test("the budget is respected", () => {
  assert.strictEqual(pickLinks(HTML, BASE, 2).length, 2);
});

test("the home page is never re-fetched as a link", () => {
  const links = pickLinks(`<a href="/">Home</a><a href="/services">Services</a>`, BASE, 5);
  assert.ok(!links.some((l) => new URL(l.url).pathname === "/"));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
