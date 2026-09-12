/**
 * Never a time that nothing returned.
 *
 * The product's central promise is that Belline does not invent availability.
 * It was stated in the prompt, twice, in the imperative — and then, asked for
 * a root colour at a salon whose only free slots were 09:00 to 10:15, it
 * answered "I have 2:00, 3:30 and 5:00 on Wednesday with Marie".
 *
 * A prompt is a request. This is the control.
 *
 * The tests come in two halves, and the second matters more than the first.
 * Catching the invention is easy; the hard part is not firing on the hundreds
 * of honest sentences that mention a number — a party of six, a ninety-minute
 * treatment, AED 380, "the 18th". A guard that cries wolf gets switched off,
 * and a guard that is switched off protects nobody.
 *
 *   npm run check:honesty
 */

import assert from "node:assert/strict";
import type { ToolTrace } from "../src/lib/types";

const { timesIn, timesOffered, checkTimes, honestAlternative } = await import(
  "../src/lib/agent/honesty"
);

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

const trace = (name: string, output: unknown, ok = true): ToolTrace => ({
  at: new Date().toISOString(),
  name,
  input: {},
  output,
  ms: 4,
  ok,
});

/** What check_availability actually hands back. */
const AVAILABILITY = trace("check_availability", {
  found: 3,
  slots: [
    { time: "09:00", with: "Marie", startMin: 540, endMin: 645 },
    { time: "09:15", with: "Marie", startMin: 555, endMin: 660 },
    { time: "09:30", with: "Marie", startMin: 570, endMin: 675 },
  ],
});

console.log("\n\x1b[1mReading times out of a reply\x1b[0m\n");

test("written times, in the forms a message uses", () => {
  assert.deepEqual(timesIn("I have 9:00, 9:15 and 9:30.").sort((a, b) => a - b), [540, 555, 570]);
  assert.deepEqual(timesIn("4:30 PM works"), [16 * 60 + 30]);
  assert.deepEqual(timesIn("how about 5pm?"), [17 * 60]);
  assert.deepEqual(timesIn("we close at 11 a.m."), [11 * 60]);
  assert.deepEqual(timesIn("17:00 on Thursday"), [17 * 60]);
});

test("midnight and noon do not come out twelve hours wrong", () => {
  // The classic: 12:30 am is 00:30, and 12:30 pm is 12:30.
  assert.deepEqual(timesIn("12:30 am"), [30]);
  assert.deepEqual(timesIn("12:30 pm"), [12 * 60 + 30]);
});

test("a bare number is never a time", () => {
  // This is the half that decides whether the guard survives contact with
  // real sentences.
  assert.deepEqual(timesIn("a party of 6"), []);
  assert.deepEqual(timesIn("that runs about 90 minutes"), []);
  assert.deepEqual(timesIn("AED 380 for a balayage"), []);
  assert.deepEqual(timesIn("Wednesday the 18th"), []);
  assert.deepEqual(timesIn("we have 3 stylists in that day"), []);
  assert.deepEqual(timesIn("reference R7K2"), []);
});

test("a time with a meridiem is read once, not twice", () => {
  // "10:00 AM" matched as 10:00 and again as the "00" before "AM", which
  // parsed to midnight and made an honest confirmation look like an
  // invention. It fired on a real reply before it fired on a fake one.
  assert.deepEqual(timesIn("I have you down for 10:00 AM on Tuesday"), [600]);
  assert.deepEqual(timesIn("9:15 am with Marie"), [555]);
  assert.deepEqual(timesIn("4:30 PM"), [16 * 60 + 30]);
  assert.deepEqual(timesIn("12:00 pm"), [12 * 60]);
});

test("something that is not a clock time is not read as one", () => {
  assert.deepEqual(timesIn("25:00"), []);
  assert.deepEqual(timesIn("9:75"), []);
});

console.log("\n\x1b[1mReading times out of what the tools returned\x1b[0m\n");

test("slots from check_availability count as offered", () => {
  const offered = timesOffered([AVAILABILITY]);
  assert.equal(offered.has(540), true);
  assert.equal(offered.has(570), true);
  assert.equal(offered.has(16 * 60 + 30), false);
});

test("a tool that failed offers nothing", () => {
  // A failed lookup that happens to echo a time in its error must not license
  // the agent to quote it.
  const failedTrace = trace("check_availability", { slots: [{ time: "14:00" }] }, false);
  assert.equal(timesOffered([failedTrace]).has(14 * 60), false);
});

test("a tool we do not draw times from is ignored", () => {
  const message = trace("take_message", { note: "call back at 14:00" });
  assert.equal(timesOffered([message]).has(14 * 60), false);
});

test("times are found whatever shape the result is", () => {
  // The tools return slots, alternatives, bookings and confirmations in
  // several shapes. A guard that knows three of them fails open on the fourth.
  const alternatives = trace("book", {
    ok: false,
    reason: "unavailable",
    alternatives: [{ time: "11:45" }, { startMin: 12 * 60 }],
  });
  const offered = timesOffered([alternatives]);
  assert.equal(offered.has(11 * 60 + 45), true);
  assert.equal(offered.has(12 * 60), true);
});

console.log("\n\x1b[1mThe verdict\x1b[0m\n");

test("quoting what the tool returned passes", () => {
  const v = checkTimes("I have 9:00, 9:15 and 9:30 with Marie. Which suits?", [AVAILABILITY]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.invented, []);
});

test("the real failure is caught", () => {
  // Verbatim from the run that prompted this file.
  const v = checkTimes(
    "I have 2:00, 3:30 and 5:00 on Wednesday the 18th with Marie. Which suits you?",
    [AVAILABILITY],
  );
  assert.equal(v.ok, false);
  assert.deepEqual(v.invented.sort((a, b) => a - b), [2 * 60, 3 * 60 + 30, 5 * 60]);
});

test("a reply with no times at all is fine", () => {
  assert.equal(checkTimes("Of course — what name shall I put it under?", []).ok, true);
  assert.equal(checkTimes("We're open Tuesday to Sunday.", []).ok, true);
});

test("a reply that mentions a price and a duration is fine", () => {
  const v = checkTimes("A root colour is AED 190 and runs about 90 minutes.", [AVAILABILITY]);
  assert.equal(v.ok, true, `false positive on: ${JSON.stringify(v.invented)}`);
});

test("having checked nothing, any time is invented", () => {
  const v = checkTimes("I have 4:30 free.", []);
  assert.equal(v.ok, false);
});

console.log("\n\x1b[1mWhat it says instead\x1b[0m\n");

test("the replacement quotes the real times", () => {
  const v = checkTimes("I have 2:00, 3:30 and 5:00.", [AVAILABILITY]);
  const said = honestAlternative(v);
  assert.ok(said.includes("09:00"), said);
  assert.ok(said.includes("09:30"), said);
  assert.equal(said.includes("2:00"), false, "it repeated the invention");
});

test("with nothing free it offers a person, not a time", () => {
  const v = checkTimes("I have 4:30.", []);
  const said = honestAlternative(v);
  assert.equal(/\d{1,2}:\d{2}/.test(said), false, `it invented a time in the recovery: ${said}`);
  assert.ok(/team|details/i.test(said), said);
});

test("the replacement never names more than three times", () => {
  const many = trace("check_availability", {
    slots: Array.from({ length: 9 }, (_, i) => ({ startMin: 540 + i * 15 })),
  });
  const said = honestAlternative(checkTimes("I have 2:00.", [many]));
  assert.ok((said.match(/\d{1,2}:\d{2}/g) ?? []).length <= 3, said);
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
