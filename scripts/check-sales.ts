/**
 * Sales-engine deterministic core.
 *
 * Everything checked here is the part of the system an LLM has no say in:
 * configuration inheritance, and the one-way merge rules that are the entire
 * reason the agent hierarchy exists. A bug in these is invisible — a Swiss
 * agent quietly sending email it should not, or a country budget spent four
 * times over — so it gets checked rather than trusted.
 *
 * No database and no API keys.
 *
 *   npm run check:sales
 */

import assert from "node:assert";
import { mergeChain } from "../src/lib/sales/config/agents";
import { PartialAgentConfig, ResolvedAgentConfig } from "../src/lib/sales/config/schema";
import { COUNTRIES, FIRST_AGENT_CONFIG, SERVICES } from "../src/lib/sales/config/defaults";

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

/** The three layers of a real chain: director, country manager, vertical agent. */
function chain(
  director: PartialAgentConfig,
  country: PartialAgentConfig,
  vertical: PartialAgentConfig,
) {
  return mergeChain([director, country, vertical]);
}

const swissManager: PartialAgentConfig = {
  languages: ["de", "fr", "en"],
  compliance: COUNTRIES.find((c) => c.code === "CH")!.compliance_profile,
  outreach_strategy: {
    channels: ["linkedin", "email"],
    send_window: COUNTRIES.find((c) => c.code === "CH")!.send_window,
  },
};

const uaeManager: PartialAgentConfig = {
  languages: ["en", "ar"],
  compliance: COUNTRIES.find((c) => c.code === "AE")!.compliance_profile,
  outreach_strategy: {
    channels: ["email", "linkedin", "phone"],
    send_window: COUNTRIES.find((c) => c.code === "AE")!.send_window,
  },
};

console.log("\n  Channel inheritance — a child may only narrow\n");

test("a vertical agent cannot add a channel its country manager withheld", () => {
  const merged = chain(
    {},
    swissManager,
    { outreach_strategy: { channels: ["email", "whatsapp"] } },
  );
  assert.deepStrictEqual(
    merged.outreach_strategy?.channels,
    ["email"],
    "whatsapp must not survive a country manager that does not permit it",
  );
});

test("a vertical agent may narrow to a subset", () => {
  const merged = chain({}, uaeManager, { outreach_strategy: { channels: ["email"] } });
  assert.deepStrictEqual(merged.outreach_strategy?.channels, ["email"]);
});

test("an agent that names no channels inherits the country's full set", () => {
  const merged = chain({}, uaeManager, {});
  assert.deepStrictEqual(merged.outreach_strategy?.channels, ["email", "linkedin", "phone"]);
});

test("intersecting to nothing produces an empty set, not a silent fallback", () => {
  // resolveAgentConfig turns this into a hard error; the merge itself must not
  // paper over it by falling back to the parent's list.
  const merged = chain({}, swissManager, { outreach_strategy: { channels: ["whatsapp"] } });
  assert.deepStrictEqual(merged.outreach_strategy?.channels, []);
});

console.log("\n  Language and region inheritance\n");

test("languages intersect down the chain", () => {
  const merged = chain({}, uaeManager, { languages: ["en", "de"] });
  assert.deepStrictEqual(merged.languages, ["en"], "German is not a UAE language");
});

test("regions intersect down the chain", () => {
  const merged = chain(
    {},
    { regions: ["Dubai", "Abu Dhabi", "Sharjah"] },
    { regions: ["Dubai", "Riyadh"] },
  );
  assert.deepStrictEqual(merged.regions, ["Dubai"]);
});

console.log("\n  Compliance — strictest wins, in both directions\n");

test("a vertical agent cannot switch off a consent requirement", () => {
  const merged = chain(
    {},
    swissManager,
    { compliance: { email_requires_prior_consent: false } },
  );
  assert.strictEqual(merged.compliance?.email_requires_prior_consent, true);
});

test("a vertical agent may make itself stricter", () => {
  const merged = chain({}, uaeManager, { compliance: { email_requires_prior_consent: true } });
  assert.strictEqual(merged.compliance?.email_requires_prior_consent, true);
});

test("the director cannot loosen a country's rule either", () => {
  // Compliance is a fact about a jurisdiction, not a preference held by
  // whoever sits highest in the org chart.
  const merged = chain(
    { compliance: { email_requires_prior_consent: false, max_sequence_steps: 8 } },
    swissManager,
    {},
  );
  assert.strictEqual(merged.compliance?.email_requires_prior_consent, true);
  assert.strictEqual(merged.compliance?.max_sequence_steps, 2, "Swiss cap of 2 must win over 8");
});

test("sequence-step caps take the minimum", () => {
  const merged = chain(
    { compliance: { max_sequence_steps: 6 } },
    { compliance: { max_sequence_steps: 4 } },
    { compliance: { max_sequence_steps: 5 } },
  );
  assert.strictEqual(merged.compliance?.max_sequence_steps, 4);
});

test("days between touches takes the maximum", () => {
  const merged = chain(
    { compliance: { min_days_between_touches: 2 } },
    { compliance: { min_days_between_touches: 4 } },
    { compliance: { min_days_between_touches: 1 } },
  );
  assert.strictEqual(merged.compliance?.min_days_between_touches, 4);
});

test("holidays union rather than replace", () => {
  const merged = chain(
    { compliance: { holidays: ["2026-01-01"] } },
    { compliance: { holidays: ["2026-12-02"] } },
    { compliance: { holidays: ["2026-01-01", "2026-03-20"] } },
  );
  assert.deepStrictEqual(merged.compliance?.holidays, [
    "2026-01-01",
    "2026-03-20",
    "2026-12-02",
  ]);
});

console.log("\n  Budget — a child cannot outspend its parent\n");

test("a child budget is capped by its parent's", () => {
  const merged = chain(
    { budget: { daily_usd: 60, monthly_usd: 1200 } },
    { budget: { daily_usd: 20, monthly_usd: 400 } },
    { budget: { daily_usd: 50, monthly_usd: 900 } },
  );
  assert.strictEqual(merged.budget?.daily_usd, 20);
  assert.strictEqual(merged.budget?.monthly_usd, 400);
});

test("a child budget below its parent's is kept", () => {
  const merged = chain(
    { budget: { daily_usd: 60, monthly_usd: 1200 } },
    { budget: { daily_usd: 20, monthly_usd: 400 } },
    { budget: { daily_usd: 12, monthly_usd: 250 } },
  );
  assert.strictEqual(merged.budget?.daily_usd, 12);
  assert.strictEqual(merged.budget?.monthly_usd, 250);
});

test("the daily send cap is capped the same way", () => {
  const merged = chain(
    {},
    { outreach_strategy: { daily_send_cap: 40 } },
    { outreach_strategy: { daily_send_cap: 200 } },
  );
  assert.strictEqual(merged.outreach_strategy?.daily_send_cap, 40);
});

console.log("\n  Override and deep merge\n");

test("the research prompt is overridden outright, not concatenated", () => {
  const merged = chain(
    { research_prompt: "generic" },
    { research_prompt: "country" },
    { research_prompt: "vertical-specific" },
  );
  assert.strictEqual(merged.research_prompt, "vertical-specific");
});

test("scoring weights merge key by key", () => {
  const merged = chain(
    {},
    { scoring: { weights: { multi_location: 10, phone_first: 10 } } },
    { scoring: { weights: { phone_first: 15, demo_used: 20 } } },
  );
  assert.deepStrictEqual(merged.scoring?.weights, {
    multi_location: 10,
    phone_first: 15,
    demo_used: 20,
  });
});

test("the ICP merges section by section rather than wholesale", () => {
  const merged = chain(
    {},
    { ideal_customer_profile: { must: { has_phone: true }, prefer: { rating_min: 3.5 } } },
    { ideal_customer_profile: { prefer: { rating_min: 4.2 } } },
  );
  assert.strictEqual(merged.ideal_customer_profile?.must?.has_phone, true, "must was dropped");
  assert.strictEqual(merged.ideal_customer_profile?.prefer?.rating_min, 4.2);
});

console.log("\n  Schema validation\n");

test("an unknown scoring signal is rejected with the offending key named", () => {
  const result = PartialAgentConfig.safeParse({
    scoring: { weights: { multi_locations: 10 } },
  });
  assert.strictEqual(result.success, false);
  const message = result.success ? "" : result.error.issues.map((i) => i.message).join(" ");
  assert.match(message, /multi_locations/, "the error must name the typo");
});

test("an unknown top-level key is rejected rather than ignored", () => {
  const result = PartialAgentConfig.safeParse({ oureach_strategy: {} });
  assert.strictEqual(result.success, false, "a typo'd section must not silently do nothing");
});

test("an out-of-range score band is rejected", () => {
  const result = PartialAgentConfig.safeParse({
    scoring: { weights: {}, penalties: {}, bands: { hot: 120, warm: 55 } },
  });
  assert.strictEqual(result.success, false);
});

console.log("\n  The seeded UAE Dental agent\n");

test("the shipped first-agent config is valid", () => {
  const result = PartialAgentConfig.safeParse(FIRST_AGENT_CONFIG);
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
});

test("it resolves to a complete, runnable configuration", () => {
  const merged = chain({}, uaeManager, FIRST_AGENT_CONFIG);
  const result = ResolvedAgentConfig.safeParse(merged);
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
});

test("every service it sells exists in the service catalogue", () => {
  const known = new Set(SERVICES.map((s) => s.slug));
  for (const slug of FIRST_AGENT_CONFIG.belline_services ?? []) {
    assert.ok(known.has(slug), `"${slug}" is not a Belline service`);
  }
});

test("every scoring weight names a known signal", () => {
  // The weights are the one place a typo produces a plausible-looking agent
  // that silently ignores the signal it was tuned around.
  const result = PartialAgentConfig.safeParse({ scoring: FIRST_AGENT_CONFIG.scoring });
  assert.strictEqual(result.success, true);
});

test("every seeded country's compliance profile is valid", () => {
  for (const country of COUNTRIES) {
    const result = PartialAgentConfig.safeParse({ compliance: country.compliance_profile });
    if (!result.success) {
      throw new Error(`${country.code}: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
  }
});

test("Switzerland is seeded as consent-requiring", () => {
  // The single most expensive thing to get wrong in this file.
  const ch = COUNTRIES.find((c) => c.code === "CH")!;
  assert.strictEqual(ch.compliance_profile.email_requires_prior_consent, true);
  assert.ok(ch.compliance_profile.max_sequence_steps <= 2);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
