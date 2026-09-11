/**
 * Lead scoring.
 *
 * Pure arithmetic, so it is pinned down exactly. The cases that matter are the
 * ones where a wrong answer looks reasonable: an unresearched company scoring
 * like a bad one, an unknown signal counting as a negative, or a penalty
 * firing on an absence of evidence rather than on evidence of absence.
 *
 *   npm run check:scoring
 */

import assert from "node:assert";
import { scoreLead, versionOf, type ScoringInput } from "../src/lib/sales/scoring/model";
import { FIRST_AGENT_CONFIG } from "../src/lib/sales/config/defaults";
import type { Scoring } from "../src/lib/sales/config/schema";

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

const SCORING = FIRST_AGENT_CONFIG.scoring as Scoring;

function input(over: Partial<ScoringInput> = {}): ScoringInput {
  return {
    signals: {},
    company: { hasPhone: true, hasWebsite: true, city: "Dubai", status: "active" },
    regions: ["Dubai", "Abu Dhabi"],
    scoring: SCORING,
    ...over,
  };
}

console.log("\n  Unknown is not negative\n");

test("a company with no signals scores zero, not a penalty", () => {
  // The trap: an unresearched company must not look like a *bad* prospect.
  const r = scoreLead(input());
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.priority, "low");
  assert.match(r.reason, /not been researched/);
});

test("null signals contribute nothing either way", () => {
  const r = scoreLead(input({ signals: { multi_location: null, phone_first: null } }));
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.breakdown.length, 0);
});

test("a false signal scores zero but is not a penalty", () => {
  const r = scoreLead(input({ signals: { multi_location: false, phone_first: true } }));
  const terms = r.breakdown.map((t) => t.signal);
  assert.ok(!terms.includes("multi_location"), "false should add no term");
  assert.ok(terms.includes("phone_first"));
  assert.ok(r.score > 0);
});

console.log("\n  Penalties need evidence of absence, not absence of evidence\n");

test("'no appointments' fires only when explicitly false", () => {
  const unknown = scoreLead(input({ signals: { appointment_based: null } }));
  assert.ok(
    !unknown.breakdown.some((t) => t.signal === "no_appointments"),
    "must not penalise a company nobody has checked",
  );

  const known = scoreLead(input({ signals: { appointment_based: false } }));
  assert.ok(known.breakdown.some((t) => t.signal === "no_appointments"));
});

test("a missing phone is penalised", () => {
  const r = scoreLead(input({ company: { hasPhone: false, hasWebsite: true, status: "active" } }));
  assert.ok(r.breakdown.some((t) => t.signal === "no_phone" && t.points < 0));
});

test("a closed business is driven to zero", () => {
  const r = scoreLead(
    input({
      signals: { multi_location: true, phone_first: true, high_ticket: true },
      company: { hasPhone: true, hasWebsite: true, status: "closed", city: "Dubai" },
    }),
  );
  assert.strictEqual(r.score, 0, "a -100 penalty must dominate any positives");
});

test("a solo practitioner is penalised, an unknown count is not", () => {
  const solo = scoreLead(input({ signals: { practitioner_count: 1 } }));
  assert.ok(solo.breakdown.some((t) => t.signal === "solo_operation"));

  const unknown = scoreLead(input({ signals: { practitioner_count: null } }));
  assert.ok(!unknown.breakdown.some((t) => t.signal === "solo_operation"));
});

test("a company outside the agent's regions is penalised", () => {
  const inside = scoreLead(input({ company: { hasPhone: true, hasWebsite: true, city: "Dubai" } }));
  assert.ok(!inside.breakdown.some((t) => t.signal === "outside_region"));

  const outside = scoreLead(input({ company: { hasPhone: true, hasWebsite: true, city: "Riyadh" } }));
  assert.ok(outside.breakdown.some((t) => t.signal === "outside_region"));
});

console.log("\n  Counts normalise and saturate\n");

test("review volume saturates rather than dominating", () => {
  const some = scoreLead(input({ company: { hasPhone: true, hasWebsite: true, reviewCount: 100, city: "Dubai" } }));
  const many = scoreLead(input({ company: { hasPhone: true, hasWebsite: true, reviewCount: 2000, city: "Dubai" } }));
  assert.ok(many.score > some.score);
  // 2000 reviews and 200 reviews are both "this phone rings constantly"; the
  // difference must not swamp every other signal.
  const capped = scoreLead(input({ company: { hasPhone: true, hasWebsite: true, reviewCount: 200, city: "Dubai" } }));
  assert.strictEqual(many.score, capped.score);
});

test("locations take the larger of claimed and discovered", () => {
  // Dr Joy's site says thirteen clinics; discovery indexed four. The site is
  // authoritative about the business.
  const r = scoreLead(
    input({
      signals: { location_count: 13 },
      company: { hasPhone: true, hasWebsite: true, branches: 4, city: "Dubai" },
    }),
  );
  const term = r.breakdown.find((t) => t.signal === "location_count");
  assert.ok(term);
  assert.match(term.why, /13 locations/);
});

test("discovered branches count when the site says nothing", () => {
  const r = scoreLead(
    input({
      signals: { location_count: null },
      company: { hasPhone: true, hasWebsite: true, branches: 3, city: "Dubai" },
    }),
  );
  assert.ok(r.breakdown.some((t) => t.signal === "location_count"));
});

console.log("\n  Ranking and bands\n");

test("a strong multi-site practice outranks a weak solo one", () => {
  const strong = scoreLead(
    input({
      signals: {
        multi_location: true, phone_first: true, long_hours: true, weekend_open: true,
        after_hours_gap: true, high_ticket: true, appointment_based: true,
        practitioner_count: 10, location_count: 13, premium_positioning: true,
      },
      company: { hasPhone: true, hasWebsite: true, reviewCount: 2000, branches: 4, city: "Dubai" },
    }),
  );
  const weak = scoreLead(
    input({
      signals: { appointment_based: true, practitioner_count: 1, online_booking: true },
      company: { hasPhone: true, hasWebsite: true, reviewCount: 12, city: "Dubai" },
    }),
  );
  assert.ok(strong.score > weak.score, `${strong.score} should beat ${weak.score}`);
  assert.strictEqual(strong.priority, "hot");
  assert.strictEqual(weak.priority, "low");
});

test("bands are applied at their boundaries", () => {
  const bands = { hot: 75, warm: 55 };
  const at = (score: number) =>
    score >= bands.hot ? "hot" : score >= bands.warm ? "warm" : "low";
  assert.strictEqual(at(75), "hot");
  assert.strictEqual(at(74), "warm");
  assert.strictEqual(at(55), "warm");
  assert.strictEqual(at(54), "low");
});

test("the score never leaves 0–100", () => {
  const huge = scoreLead(
    input({
      signals: Object.fromEntries(Object.keys(SCORING.weights ?? {}).map((k) => [k, true])),
      company: { hasPhone: true, hasWebsite: true, reviewCount: 99999, branches: 40, city: "Dubai" },
      demoUsed: true,
    }),
  );
  assert.ok(huge.score <= 100, `got ${huge.score}`);
  assert.ok(huge.score >= 0);
});

console.log("\n  Explainability\n");

test("every term of the sum is recorded", () => {
  const r = scoreLead(input({ signals: { multi_location: true, phone_first: true } }));
  const total = r.breakdown.reduce((n, t) => n + t.points, 0);
  assert.strictEqual(Math.round(total), r.score, "breakdown must reconstruct the score");
});

test("the reason names the heaviest contributors", () => {
  const r = scoreLead(
    input({ signals: { multi_location: true, phone_first: true, after_hours_gap: true } }),
  );
  assert.match(r.reason, /multiple locations|phone is the main way to book/);
});

test("demo usage is worth more than any single researched signal", () => {
  // Someone who dialled the product is the warmest they will ever be.
  const withDemo = scoreLead(input({ signals: { phone_first: true }, demoUsed: true }));
  const without = scoreLead(input({ signals: { phone_first: true }, demoUsed: false }));
  assert.ok(withDemo.score - without.score >= 15, "demo_used should move the needle hard");
});

console.log("\n  Versioning\n");

test("the same weights hash the same, different weights do not", () => {
  assert.strictEqual(versionOf(SCORING), versionOf({ ...SCORING }));
  const changed: Scoring = {
    ...SCORING,
    weights: { ...SCORING.weights, multi_location: 99 },
  };
  assert.notStrictEqual(versionOf(SCORING), versionOf(changed));
});

test("key order does not change the hash", () => {
  const reordered: Scoring = {
    bands: SCORING.bands,
    penalties: SCORING.penalties,
    weights: Object.fromEntries(Object.entries(SCORING.weights ?? {}).reverse()),
  };
  assert.strictEqual(versionOf(SCORING), versionOf(reordered));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
