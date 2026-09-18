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

const { timesIn, timesOffered, checkTimes, honestAlternative, publishedTimes, repairReply } =
  await import("../src/lib/agent/honesty");

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

test("with nothing free it offers a way forward, not a dead end", () => {
  const v = checkTimes("I have 4:30.", []);
  const said = honestAlternative(v);
  assert.equal(/\d{1,2}:\d{2}/.test(said), false, `it invented a time in the recovery: ${said}`);
  // A question, so the conversation has somewhere to go. The first version of
  // this line closed the conversation — and got sent to somebody who had just
  // said "the first one please".
  assert.ok(said.trim().endsWith("?"), said);
  assert.ok(/another day|another time|look/i.test(said), said);
  // And never a promise to go and look, because nothing here will: this
  // replaces a reply, it does not run a second turn.
  assert.equal(/let me check|I'll check|one moment|checking now/i.test(said), false, said);
});

test("the replacement never names more than three times", () => {
  const many = trace("check_availability", {
    slots: Array.from({ length: 9 }, (_, i) => ({ startMin: 540 + i * 15 })),
  });
  const said = honestAlternative(checkTimes("I have 2:00.", [many]));
  assert.ok((said.match(/\d{1,2}:\d{2}/g) ?? []).length <= 3, said);
});

console.log("\n\x1b[1mOpening hours are facts, not availability\x1b[0m\n");

// Belline's own venue: open 08:00 to 21:00 every day.
const HOURS = publishedTimes({
  hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ start: 480, end: 1260 }]])),
});

test("the venue's hours are read as published times", () => {
  assert.ok(HOURS.has(480) && HOURS.has(1260));
});

test("quoting opening hours is not an invention", () => {
  // Verbatim shape of the reply the guard used to replace.
  const v = checkTimes("We're open every day from 8:00 AM until 9:00 PM.", [], HOURS);
  assert.equal(v.ok, true, `false positive on: ${JSON.stringify(v.invented)}`);
  assert.equal(checkTimes("We close at 9pm on Saturdays.", [], HOURS).ok, true);
});

test("an opening time offered as a slot is still an invention", () => {
  const v = checkTimes("I have 8:00 AM free tomorrow if that suits.", [], HOURS);
  assert.equal(v.ok, false);
  assert.deepEqual(v.invented, [480]);
});

test("a closing time the venue does not have is still an invention", () => {
  assert.equal(checkTimes("We close at 11pm.", [], HOURS).ok, false);
});

console.log("\n\x1b[1mRepairing rather than replacing\x1b[0m\n");

test("the answer stays and only the unchecked times go", () => {
  // From the WhatsApp test that found this.
  const reply =
    "Belline is an AI receptionist that answers your phone and your website from your own information. " +
    "You keep your own number and just forward calls to us. " +
    "Which time tomorrow suits you — 10:00 AM, 2:30 PM or 4:00 PM?";
  const v = checkTimes(reply, [], HOURS);
  assert.equal(v.ok, false);
  const said = repairReply(reply, v);
  assert.ok(said.startsWith("Belline is an AI receptionist"), said);
  assert.ok(said.includes("forward calls"), said);
  assert.equal(/\d{1,2}:\d{2}/.test(said), false, `an invented time survived: ${said}`);
  assert.ok(said.trim().endsWith("?"), said);
  assert.equal(/haven't got anything free/i.test(said), false, "it still says nothing is free");
});

test("when the tool did return times, the repair quotes those", () => {
  const reply = "Great choice. I have 2:00 and 3:30 on Wednesday.";
  const said = repairReply(reply, checkTimes(reply, [AVAILABILITY]));
  assert.ok(said.startsWith("Great choice."), said);
  assert.ok(said.includes("09:00"), said);
  assert.equal(said.includes("2:00 "), false, said);
});

test("a reply that was nothing but the invention falls back to the honest line", () => {
  const reply = "I have 4:30 free.";
  assert.equal(repairReply(reply, checkTimes(reply, [])), honestAlternative(checkTimes(reply, [])));
});

test("an honest reply is returned untouched", () => {
  const reply = "We're open until 9:00 PM. Would you like to book a demo call?";
  assert.equal(repairReply(reply, checkTimes(reply, [], HOURS)), reply);
});

console.log("\n\x1b[1mGerman is not a way round it\x1b[0m\n");

const { checkSlotOffers, checkRequestReply, repairRequestReply, repairSlotOffers } = await import("../src/lib/agent/honesty");

test("German times are read, including a bare hour with Uhr", () => {
  assert.deepEqual(timesIn("Ich hätte 14:30 Uhr oder 17 Uhr.", "de").sort((a, b) => a - b), [870, 1020]);
  assert.deepEqual(timesIn("um 9.15 Uhr", "de"), [555]);
  // English venues do not read "Uhr": their guard is exactly what it was.
  assert.deepEqual(timesIn("17 Uhr", "en"), []);
});

test("an invented time in German is caught", () => {
  const v = checkTimes("Morgen hätte ich 14:00 Uhr oder 16:30 Uhr frei.", [AVAILABILITY], undefined, undefined, "de");
  assert.equal(v.ok, false);
  assert.deepEqual(v.invented.sort((a, b) => a - b), [840, 990]);
});

test("a time the tool returned passes in German", () => {
  assert.equal(checkTimes("Ich hätte 09:00 Uhr bei Marie frei.", [AVAILABILITY], undefined, undefined, "de").ok, true);
});

test("German opening hours are facts, not offers", () => {
  assert.equal(checkTimes("Wir haben täglich von 8:00 bis 21:00 Uhr geöffnet.", [], HOURS, undefined, "de").ok, true);
  assert.equal(checkTimes("Samstags schließen wir um 21 Uhr.", [], HOURS, undefined, "de").ok, true);
});

test("a German opening time offered as a slot is still an invention", () => {
  assert.equal(checkTimes("Ich hätte morgen um 8:00 Uhr noch etwas frei.", [], HOURS, undefined, "de").ok, false);
});

test("a German 'no' in one half does not excuse an offer in the other", () => {
  const v = checkTimes("Um 21:00 Uhr haben wir nicht mehr offen, aber ich hätte 8:00 Uhr frei.", [], HOURS, undefined, "de");
  assert.equal(v.ok, false);
  assert.deepEqual(v.invented, [480]);
});

test("the German repair speaks German and quotes the real times", () => {
  const reply = "Gern. Ich hätte 14:00 Uhr am Mittwoch.";
  const said = repairReply(reply, checkTimes(reply, [AVAILABILITY], undefined, undefined, "de"), { language: "de" });
  assert.ok(said.startsWith("Gern."), said);
  assert.match(said, /09:00 Uhr/);
  assert.match(said, /Passt Ihnen davon etwas\?/);
});

test("a German slot offer at a request-only venue is caught, and a refusal is not", () => {
  assert.equal(checkSlotOffers("Wie wäre es mit 17:30 Uhr?", "de").ok, false);
  assert.equal(checkSlotOffers("Ich kann Sie um 18 Uhr eintragen.", "de").ok, false);
  assert.equal(checkSlotOffers("Um 18 Uhr kann ich Sie leider nicht eintragen, das bestätigt das Team.", "de").ok, true);
  assert.equal(checkSlotOffers("Wir haben montags bis 18 Uhr geöffnet.", "de").ok, true);
});

test("a German confirmation claim is caught, and a hedged one is not", () => {
  assert.equal(checkRequestReply("Sie sind für Freitag um 19 Uhr gebucht.", "de").ok, false);
  assert.equal(checkRequestReply("Perfekt, bis dann!", "de").ok, false);
  assert.equal(checkRequestReply("Wir freuen uns auf Ihren Besuch.", "de").ok, false);
  assert.equal(checkRequestReply("Das Team meldet sich, sobald der Termin bestätigt ist.", "de").ok, true);
  assert.equal(checkRequestReply("Noch ist nichts gebucht.", "de").ok, true);
});

test("the German repairs end on German honest lines", () => {
  const claim = "Sie sind gebucht.";
  assert.match(repairRequestReply(claim, checkRequestReply(claim, "de"), "de"), /Ihre Anfrage liegt beim Team/);
  const offer = "Wie wäre es mit 17:30 Uhr?";
  assert.match(repairSlotOffers(offer, checkSlotOffers(offer, "de"), "de"), /Eine Uhrzeit kann ich hier nicht fest zusagen/);
});

test("an English venue's guard is unchanged by any of this", () => {
  assert.equal(checkRequestReply("Sie sind gebucht.").ok, true);
  assert.equal(repairReply("I have 4:30 free.", checkTimes("I have 4:30 free.", [])), honestAlternative(checkTimes("I have 4:30 free.", [])));
});

console.log("\n\x1b[1mThe promise a page makes about a call's length\x1b[0m\n");

/**
 * The same rule as the rest of this file, turned on ourselves.
 *
 * Belle may not quote a time no tool returned. A page may not quote a length
 * no call delivered. "Calls end after 5 minutes" was the number we send Tavus;
 * Tavus was ending calls at 88 seconds. The page was inventing an availability
 * exactly as surely as a receptionist offering a slot nobody had.
 */
const { deliveredCeiling } = await import("../src/lib/video/delivery");
const { promiseLine } = await import("../src/lib/video/client/machine");

const cut = (seconds: number) => ({
  at: new Date().toISOString(),
  locationId: "loc_x",
  sessionId: `vs_${seconds}`,
  provider: "tavus",
  reason: "max_call_duration reached",
  endedBy: "provider" as const,
  cause: "cut_short" as const,
  seconds,
  maxCallSeconds: 300,
});

test("a page never promises a length longer than the calls it has delivered", () => {
  // The founder's own case: three calls around 86 seconds, a 300-second promise.
  const promised = deliveredCeiling(300, [cut(88), cut(85), cut(86)]).seconds;
  assert.notEqual(promised, 300, "the page still promised a length no recent call reached");
  assert.ok(promised !== null && promised <= 85, `promised ${promised}s when the shortest call ran 85s`);
});

test("when the calls agree on no length, the page promises no number at all", () => {
  // Inventing "about two minutes" out of 20, 140 and 240 seconds would be the
  // same sin in a nicer coat: a number nothing measured.
  assert.equal(deliveredCeiling(300, [cut(20), cut(140), cut(240)]).seconds, null);
  const line = promiseLine(null);
  assert.doesNotMatch(line, /\d/, `a page with nothing to promise said a number: ${line}`);
  assert.match(line, /chat/i, "the honest line still leaves the visitor somewhere to go");
});

test("a promise that is being kept is left alone", () => {
  // The guard must not cry wolf here either: while calls run the full length,
  // the plain useful sentence stays.
  assert.equal(deliveredCeiling(300, []).seconds, 300);
  assert.equal(promiseLine(300), "Calls end after 5 minutes.");
});

// ---------------------------------------------------------------------------
// The same promise, made to a salon owner rather than to a caller
//
// Belline does not invent availability, and it does not invent connections
// either. The website's integrations strip is read by owners deciding whether
// to buy, and "Available" under a logo is a claim that a salon on that system
// can be booked into today.
//
// A `booking.partner.<id>` flag does not say that. It says this deployment
// holds a key and somebody switched it on — which is what a *sandbox* key looks
// like, and what the week after a key arrives looks like while it is still
// being driven against a fake studio. Four of the six partners have no bookable
// API at all, so for them it could never say it.
//
// So the strip waits for a live production connection, and these are the
// assertions that keep it waiting. See scripts/site-integrations.ts and
// src/lib/integrations/partners/registry.ts.

const { INTEGRATIONS, integrationState, partnerOf } = await import("./site-integrations");
const { PARTNERS: PARTNER_FACTS, PARTNER_IDS, partnerLive } = await import("../src/lib/integrations/partners");

test("a partner flag and a key alone cannot put a logo on the site as Available", () => {
  for (const item of INTEGRATIONS) {
    const id = partnerOf(item);
    if (!id || !PARTNER_FACTS[id]) continue;
    const upper = id.toUpperCase();
    const switched = { [`FLAG_BOOKING_PARTNER_${upper}`]: "on", [`PARTNER_${upper}_API_KEY`]: "k" };
    assert.equal(integrationState(item, switched), "roadmap", `${item.name} went live on a flag`);
    assert.equal(integrationState(item, { ...switched, [`PARTNER_${upper}_ENV`]: "sandbox" }), "roadmap", `${item.name} went live on a sandbox`);
    assert.equal(integrationState(item, { ...switched, FLAG_STUBS: "on" }), "roadmap", `${item.name} went live on a stub`);
  }
});

test("a partner with no bookable API can never be called live, whatever env says", () => {
  for (const id of PARTNER_IDS) {
    if (PARTNER_FACTS[id].api.create) continue;
    const upper = id.toUpperCase();
    assert.equal(
      partnerLive(id, {
        [`FLAG_BOOKING_PARTNER_${upper}`]: "on",
        [`PARTNER_${upper}_API_KEY`]: "k",
        [`PARTNER_${upper}_ENV`]: "live",
      }),
      false,
      `${id} claimed to be live with no API to reach`,
    );
  }
});

test("every partner on the strip is 'On our roadmap' on a build with no credentials", () => {
  for (const item of INTEGRATIONS) {
    if (!partnerOf(item)) continue;
    assert.equal(integrationState(item, {}), "roadmap", item.name);
  }
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
