/**
 * Outreach guards and assembly.
 *
 * Every case here is a way a draft reaches a real practice owner and does
 * damage while looking fine in a list — an invented number, a promise nobody
 * can keep, a template with the name swapped. Each is a hard check rather than
 * a line in a prompt, because a rule followed nineteen times in twenty is
 * worse than one followed never: the twentieth survives review.
 *
 *   npm run check:outreach
 */

import assert from "node:assert";
import { checkDraft, similarity, type GuardContext } from "../src/lib/sales/outreach/guards";
import { assemble, resolveFrame, personalisedWordCount } from "../src/lib/sales/outreach/templates";
import { looksLikeOptOut } from "../src/lib/sales/compliance/suppression";

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

const GROUNDING = `Dr. Joy Dental Clinic runs thirteen clinics across Dubai, open 9:00 AM to 8:00 PM seven days a week.
Booking is a request form confirmed by staff. Ten practitioners listed at Jumeirah Al Wasl Road.
From their own pages:
  "We are open all 7 days"
  "Please fill out the form below to request an appointment"
  "Supported by a multilingual team"`;

const CTX: GuardContext = {
  companyName: "Dr. Joy Dental Clinic",
  grounding: GROUNDING,
  allowedClaims: ["missed_call_recovery", "after_hours_answering"],
  customerWord: "patient",
  forbiddenCustomerWords: ["guest", "client", "customer"],
  maxWords: 90,
  recentBodies: [],
};

const GOOD = {
  subject: "your 13 clinics and the 9pm calls",
  observation: "You run thirteen clinics across Dubai and take bookings through a request form.",
  problem: "Which means a patient who rings after eight waits until someone gets to the form.",
  solution:
    "Belline answers those calls, books into the same diary, and works alongside your front desk rather than replacing anyone.",
  cta: "Worth forty seconds of your time?",
};

console.log("\n  A good draft passes\n");

test("specific, short, grounded copy has no problems", () => {
  const r = checkDraft(GOOD, CTX);
  assert.deepStrictEqual(r.problems, [], r.problems.join("; "));
});

test("word count covers only the personalised part", () => {
  const n = personalisedWordCount(GOOD);
  assert.ok(n > 30 && n < 90, `${n} words`);
  assert.strictEqual(checkDraft(GOOD, CTX).wordCount, n);
});

console.log("\n  Invented facts about the prospect\n");

test("a number not in the research is caught", () => {
  // "your four locations" is checkable, wrong half the time, and fatal when
  // wrong — it is the single most damaging thing this system can write.
  const r = checkDraft({ ...GOOD, observation: "You run four clinics across Dubai." }, CTX);
  // Reported as written, not normalised — the point of the message is to show
  // the reviewer the exact words that are wrong.
  assert.ok(r.problems.some((p) => /"four".*not in the research/.test(p)), r.problems.join("; "));
});

test("a number that is not a claim about the business is left alone", () => {
  // "Worth forty seconds of your time" is a fact about our recording. An
  // earlier version flagged it and rejected every well-written draft.
  const r = checkDraft({ ...GOOD, cta: "Worth forty seconds of your time?" }, CTX);
  assert.ok(!r.problems.some((p) => /forty/.test(p)), r.problems.join("; "));
});

test("a number that IS in the research passes", () => {
  const r = checkDraft({ ...GOOD, observation: "You run 13 clinics with 10 practitioners." }, CTX);
  assert.ok(!r.problems.some((p) => /not in the research/.test(p)), r.problems.join("; "));
});

test("a price is always refused", () => {
  const r = checkDraft({ ...GOOD, solution: "Belline is AED 299 a month." }, CTX);
  assert.ok(r.problems.some((p) => /quotes a price/.test(p)));
});

test("commercial terms are refused", () => {
  for (const line of ["Start a free trial today.", "20% off for the first month.", "Our pricing is simple."]) {
    const r = checkDraft({ ...GOOD, cta: line }, CTX);
    assert.ok(r.problems.length > 0, `"${line}" slipped through`);
  }
});

console.log("\n  Invented claims about Belline\n");

test("a claimed customer base is refused", () => {
  const r = checkDraft({ ...GOOD, solution: "Trusted by hundreds of clinics across the Gulf." }, CTX);
  assert.ok(r.problems.some((p) => /customer base|customers or case studies/.test(p)));
});

test("an absolute promise is refused", () => {
  // No phone system can guarantee this, and the first missed call proves it.
  const r = checkDraft({ ...GOOD, solution: "You will never miss a call again." }, CTX);
  assert.ok(r.problems.some((p) => /absolute promise/.test(p)));
});

console.log("\n  Selling the outcome, not the technology\n");

test("naming the technology is refused", () => {
  for (const line of [
    "Our AI-powered receptionist answers every call.",
    "Belline uses artificial intelligence to book patients.",
    "It is a chatbot for your phone line.",
  ]) {
    const r = checkDraft({ ...GOOD, solution: line }, CTX);
    assert.ok(
      r.problems.some((p) => /sells the technology/.test(p)),
      `"${line}" slipped through`,
    );
  }
});

test("describing the outcome passes", () => {
  const r = checkDraft(
    { ...GOOD, solution: "Belline picks up when the desk is busy and books the patient in." },
    CTX,
  );
  assert.deepStrictEqual(r.problems, []);
});

console.log("\n  Tone\n");

test("outbound clichés are caught", () => {
  for (const line of [
    "I hope this email finds you well.",
    "Just wanted to reach out about your clinic.",
    "Quick question about your booking process.",
    "A revolutionary way to handle calls.",
  ]) {
    const r = checkDraft({ ...GOOD, observation: line }, CTX);
    assert.ok(r.problems.length > 0, `"${line}" slipped through`);
  }
});

test("more than one exclamation mark is caught", () => {
  const r = checkDraft({ ...GOOD, cta: "Have a listen! It's worth it!" }, CTX);
  assert.ok(r.problems.some((p) => /exclamation/.test(p)));
});

test("a subject pretending to be a reply is caught", () => {
  const r = checkDraft({ ...GOOD, subject: "Re: our conversation" }, CTX);
  assert.ok(r.problems.some((p) => /pretends to be a reply/.test(p)));
});

test("an over-long subject is caught", () => {
  const r = checkDraft({ ...GOOD, subject: "a".repeat(90) }, CTX);
  assert.ok(r.problems.some((p) => /truncated/.test(p)));
});

console.log("\n  Vocabulary\n");

test("calling patients 'guests' is caught", () => {
  // A clinic that hears salon vocabulary from a stranger has already decided.
  const r = checkDraft({ ...GOOD, problem: "Your guests wait until someone answers." }, CTX);
  assert.ok(r.problems.some((p) => /calls their patients "guests"/.test(p)));
});

test("an unfilled placeholder is caught", () => {
  for (const line of ["Hi [First Name], you run thirteen clinics.", "Regards, Your Name", "Hello {{company}}"]) {
    const r = checkDraft({ ...GOOD, observation: line }, CTX);
    assert.ok(r.problems.some((p) => /placeholder/.test(p)), `"${line}" slipped through`);
  }
});

console.log("\n  Not a template in disguise\n");

test("identical copy to a sent message is refused", () => {
  const body = `${GOOD.observation} ${GOOD.problem} ${GOOD.solution} ${GOOD.cta}`;
  const r = checkDraft(GOOD, { ...CTX, recentBodies: [body] });
  assert.ok(r.problems.some((p) => /similar to a message already sent/.test(p)));
});

test("the same skeleton with a different business is still caught", () => {
  // The actual failure mode: one template, name swapped, sent to fifty
  // practices — which is exactly the spam the directive rules out.
  const other =
    "You run eleven clinics across Dubai and take bookings through a request form. " +
    "Which means a patient who rings after eight waits until someone gets to the form. " +
    "Belline answers those calls, books into the same diary, and works alongside your front desk rather than replacing anyone. " +
    "Worth forty seconds of your time?";
  const r = checkDraft(GOOD, { ...CTX, recentBodies: [other] });
  assert.ok(r.problems.some((p) => /similar/.test(p)), `similarity was ${r.similarity}`);
});

test("genuinely different copy passes", () => {
  const other =
    "Your Jumeirah branch is open until eight, seven days a week. " +
    "After that the phone rings out and the patient calls someone else. " +
    "Belline takes those calls and puts them in the book. " +
    "Have a listen?";
  const r = checkDraft(GOOD, { ...CTX, recentBodies: [other] });
  assert.ok(!r.problems.some((p) => /similar/.test(p)), `similarity was ${r.similarity}`);
});

test("similarity is symmetric and bounded", () => {
  assert.strictEqual(similarity("a b c d", "a b c d"), 1);
  assert.strictEqual(similarity("", "a b c"), 0);
  assert.ok(similarity("a b c d e", "a b c x y") < 1);
});

console.log("\n  Frames\n");

test("the right frame is chosen, with fallback", () => {
  assert.strictEqual(resolveFrame({ countryCode: "AE", language: "en" }).key, "AE:en");
  assert.strictEqual(resolveFrame({ countryCode: "AE", language: "ar" }).key, "AE:ar");
  assert.strictEqual(resolveFrame({ countryCode: "CH", language: "de" }).key, "CH:de");
  // An unknown country falls back to the default for that language, not to
  // nothing — a new market must work on day one.
  assert.strictEqual(resolveFrame({ countryCode: "QA", language: "en" }).key, "default:en");
  assert.strictEqual(resolveFrame({}).key, "default:en");
});

test("Switzerland's frame uses Sie, not a first name", () => {
  const ch = resolveFrame({ countryCode: "CH", language: "de" });
  assert.match(ch.greeting, /Guten Tag/);
  assert.ok(!/du\b/i.test(ch.greeting));
});

console.log("\n  Assembly\n");

const EMAIL = assemble({
  frame: resolveFrame({ countryCode: "AE", language: "en" }),
  firstName: "Ahmed",
  ...GOOD,
  demoUrl: "https://belline.ai/demo/dr-joy-9",
  tryThis: "Call and ask for an implant consultation.",
  unsubscribeUrl: "https://belline.ai/u/abc",
  senderAddress: "Belline · Dubai, UAE",
});

test("the finished email carries everything compliance requires", () => {
  assert.match(EMAIL.body, /Dear Ahmed,/);
  assert.match(EMAIL.body, /belline\.ai\/demo\/dr-joy-9/);
  assert.match(EMAIL.body, /reply STOP/i, "must offer a way out");
  assert.match(EMAIL.body, /belline\.ai\/u\/abc/, "must carry an unsubscribe link");
  assert.match(EMAIL.body, /Belline · Dubai, UAE/, "must carry a postal address");
});

test("no name means no invented one", () => {
  const anon = assemble({
    frame: resolveFrame({ countryCode: "AE", language: "en" }),
    firstName: null,
    ...GOOD,
    demoUrl: "https://belline.ai/demo/x",
    unsubscribeUrl: "https://belline.ai/u/x",
    senderAddress: "Belline · Dubai, UAE",
  });
  assert.match(anon.body, /Good morning,/);
  assert.ok(!/\{first\}/.test(anon.body), "the placeholder must be gone");
});

test("the whole email stays short", () => {
  const words = EMAIL.body.split(/\s+/).filter(Boolean).length;
  assert.ok(words < 160, `${words} words including the frame`);
});

console.log("\n  Opt-out detection\n");

test("opt-outs are caught across languages", () => {
  for (const text of [
    "Please unsubscribe me",
    "STOP",
    "remove me from your list",
    "Do not contact me again",
    "ألغِ الاشتراك",
    "Bitte abmelden",
    "ne plus me contacter",
  ]) {
    assert.ok(looksLikeOptOut(text), `"${text}" was not caught`);
  }
});

test("an interested reply is not mistaken for an opt-out", () => {
  for (const text of [
    "This looks interesting, can you tell me more?",
    "We already stopped using our old system.",
    "Sounds good — what's next?",
  ]) {
    assert.ok(!looksLikeOptOut(text), `"${text}" was wrongly treated as an opt-out`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
