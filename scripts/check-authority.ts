/**
 * The authority boundary.
 *
 * These are the calls where being wrong once is unacceptable, so the rules
 * are deterministic and this suite runs with no network and no model. Half
 * the tests are false-positive cases on purpose: a filter that fires on
 * ordinary conversation gets switched off, and a control that is switched off
 * protects nobody.
 *
 *   npm run check:authority
 */

import assert from "node:assert/strict";
import { assessAuthority, authorityRules } from "../src/lib/agent/authority";
import type { Location, Vertical } from "../src/lib/types";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  [32m✓[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

const venue = (vertical: Vertical) => ({ vertical }) as Location;
const CLINIC = venue("clinic");
const SALON = venue("salon");
const RESTAURANT = venue("restaurant");

function escalates(location: Location, said: string, ruleId: string) {
  const result = assessAuthority(location, said);
  assert.ok(result, `expected an escalation for: "${said}"`);
  assert.equal(result.disposition, "escalate");
  assert.equal(result.rule.id, ruleId, `wrong rule fired for: "${said}"`);
}

function allows(location: Location, said: string) {
  const result = assessAuthority(location, said);
  assert.equal(result, null, `should have gone to the model, but ${result?.rule.id} fired: "${said}"`);
}

console.log("\nClinic — an emergency in progress never becomes an appointment\n");

test("chest pain right now", () =>
  escalates(CLINIC, "My chest is really tight and I'm short of breath right now.", "medical-emergency"));
test("cannot breathe", () =>
  escalates(CLINIC, "I can't breathe properly, it started this morning.", "medical-emergency"));
test("bleeding that will not stop", () =>
  escalates(CLINIC, "The wound won't stop bleeding, it just started.", "medical-emergency"));
test("allergic reaction", () =>
  escalates(CLINIC, "I'm having an allergic reaction now, my throat is closing.", "medical-emergency"));
test("collapse", () =>
  escalates(CLINIC, "My husband just collapsed and he's unconscious.", "medical-emergency"));

console.log("\nClinic — reception does not give clinical advice\n");

test("is this normal, about pain", () =>
  escalates(CLINIC, "I had a filling yesterday and it's really painful. Is that normal?", "clinical-advice"));
test("should I be worried, about swelling", () =>
  escalates(CLINIC, "The swelling has got worse. Should I be worried?", "clinical-advice"));
test("asking about medication", () =>
  escalates(CLINIC, "Can I take ibuprofen with the antibiotics you gave me?", "clinical-advice"));
test("asking for a diagnosis", () =>
  escalates(CLINIC, "There's a lump there — what do you think is wrong?", "clinical-advice"));

console.log("\nClinic — ordinary reception calls must reach the model\n");

test("booking a consultation", () => allows(CLINIC, "I'd like to book a consultation for next week."));
test("asking the opening hours", () => allows(CLINIC, "What time do you close on a Saturday?"));
test("moving an appointment", () => allows(CLINIC, "Can I move my Tuesday appointment to Thursday?"));
test("asking about parking", () => allows(CLINIC, "Is there parking anywhere near you?"));
test("asking a price", () => allows(CLINIC, "How much is a hygiene appointment?"));
test("mentioning a past treatment without asking advice", () =>
  allows(CLINIC, "I had a filling last year and I'd like a check-up now."));
test("a history, not a crisis", () =>
  allows(CLINIC, "I'd like to see someone about pain I get in my knee when I run."));
test("insurance admin", () => allows(CLINIC, "Do you take Bupa insurance for treatment?"));

console.log("\nSalon\n");

test("a reaction to a colour goes to a person", () =>
  escalates(SALON, "My scalp is burnt and blistered after the bleach.", "adverse-reaction"));
test("booking a colour does not", () =>
  allows(SALON, "Could I book a colour with Marta on Thursday?"));
test("asking how long bleach takes does not", () =>
  allows(SALON, "How long does a full head of bleach take?"));

console.log("\nRestaurant — no clinical authority, so no rules to trip over\n");

test("a diner being dramatic is not an emergency", () =>
  allows(RESTAURANT, "That chilli is killing me, I can't breathe!"));
test("a normal booking", () => allows(RESTAURANT, "Table for six on Friday at eight?"));
test("the restaurant vertical carries no rules at all", () =>
  assert.equal(authorityRules(RESTAURANT).length, 0));

console.log("\nEvery rule can be shown to a customer\n");

for (const location of [CLINIC, SALON]) {
  for (const rule of authorityRules(location)) {
    test(`${location.vertical}/${rule.id} states its reason and its words`, () => {
      assert.ok(rule.reason.length > 40, "reason too thin to show anyone");
      assert.ok(rule.say.length > 20, "no actual words to say");
      assert.ok(["transfer", "end_call", "message"].includes(rule.then));
    });
  }
}

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
