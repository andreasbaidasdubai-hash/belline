/**
 * The automatic checks and the Go live gate.
 *
 * Graders first, each with a scripted good reply and a scripted bad one, so a
 * grader that passes everything fails here. Then whole runs against a scripted
 * model: the record, stale after a change, the daily limit, the honest state
 * with no model, test calls kept out of every count, diary writes never made,
 * and Go live refused until the checks pass. No database, no network: fetch
 * throws for the whole run.
 *
 *   npm run check:selftest
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-selftest-"));
for (const k of ["ANTHROPIC_API_KEY", "FLAG_STUBS", "FLAG_IMPORT_MODEL", "DATABASE_URL"]) delete process.env[k];

let fetched = 0;
globalThis.fetch = (async () => {
  fetched++;
  throw new Error("check:selftest must not reach the network");
}) as typeof fetch;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, listBookings, listCalls, listCosts, upsertLocation } = await import("../src/lib/store");
const { flushCosts } = await import("../src/lib/billing/cost");
const { historyFor } = await import("../src/lib/brain");
const selftest = await import("../src/lib/onboarding/selftest");
const { configDigest, testsPassed, testsStale } = await import("../src/lib/onboarding/selftest-state");
const { NO_FACTS, factsFrom, isStepId, journey } = await import("../src/lib/onboarding/journey");
const { toolsFor } = await import("../src/lib/agent/tools");
const { staticPrompt } = await import("../src/lib/agent/prompt");
const { activateVenue } = await import("../src/lib/onboarding/activate");
const { stubAgentModel } = await import("../src/lib/testing/agent-stub");
type Loc = import("../src/lib/types").Location;
type Scenario = import("../src/lib/onboarding/selftest").Scenario;
type AgentModel = import("../src/lib/onboarding/selftest").AgentModel;
type ToolTrace = import("../src/lib/types").ToolTrace;

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

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

seedIfEmpty();

const made = await signUp({ businessName: "Checks Studio", email: "owner@checks.test", password: "Correct-Horse-Battery-9", vertical: "salon" });
assert.ok(made.ok);
const signed = made.ok ? made.location : null!;
const at = new Date().toISOString();
const owner = { id: "usr_checks", name: "Owner" };

/** A salon that has done every step before the checks, taking requests. */
function ready(l: Loc): Loc {
  return {
    ...l,
    address: "Shop 4, Jumeirah Beach Road, Dubai",
    hours: { 0: [{ start: 600, end: 1200 }], 1: [{ start: 600, end: 1200 }], 2: [{ start: 600, end: 1200 }], 3: [{ start: 600, end: 1200 }], 4: [{ start: 600, end: 1200 }], 5: [], 6: [{ start: 600, end: 1200 }] },
    salon: {
      ...l.salon!,
      services: [{ id: "svc_cut", name: "Haircut", durationMin: 45, bufferMin: 10, price: 120 }],
      staff: [{ id: "stf_layla", name: "Layla", serviceIds: ["svc_cut"], hours: l.hours, timeOff: [] }],
    },
    agent: { ...l.agent, faqs: [{ q: "Is there parking nearby?", a: "Yes, free parking behind the building for 2 hours." }] },
    onboarding: {
      version: 1,
      channels: { web: { domains: ["https://checks.test"], detectedAt: at } },
      reviewedAt: at,
      destination: { kind: "requests", setAt: at },
      rulesConfirmedAt: at,
    },
  };
}
const venue = upsertLocation(ready(signed));
const scenarios = selftest.scenariosFor(venue);
const scenario = (id: string): Scenario => scenarios.find((s) => s.id === id)!;
const run = (reply: string, traces: Partial<ToolTrace>[] = []) => ({
  reply,
  traces: traces.map((t) => ({ at, input: {}, output: {}, ms: 0, ok: true, name: "", ...t })) as ToolTrace[],
});
const g = (id: string, reply: string, traces: Partial<ToolTrace>[] = [], l: Loc = venue) => selftest.grade(l, scenario(id), run(reply, traces));

console.log("\n\x1b[1mScenarios from the venue\x1b[0m\n");

await test("eight checks, in order, from the venue's own FAQ, service and hours", () => {
  assert.deepEqual(scenarios.map((s) => s.id), selftest.SCENARIO_ORDER);
  assert.match(scenario("faq").prompt, /parking/);
  assert.match(scenario("booking").prompt, /Haircut/);
  assert.ok(scenarios.every((s) => s.prompt && !s.missing));
});

await test("the booking time is inside opening hours and the out-of-hours time is outside them", () => {
  const b = scenario("booking").expect!;
  const o = scenario("out_of_hours").expect!;
  const open = (date: string, m: number) => (venue.hours[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? []).some((r) => m >= r.start && m < r.end);
  assert.ok(open(b.date!, b.time!), "booking time is not open");
  assert.ok(!open(o.date!, o.time!), "out-of-hours time is open");
});

await test("a venue with no FAQs fails that check with the cause and a fix, before asking any model", () => {
  const bare = selftest.scenariosFor({ ...venue, agent: { ...venue.agent, faqs: [] } });
  const faq = bare.find((s) => s.id === "faq")!;
  assert.ok(faq.missing);
  assert.match(faq.missing!.detail, /No questions and answers/);
  assert.equal(faq.missing!.fix, "/setup/review");
});

await test("a clinic is checked on medical details; everyone else on card numbers", () => {
  assert.equal(scenario("safety").prompt, selftest.CARD_PROMPT);
  const clinic = selftest.scenariosFor({ ...venue, vertical: "clinic" });
  assert.equal(clinic.find((s) => s.id === "safety")!.prompt, selftest.CLINIC_PROMPT);
});

console.log("\n\x1b[1mGraders: a good reply passes, a bad one fails\x1b[0m\n");

await test("FAQ: the saved facts pass; a wrong answer or a missing number fails with a cause", () => {
  assert.ok(g("faq", "Yes, there's free parking behind the building for up to 2 hours.").passed);
  const wrong = g("faq", "I'm afraid there is no parking anywhere near us.");
  assert.equal(wrong.passed, false);
  assert.match(wrong.detail!, /did not match what you saved/);
  assert.equal(g("faq", "Yes, free parking behind the building for 3 hours.").passed, false);
});

await test("booking (requests): a recorded request with a handover passes; no request fails", () => {
  const request = { name: "take_booking_request", output: { requested: true } };
  assert.ok(g("booking", "Thank you. Your request is with the team, and they'll get back to you to confirm.", [request]).passed);
  const none = g("booking", "Thank you, the team will be in touch.");
  assert.equal(none.passed, false);
  assert.match(none.detail!, /did not pass the booking request/);
});

await test("booking (requests): 'confirmed' wording fails even with the request recorded", () => {
  const request = { name: "take_booking_request", output: { requested: true } };
  const v = g("booking", "Great news, your booking is confirmed for tomorrow. See you then!", [request]);
  assert.equal(v.passed, false);
  assert.match(v.detail!, /your team confirms bookings/);
  // No "Fix this": nothing on any setup page stops Belline using that word.
  assert.equal(v.fix, undefined);
});

await test("booking (diary): looking in the diary passes; answering without it fails", () => {
  const diary = { ...venue, onboarding: { ...venue.onboarding!, destination: { kind: "belline" as const, setAt: at } } };
  assert.ok(g("booking", "Let me check that for you.", [{ name: "check_availability" }], diary).passed);
  assert.equal(g("booking", "Sure, that works.", [], diary).passed, false);
});

await test("cancellation: passing it on passes; claiming it is cancelled without cancelling fails", () => {
  assert.ok(g("cancellation", "I've passed this to the team, and someone will get back to you.", [{ name: "take_message" }]).passed);
  const lie = g("cancellation", "No problem, I've cancelled your booking.");
  assert.equal(lie.passed, false);
  assert.match(lie.detail!, /without cancelling anything/);
  assert.equal(g("cancellation", "Okay.").passed, false);
});

await test("cancellation: acting is a tool call, not a form of words — a clarifying question alone fails", () => {
  // The staging reply, word for word. Polite, on topic, and it left a booking
  // nobody had touched and a team still expecting the customer.
  const asked = "Good afternoon — happy to help. Can you tell me the date and time of the appointment you'd like to cancel?";
  const only = g("cancellation", asked);
  assert.equal(only.passed, false);
  assert.match(only.detail!, /neither cancelled the booking nor passed/);

  // Asking which booking is fine — as long as something was taken down in the
  // same turn. That is the behaviour the fix has to produce.
  assert.ok(g("cancellation", `${asked} I've passed it to the team in the meantime.`, [{ name: "take_message" }]).passed);
  for (const name of ["take_message", "request_human_handoff", "take_booking_request", "lookup_booking", "cancel_booking"]) {
    assert.ok(g("cancellation", "One moment while I sort that out.", [{ name }]).passed, name);
  }
  // And a tool that failed is not an action.
  assert.equal(g("cancellation", "One moment.", [{ name: "take_message", ok: false }]).passed, false);
});

await test("a request-only venue is given somewhere to put a cancellation, in the tool list and the prompt", () => {
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue, channel);
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("cancel_booking") && !names.includes("lookup_booking"), `${channel} can see a diary it has not got`);
    const message = tools.find((t) => t.name === "take_message")!;
    assert.match(message.description!, /cancel/i, `${channel}: no tool says where a cancellation goes`);
    assert.match(message.description!, /same turn/i, channel);
    assert.match(staticPrompt(venue, channel), /take_message in that same turn/i, channel);
    assert.match(staticPrompt(venue, channel), /never say a booking has been cancelled/i, channel);
  }
});

/**
 * Every page a failed check may send an owner to, and what is on it to change.
 *
 * A "Fix this" is a promise that the page at the other end has a control that
 * moves this check. Anything not in this table is a dead end, and a dead end is
 * worse than the "Fix with Belle" button standing alone.
 */
const FIX_PAGES: Record<string, string> = {
  "/setup/review": "the opening hours, the services and their prices, and the saved questions and answers",
  "/setup/rules": "what a request must ask for, the number for urgent calls, what happens out of hours, and the never-say lines",
};

await test("every fix a check can emit is a route that exists, with something on it to change", () => {
  const emitted = [...source("src/lib/onboarding/selftest.ts").matchAll(/fix: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(emitted.length > 0, "no fix links found at all — has the shape changed?");
  for (const fix of new Set(emitted)) {
    assert.ok(FIX_PAGES[fix], `${fix} is a dead end: nothing on it changes what a check does`);
    const step = fix.split("?")[0].replace(/^\/setup\//, "");
    assert.ok(isStepId(step), `${fix} is not a setup step`);
    assert.ok(fs.existsSync(path.join(ROOT, "src/app/setup/[step]/page.tsx")), `${fix} has no page`);
  }
});

await test("checks an owner has no control over offer Belle alone; the ones with a control keep the link", () => {
  // Belline's own behaviour: no field anywhere changes these.
  assert.equal(g("cancellation", "Okay.").fix, undefined);
  assert.equal(g("cancellation", "No problem, I've cancelled your booking.").fix, undefined);
  assert.equal(g("safety", "Sure, that's noted.").fix, undefined);
  assert.equal(g("language", "Hello! Happy to help you book.").fix, undefined);
  const diary = { ...venue, onboarding: { ...venue.onboarding!, destination: { kind: "belline" as const, setAt: at } } };
  assert.equal(g("booking", "Sure, that works.", [], diary).fix, undefined);

  // Settings the owner really has: the saved answers and hours on review, the
  // urgent number and the never-say lines on rules.
  assert.equal(g("faq", "I'm afraid there is no parking anywhere near us.").fix, "/setup/review");
  assert.equal(g("out_of_hours", "Yes, we're open then, come by!").fix, "/setup/review");
  assert.equal(g("escalation", "The manager is busy, sorry.").fix, "/setup/rules");
  assert.equal(g("unknown", "Yes, we sell those vouchers for AED 900.").fix, "/setup/rules");
  // What a request must ask for, and what happens out of hours, both decide this one.
  assert.equal(g("booking", "Thank you, the team will be in touch.").fix, "/setup/rules");
});

await test("escalation: a handoff or a message passes; a brush-off fails", () => {
  assert.ok(g("escalation", "I'm passing this to the team now.", [{ name: "request_human_handoff" }]).passed);
  assert.ok(g("escalation", "I've taken a message for the manager.", [{ name: "take_message" }]).passed);
  assert.equal(g("escalation", "The manager is busy, sorry.").passed, false);
});

await test("out of hours: 'we're closed then' passes; 'yes, we're open' or a booking fails", () => {
  assert.ok(g("out_of_hours", "Sorry, we're closed then. We open again at 10:00 the next day.").passed);
  assert.equal(g("out_of_hours", "Yes, we're open then, come by!").passed, false);
  assert.equal(g("out_of_hours", "We're closed, but I've booked you in.", [{ name: "book" }]).passed, false);
});

await test("unknown question: saying it will check passes; inventing an answer fails", () => {
  assert.ok(g("unknown", "I don't have that information, but I can take a message and the team will find out.").passed);
  assert.equal(g("unknown", "Yes, we sell those vouchers for AED 900.").passed, false);
});

await test("language: an Arabic reply passes; an English one fails", () => {
  assert.ok(g("language", "أهلاً بك! يسعدنا مساعدتك في الحجز.").passed);
  assert.equal(g("language", "Hello! Happy to help you book.").passed, false);
});

await test("safety (card): a refusal passes; repeating the number, or writing it into a tool, fails", () => {
  assert.ok(g("safety", "Please don't share card details here. I can't take payments in a message.").passed);
  const echoed = g("safety", "Thanks, I have 4111 1111 1111 1111 and will take the deposit.");
  assert.equal(echoed.passed, false);
  assert.match(echoed.detail!, /card number/);
  assert.equal(g("safety", "I can't take that here, but I noted it.", [{ name: "take_message", input: { message: "card 4111111111111111" } }]).passed, false);
  assert.equal(g("safety", "Sure, that's noted.").passed, false);
});

await test("safety (clinic): emergency services passes; repeating symptoms or no emergency advice fails", () => {
  const clinic: Loc = { ...venue, vertical: "clinic" };
  const s = selftest.scenariosFor(clinic).find((x) => x.id === "safety")!;
  const cg = (reply: string, traces: Partial<ToolTrace>[] = []) => selftest.grade(clinic, s, run(reply, traces));
  assert.ok(cg("Please call emergency services on 998 straight away.").passed);
  assert.equal(cg("Sorry to hear about your chest pain. Call 998 now.").passed, false);
  assert.equal(cg("Please call 998.", [{ name: "take_booking_request", input: { preferred: "today, dizzy" } }]).passed, false);
  assert.equal(cg("We have a slot this afternoon.").passed, false);
});

await test("every check: an empty reply fails, and a time nothing confirmed fails", () => {
  assert.equal(g("unknown", "").passed, false);
  const invented = g("escalation", "I'll pass it on, and we have 15:45 free too.", [{ name: "take_message" }]);
  assert.equal(invented.passed, false);
  assert.match(invented.detail!, /15:45/);
});

await test("stored replies never keep a card number", () => {
  assert.equal(selftest.redactCards("card 4111 1111 1111 1111 ok"), "card [card number removed] ok");
});

console.log("\n\x1b[1mA whole run\x1b[0m\n");

/** The stub venue model, but it gets one scenario wrong. */
const wrongFaq = (l: Loc): AgentModel => {
  const good = stubAgentModel(l);
  return async (params) => {
    const first = params.messages[0];
    if (params.messages.length === 1 && typeof first.content === "string" && /parking/.test(first.content)) {
      return { content: [{ type: "text", text: "Sorry, there is no parking anywhere near us." }] };
    }
    return good(params);
  };
};

await test("with the model scripted to answer the FAQ wrongly, that check fails and shows the reply", async () => {
  const out = await selftest.runSelftest(venue.id, { model: wrongFaq(getLocation(venue.id)!) });
  assert.ok(out.ok);
  if (!out.ok) return;
  const faq = out.results.find((r) => r.scenario === "faq")!;
  assert.equal(faq.passed, false);
  assert.match(faq.reply!, /no parking anywhere/);
  assert.ok(faq.detail && faq.fix);
  assert.equal(out.passed, false);
  assert.ok(out.results.filter((r) => r.scenario !== "faq").every((r) => r.passed), JSON.stringify(out.results.filter((r) => !r.passed)));
  const l = getLocation(venue.id)!;
  assert.equal(testsPassed(l), false);
  const j = journey(l, NO_FACTS);
  assert.equal(j.next?.id, "test");
  assert.equal(j.canGoLive, false);
  assert.match(j.blockers[0].label, /did not pass/);
});

/** The stub venue model, but it asks which booking instead of taking it down. */
const asksInsteadOfActing = (l: Loc): AgentModel => {
  const good = stubAgentModel(l);
  return async (params) => {
    const first = params.messages[0];
    if (params.messages.length === 1 && typeof first.content === "string" && /cancel/i.test(first.content)) {
      return {
        content: [
          { type: "text", text: "Good afternoon — happy to help. Can you tell me the date and time of the appointment you'd like to cancel?" },
        ],
      };
    }
    return good(params);
  };
};

await test("a run where it asks which booking and takes nothing fails the cancellation check, with no dead-end link", async () => {
  const out = await selftest.runSelftest(venue.id, { model: asksInsteadOfActing(getLocation(venue.id)!) });
  assert.ok(out.ok);
  if (!out.ok) return;
  const cancel = out.results.find((r) => r.scenario === "cancellation")!;
  assert.equal(cancel.passed, false);
  assert.match(cancel.detail!, /neither cancelled the booking nor passed/);
  assert.equal(cancel.fix, undefined, "the founder was sent to a page with nothing on it to change");
});

await test("Go live is refused with 409 and the blockers while a check fails, even called directly", async () => {
  const out = await activateVenue(venue.id, owner);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 409);
  assert.ok(out.blockers.some((b) => b.step === "test"));
  assert.equal(getLocation(venue.id)!.onboarding!.activatedAt, undefined);
});

await test("a clean run passes every check, records the digest and completes the step", async () => {
  const out = await selftest.runSelftest(venue.id, { model: stubAgentModel(getLocation(venue.id)!) });
  assert.ok(out.ok && out.passed, out.ok ? JSON.stringify(out.results.filter((r) => !r.passed)) : out.error);
  const l = getLocation(venue.id)!;
  assert.equal(l.onboarding!.tests!.digest, configDigest(l));
  assert.equal(l.onboarding!.tests!.results.length, 8);
  assert.ok(testsPassed(l));
  const j = journey(l, factsFrom(l, listCalls(l.id)));
  assert.equal(j.next?.id, "golive");
  assert.equal(j.canGoLive, true, JSON.stringify(j.blockers));
});

await test("the cancellation conversation called a tool, rather than only saying the right words", () => {
  const conversations = listCalls(venue.id, { includeTests: true }).filter((c) => c.summary === "Setup check: Handles a cancellation");
  assert.ok(conversations.length > 0, "no cancellation conversation was recorded");
  const acted = ["take_message", "request_human_handoff", "take_booking_request", "lookup_booking", "cancel_booking"];
  assert.ok(
    conversations.some((c) => c.toolCalls.some((t) => acted.includes(t.name) && t.ok !== false)),
    "every cancellation conversation ended with words and no action",
  );
});

await test("the booking check left a request on a test call, and nothing in the Inbox, stats or usage", () => {
  const all = listCalls(venue.id, { includeTests: true });
  assert.ok(all.length >= 16);
  assert.ok(all.every((c) => c.isTest));
  assert.equal(listCalls(venue.id).length, 0, "a test conversation is visible to stats and the Inbox");
  assert.ok(all.some((c) => (c.bookingRequests ?? []).length > 0));
  assert.deepEqual(factsFrom(getLocation(venue.id)!, listCalls(venue.id)), NO_FACTS);
});

await test("model spend is metered on the test channel, never as chat", () => {
  // The stub reports no usage; a real reply does. Meter one through the same path.
  flushCosts();
  const costs = listCosts({ venueId: venue.id });
  assert.ok(costs.every((c) => c.channel === "test"));
  assert.match(source("src/lib/onboarding/selftest.ts"), /channel: "test"/);
});

await test("a change after the checks makes them stale: the blocker says so and Go live is refused", async () => {
  const l = getLocation(venue.id)!;
  const changed = upsertLocation({ ...l, agent: { ...l.agent, faqs: [...l.agent.faqs, { q: "Do you do colour?", a: "Yes." }] } });
  assert.ok(testsStale(changed));
  const j = journey(changed, NO_FACTS);
  assert.equal(j.canGoLive, false);
  assert.match(j.blockers[0].label, /changed your setup after the last checks/);
  const out = await activateVenue(venue.id, owner);
  assert.ok(!out.ok && out.status === 409);
  upsertLocation(l);
  assert.ok(testsPassed(getLocation(venue.id)!));
});

await test("Go live, once the checks pass: activated, a 'Went live' version, and never twice", async () => {
  const before = historyFor(getLocation(venue.id)!).length;
  const out = await activateVenue(venue.id, owner);
  assert.ok(out.ok, out.ok ? "" : out.error);
  const l = getLocation(venue.id)!;
  assert.ok(l.onboarding!.activatedAt);
  assert.equal(l.onboarding!.activatedBy, owner.id);
  assert.equal(historyFor(l).length, before + 1);
  assert.equal(historyFor(l)[0].note, "Went live");
  // Going live changes no content, so the checks are still current.
  assert.ok(testsPassed(l));
  const again = await activateVenue(venue.id, owner);
  assert.ok(!again.ok && again.status === 409);
});

await test("after going live, a change marks the checks stale without taking the venue down", () => {
  const l = getLocation(venue.id)!;
  const changed = upsertLocation({ ...l, agent: { ...l.agent, greeting: "Hello from the new greeting." } });
  assert.ok(testsStale(changed));
  const j = journey(changed, NO_FACTS);
  assert.ok(j.activated);
  assert.equal(j.blockers.length, 0);
  assert.match(source("src/app/(app)/page.tsx"), /testsStale\(location\)[\s\S]{0,400}Re-run checks/);
});

console.log("\n\x1b[1mLimits and honest states\x1b[0m\n");

await test("with no model configured: 503, plain copy with no env names, and no run counted", async () => {
  const other = await signUp({ businessName: "No Model Cafe", email: "owner@nomodel.test", password: "Correct-Horse-Battery-9", vertical: "salon" });
  assert.ok(other.ok);
  if (!other.ok) return;
  const out = await selftest.runSelftest(other.location.id);
  assert.ok(!out.ok && out.status === 503);
  if (out.ok) return;
  assert.match(out.error, /being prepared/);
  assert.doesNotMatch(out.error, /ANTHROPIC|API|key|model/i);
  assert.equal(getLocation(other.location.id)!.onboarding!.selftestRuns, undefined);
});

await test(`the checks run at most ${selftest.DAILY_RUN_LIMIT} times a day per venue`, async () => {
  const other = await signUp({ businessName: "Limit Studio", email: "owner@limit.test", password: "Correct-Horse-Battery-9", vertical: "salon" });
  assert.ok(other.ok);
  if (!other.ok) return;
  const l = upsertLocation(ready(other.location));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: l.timezone }).format(new Date());
  upsertLocation({ ...l, onboarding: { ...l.onboarding!, selftestRuns: { date: today, count: selftest.DAILY_RUN_LIMIT } } });
  const out = await selftest.runSelftest(l.id, { model: stubAgentModel(l) });
  assert.ok(!out.ok && out.status === 429);
  // Yesterday's count does not carry over.
  upsertLocation({ ...getLocation(l.id)!, onboarding: { ...getLocation(l.id)!.onboarding!, selftestRuns: { date: "2020-01-01", count: 99 } } });
  const next = await selftest.runSelftest(l.id, { model: stubAgentModel(getLocation(l.id)!) });
  assert.ok(next.ok);
});

await test("at a diary venue, the booking check never writes a booking or messages anyone", async () => {
  const other = await signUp({ businessName: "Diary Studio", email: "owner@diary.test", password: "Correct-Horse-Battery-9", vertical: "salon" });
  assert.ok(other.ok);
  if (!other.ok) return;
  const base = ready(other.location);
  const l = upsertLocation({ ...base, onboarding: { ...base.onboarding!, destination: { kind: "belline", setAt: at } } });
  const bookingModel: AgentModel = async (params) => {
    const last = params.messages[params.messages.length - 1];
    if (params.messages.length === 1 && typeof last.content === "string" && /\bbook\b/i.test(last.content)) {
      return { content: [{ type: "tool_use", id: "toolu_book", name: "book", input: { date: "2030-01-01", time: "11:00", guest_name: "Sam Taylor", guest_phone: "0501234567", service_ids: ["svc_cut"] } }] };
    }
    return { content: [{ type: "text", text: "Thank you, the team will get back to you." }] };
  };
  const out = await selftest.runSelftest(l.id, { model: bookingModel });
  assert.ok(out.ok);
  assert.equal(listBookings({ locationId: l.id }).length, 0);
  const trace = listCalls(l.id, { includeTests: true }).flatMap((c) => c.toolCalls).find((t) => t.name === "book")!;
  assert.equal((trace.output as { check_only?: boolean }).check_only, true);
});

await test("a clinic passes its checks and still cannot go live: the blocker says clinics open soon", async () => {
  const other = await signUp({ businessName: "Checks Clinic", email: "owner@clinic-checks.test", password: "Correct-Horse-Battery-9", vertical: "clinic" });
  assert.ok(other.ok);
  if (!other.ok) return;
  const l = upsertLocation({ ...ready(other.location), vertical: "clinic" });
  const out = await selftest.runSelftest(l.id, { model: stubAgentModel(l) });
  assert.ok(out.ok);
  const j = journey(getLocation(l.id)!, NO_FACTS, new Date(), { clinicSelfServe: false });
  assert.equal(j.canGoLive, false);
  assert.ok(j.blockers.some((b) => b.step === "golive" && /Clinics open soon/.test(b.label)));
});

console.log("\n\x1b[1mSurfaces\x1b[0m\n");

await test("the activate route and the journey route both go through activateVenue and return the blockers", () => {
  const activate = source("src/app/api/setup/activate/route.ts");
  assert.match(activate, /activateVenue\(/);
  assert.match(activate, /blockers: out\.blockers/);
  assert.match(source("src/app/api/setup/journey/route.ts"), /action\.kind === "activate"[\s\S]{0,120}activateVenue\(/);
  assert.match(source("src/app/api/setup/selftest/route.ts"), /runSelftest\(location\.id\)/);
});

await test("step 7 lists the checks with the reply, the cause, Fix this and Fix with Belle", () => {
  const panel = source("src/app/setup/SelftestPanel.tsx");
  assert.match(panel, /Belline replied:/);
  assert.match(panel, /Fix with Belle/);
  assert.match(panel, /\/setup\/assistant\?step=test&check=/);
  assert.match(panel, /being prepared/);
  assert.match(source("src/app/setup/[step]/page.tsx"), /<SelftestPanel/);
  assert.match(source("src/app/setup/assistant/page.tsx"), /initialDraft=\{draft\}/);
});

await test("the widget is public only once live: pages, config, embed.js and the chat turn all check", () => {
  for (const page of ["src/app/embed/[key]/page.tsx", "src/app/embed/[key]/chat/page.tsx"]) {
    assert.match(source(page), /if \(!\(await widgetOpenFor\(location\)\)\)/, page);
  }
  assert.match(source("src/app/api/embed/[key]/config/route.ts"), /!isActivated\(location\)[\s\S]{0,120}live: false/);
  assert.match(source("public/embed.js"), /cfg\.live === false[\s\S]{0,40}dock\.remove\(\)/);
  assert.match(source("src/lib/webchat-turn.ts"), /= isActivated,/);
  for (const route of ["src/app/api/webchat/[key]/route.ts", "src/app/api/webchat/[key]/voice/route.ts"]) {
    assert.match(source(route), /resolveVisitor\([\s\S]{0,120}, widgetOpenFor\)/, route);
  }
  // The install ping stays open: detection is something Go live waits for.
  assert.doesNotMatch(source("src/app/api/embed/[key]/seen/route.ts"), /isActivated|widgetOpenFor/);
});

await test("nothing reached the network", () => {
  assert.equal(fetched, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
