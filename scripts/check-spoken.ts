/**
 * The spoken-language layer.
 *
 * Text read aloud is not speech. This turns one into the other on the way to
 * the voice, and the tests fall into two halves: it must say numbers, money
 * and references the way a person says them, and it must never change what
 * was actually promised. A layer that quietly turns 47 into 48 is worse than
 * no layer at all.
 *
 *   npm run check:spoken
 */

import assert from "node:assert/strict";
import { toSpoken, PACE } from "../src/lib/voice/spoken";

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

const say = (text: string) => toSpoken(text).text;

console.log("\nMoney, the way a person says it\n");

test("a round price loses its decimals", () => {
  assert.equal(say("That's £85.00 altogether."), "That's, 85 pounds altogether.");
});
test("pence are said, not spelled out as pence", () => {
  assert.match(say("It comes to £47.50."), /47 pounds 50/);
});
test("one pound is singular", () => {
  assert.match(say("Just £1 deposit."), /\b1 pound\b/);
});
test("dollars and euros work too", () => {
  assert.match(say("It's $120."), /120 dollars/);
  assert.match(say("Around €30."), /30 euros/);
});

console.log("\nThings a caller writes down\n");

test("a booking reference is read one character at a time", () => {
  assert.match(say("Your reference is R7K2."), /R 7 K 2/);
});
test("an ordinary capitalised word is not mistaken for a reference", () => {
  assert.equal(say("THANKS for calling."), "THANKS for calling.");
});
test("a phone number is read as digits, grouped in threes", () => {
  const out = say("Call us on 02079460000.");
  assert.match(out, /0 2 0, 7 9 4, 6 0 0, 0 0/, `got: ${out}`);
});

test("every digit of the number survives, in order", () => {
  const out = say("Call us on 02079460000.");
  assert.equal((out.match(/\d/g) ?? []).join(""), "02079460000");
});

test("an international prefix is spoken", () => {
  assert.match(say("Ring +447700900123 back."), /^Ring plus 4 4 7/);
});

console.log("\nPronunciation\n");

test("titles are spoken in full", () => {
  assert.match(say("That's with Dr Reid."), /Doctor Reid/);
});
test("A&E is not read as an ampersand", () => {
  assert.match(say("Go to A&E."), /A and E/);
  assert.doesNotMatch(say("Go to A&E."), /&/);
});
test("an ampersand anywhere becomes a word", () => {
  assert.doesNotMatch(say("Lumière Hair & Beauty"), /&/);
});
test("markdown never reaches the voice", () => {
  assert.doesNotMatch(say("**Important** — the _deposit_ is `non-refundable`"), /[*_`]/);
});

console.log("\nPacing follows what is being said\n");

test("a time is delivered more slowly than the talk around it", () => {
  assert.equal(toSpoken("Thursday at 16:15, then.").speed, PACE.careful);
});
test("a price is delivered slowly", () => {
  assert.equal(toSpoken("It's £47.50.").speed, PACE.careful);
});
test("a reference is delivered slowly", () => {
  assert.equal(toSpoken("Your reference is R7K2.").speed, PACE.careful);
});
test("ordinary conversation runs at talking pace", () => {
  assert.equal(toSpoken("Of course, let me have a look for you.").speed, PACE.talk);
});
test("careful is genuinely slower than talking", () => {
  assert.ok(PACE.careful < PACE.talk, "the two paces are not actually different");
});

console.log("\nIt must never change what was promised\n");

test("the number itself is untouched", () => {
  for (const amount of ["£47.50", "£1", "$120", "€30.05"]) {
    const digits = (amount.match(/\d/g) ?? []).join("");
    const out = say(`The total is ${amount}.`);
    const outDigits = (out.match(/\d/g) ?? []).join("");
    assert.equal(outDigits, digits, `${amount} came out as ${out}`);
  }
});

test("a time is not rounded or reworded", () => {
  assert.match(say("Quarter past four on Thursday."), /Quarter past four on Thursday/);
});

test("a refusal survives intact", () => {
  const refusal =
    "I'm not able to advise on that, and I'm not going to guess at it. Let me put you through to the clinical team.";
  assert.equal(say(refusal), refusal, "the escalation wording was altered");
});

test("an emergency instruction survives intact apart from A&E", () => {
  const out = say("Please ring 999, or go straight to your nearest A&E.");
  assert.match(out, /999/, "the emergency number was mangled");
  assert.match(out, /A and E/);
});

test("plain conversation is left alone", () => {
  const plain = "Of course. Which day suits you?";
  assert.equal(say(plain), plain);
});

console.log("\nPauses follow meaning\n");

test("a confirmation gets a beat before the detail", () => {
  assert.match(say("That's Thursday at four fifteen."), /That's, Thursday/);
});

test("nothing leaks as literal markup", () => {
  const out = say("All booked. Anything else?");
  assert.doesNotMatch(out, /<|\/>|\[|\]/, "markup characters reached the voice");
});

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
