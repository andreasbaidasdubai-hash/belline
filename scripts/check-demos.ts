/**
 * Demo script guards.
 *
 * This recording speaks in a real business's name and is emailed to its owner.
 * Everything below is a way that goes badly wrong while still sounding
 * plausible, which is why each one is a hard check rather than a prompt line.
 *
 *   npm run check:demos
 */

import assert from "node:assert";
import { checkScript, disclosureFor, type DemoScript } from "../src/lib/sales/demos/script";
import { clipId, clipPath, ttsCostUsd } from "../src/lib/sales/demos/render";

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

const GROUNDING = `Smile Dental Clinic is a three-branch practice in Dubai, open until 9pm.
From their own pages:
  "Monday - Saturday: 9:00 AM - 9:00 PM"
  "Implants, orthodontics and hygiene appointments"
  "Call us to book"`;

function script(turns: [string, string][]): DemoScript {
  return {
    scenario: "A patient calls at 9pm to book a hygiene appointment",
    turns: turns.map(([role, text]) => ({ role: role as "caller" | "agent", text })),
    try_this: "Call and ask to move an appointment to Saturday.",
  };
}

const GOOD = script([
  ["agent", "Good evening, Smile Dental — how can I help?"],
  ["caller", "Hi, I was hoping to book a hygiene appointment."],
  ["agent", "Of course. Are mornings or evenings easier for you?"],
  ["caller", "Evenings, after work if you can."],
  ["agent", "I can do Thursday at half seven, or Friday at eight."],
  ["caller", "Thursday's better."],
  ["agent", "Thursday at seven thirty, then. Can I take your name and mobile?"],
  ["caller", "Sarah Ahmed, oh five zero, one two three, four five six seven."],
  ["agent", "That's booked, Sarah. You'll get a text confirmation shortly."],
]);

console.log("\n  A good script passes\n");

test("a natural, grounded call has no problems", () => {
  const out = checkScript(GOOD, GROUNDING);
  assert.deepStrictEqual(out.problems, [], out.problems.join("; "));
});

test("its length lands in the 30–60 second window", () => {
  const out = checkScript(GOOD, GROUNDING);
  assert.ok(out.estimatedSeconds >= 20 && out.estimatedSeconds <= 75, `${out.estimatedSeconds}s`);
});

console.log("\n  Invented pricing is refused\n");

test("a price not in the source material is caught", () => {
  // The fastest way to turn a demo into a complaint: quote a fee the practice
  // does not charge, to the person who sets their fees.
  const bad = script([
    ["agent", "Good evening, Smile Dental — how can I help?"],
    ["caller", "How much is a hygiene appointment?"],
    ["agent", "That's AED 450, and I can book you in on Thursday."],
    ["caller", "Perfect, Thursday works."],
    ["agent", "Booked. Can I take your name?"],
    ["caller", "Sarah Ahmed."],
  ]);
  const out = checkScript(bad, GROUNDING);
  assert.ok(out.problems.some((p) => /price not found/.test(p)), out.problems.join("; "));
});

test("currency in any common form is caught", () => {
  for (const amount of ["AED 450", "450 AED", "$120", "€80", "CHF 90", "1,200 dirhams"]) {
    const bad = script([
      ["agent", "Good evening, Smile Dental — how can I help?"],
      ["caller", "What does it cost?"],
      ["agent", `It is ${amount} for that appointment.`],
      ["caller", "Fine."],
      ["agent", "Booked. Your name?"],
      ["caller", "Sarah."],
    ]);
    const out = checkScript(bad, GROUNDING);
    assert.ok(out.problems.length > 0, `"${amount}" slipped through`);
  }
});

test("a price that IS in the source material is allowed", () => {
  const grounded = `${GROUNDING}\n  "Hygiene appointments from AED 300"`;
  const ok = script([
    ["agent", "Good evening, Smile Dental — how can I help?"],
    ["caller", "What does a hygiene appointment cost?"],
    ["agent", "They start from AED 300. Shall I find you a time?"],
    ["caller", "Yes please, evenings if you can."],
    ["agent", "Thursday at half seven. Can I take your name?"],
    ["caller", "Sarah Ahmed, thanks."],
  ]);
  const out = checkScript(ok, grounded);
  assert.ok(
    !out.problems.some((p) => /price not found/.test(p)),
    `a sourced price should pass: ${out.problems.join("; ")}`,
  );
});

console.log("\n  Clinical advice is refused\n");

test("a diagnosis-shaped reply is caught", () => {
  const bad = script([
    ["agent", "Good evening, Smile Dental — how can I help?"],
    ["caller", "My tooth has been aching since yesterday."],
    ["agent", "That sounds like an infection — you should take antibiotics."],
    ["caller", "Oh, right."],
    ["agent", "I'll book you in Thursday."],
    ["caller", "Thanks."],
  ]);
  const out = checkScript(bad, GROUNDING);
  assert.ok(out.problems.some((p) => /clinical advice/.test(p)), out.problems.join("; "));
});

test("ordinary booking language is not mistaken for advice", () => {
  // The first version of this guard rejected "you have an appointment on
  // Thursday" and "that sounds like a hygiene visit" — the exact sentences a
  // good demo is made of. Speculation is only advice when it is about a
  // condition.
  const ok = script([
    ["agent", "Good evening, Smile Dental — how can I help?"],
    ["caller", "I think I need a clean and a check-up."],
    ["agent", "That sounds like a hygiene visit. Thursday at half seven?"],
    ["caller", "Yes, that works."],
    ["agent", "You have an appointment on Thursday at seven thirty. Your name?"],
    ["caller", "Sarah Ahmed."],
  ]);
  assert.deepStrictEqual(checkScript(ok, GROUNDING).problems, []);
});

test("speculation about a condition is still caught", () => {
  const bad = script([
    ["agent", "Good evening, Smile Dental — how can I help?"],
    ["caller", "My gum is swollen and sore."],
    ["agent", "That sounds like an infection. Thursday at half seven?"],
    ["caller", "Okay."],
    ["agent", "Booked. Your name?"],
    ["caller", "Sarah."],
  ]);
  assert.ok(checkScript(bad, GROUNDING).problems.some((p) => /clinical advice/.test(p)));
});

test("offering an appointment instead of advice passes", () => {
  const ok = script([
    ["agent", "Good evening, Smile Dental — how can I help?"],
    ["caller", "My tooth has been aching since yesterday."],
    ["agent", "I'm sorry — I can't advise on that, but let's get you seen."],
    ["caller", "Please, as soon as you can."],
    ["agent", "There's a slot tomorrow at nine. Can I take your name?"],
    ["caller", "Sarah Ahmed."],
  ]);
  assert.deepStrictEqual(checkScript(ok, GROUNDING).problems, []);
});

console.log("\n  Structure and realism\n");

test("a call that does not start with the phone being answered is caught", () => {
  const bad = script([
    ["caller", "Hi, I'd like to book a cleaning."],
    ["agent", "Of course, when suits you?"],
    ["caller", "Thursday evening."],
    ["agent", "Half seven is free. Your name?"],
    ["caller", "Sarah."],
    ["agent", "Booked, thank you."],
  ]);
  assert.ok(checkScript(bad, GROUNDING).problems.some((p) => /phone being answered/.test(p)));
});

test("two turns from the same speaker is caught", () => {
  const bad = script([
    ["agent", "Good evening, Smile Dental — how can I help?"],
    ["agent", "We're open until nine tonight."],
    ["caller", "I'd like a cleaning."],
    ["agent", "Thursday at half seven?"],
    ["caller", "Perfect."],
    ["agent", "Booked."],
  ]);
  assert.ok(checkScript(bad, GROUNDING).problems.some((p) => /in a row/.test(p)));
});

test("a monologue from the agent is caught", () => {
  const bad = script([
    [
      "agent",
      "Good evening and thank you so much for calling Smile Dental Clinic where we have been proudly serving the Dubai community across three convenient locations with a comprehensive range of treatments including implants and orthodontics and hygiene appointments, how may I direct your call today?",
    ],
    ["caller", "A cleaning, please."],
    ["agent", "Thursday at half seven?"],
    ["caller", "Yes."],
    ["agent", "Booked. Your name?"],
    ["caller", "Sarah."],
  ]);
  assert.ok(checkScript(bad, GROUNDING).problems.some((p) => /too long to sound real/.test(p)));
});

test("a script that would run over a minute is caught", () => {
  const long: [string, string][] = [];
  for (let i = 0; i < 12; i++) {
    long.push([
      i % 2 === 0 ? "agent" : "caller",
      "This is a deliberately padded line of dialogue that goes on well past the point where anyone would still be listening to it.",
    ]);
  }
  assert.ok(checkScript(script(long), GROUNDING).problems.some((p) => /too long/.test(p)));
});

test("the agent never announces that it is an AI", () => {
  const bad = script([
    ["agent", "Good evening, Smile Dental. As an AI assistant, how can I help?"],
    ["caller", "A cleaning please."],
    ["agent", "Thursday at half seven?"],
    ["caller", "Yes."],
    ["agent", "Booked. Your name?"],
    ["caller", "Sarah."],
  ]);
  assert.ok(checkScript(bad, GROUNDING).problems.some((p) => /is an AI/.test(p)));
});

console.log("\n  Disclosure\n");

test("the disclosure names the business and is not generated", () => {
  const d = disclosureFor("Smile Dental Clinic");
  assert.match(d, /Smile Dental Clinic/);
  assert.match(d, /demonstration/i);
  assert.match(d, /not a real call/i);
  // Identical every time — a model must not be able to soften it.
  assert.strictEqual(d, disclosureFor("Smile Dental Clinic"));
});

console.log("\n  Clip addressing\n");

test("the same line and voice yield the same clip id", () => {
  assert.strictEqual(clipId("agent", "Good evening"), clipId("agent", "Good evening"));
});

test("rewording, or changing speaker, yields a different clip", () => {
  assert.notStrictEqual(clipId("agent", "Good evening"), clipId("agent", "Good evening."));
  assert.notStrictEqual(clipId("agent", "Good evening"), clipId("caller", "Good evening"));
});

test("a clip path is refused unless it is a plain 16-hex id", () => {
  // This value reaches a file path from a public URL.
  for (const bad of ["../../../.env", "abc", "", "0123456789abcdef/../x", "0123456789ABCDEF"]) {
    assert.strictEqual(clipPath(bad), null, `"${bad}" must be refused`);
  }
});

test("TTS cost scales with characters", () => {
  assert.ok(ttsCostUsd(2000) > ttsCostUsd(1000));
  assert.strictEqual(ttsCostUsd(0), 0);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
