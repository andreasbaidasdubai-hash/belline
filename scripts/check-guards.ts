/**
 * The guards an audit found open.
 *
 * Every test here pins something that was silently wrong in production and
 * that no existing suite could have caught, because each one sat at a seam —
 * between a page and a socket, between a role and a tenant, between a webhook
 * and the receipt it carried. The property in each case is the same: a check
 * that exists in one place must be the check that actually runs.
 *
 *   npm run check:guards
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-guards-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, saveCall, getCall, listCalls } = await import("../src/lib/store");
const { startCall, reconcileStaleCalls, isSpoken } = await import("../src/lib/calls");
const { enableEmbed, checkEmbedGate } = await import("../src/lib/embed");
const {
  checkDemoGate,
  checkConsoleGate,
  maxCallSeconds,
  callsToday,
  CONSOLE_CALLS_PER_DAY,
} = await import("../src/lib/demo");
const { twilioSignatureValid } = await import("../src/lib/voice/twilio-signature");
const { closeEpisode, ADAPTERS } = await import("../src/lib/reception/respond");
const { metaAdapter } = await import("../src/lib/reception/channel/meta");
const { twilioAdapter } = await import("../src/lib/reception/channel/twilio");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");

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

function head(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m\n`);
}

seedIfEmpty();

const signed = await signUp({
  businessName: "Guarded Salon",
  email: "owner@guarded.test",
  password: "Correct-Horse-Battery-9",
  timezone: "Asia/Dubai",
  vertical: "salon",
});
if (!signed.ok) throw new Error("could not create the test venue");

// ---------------------------------------------------------------------------
head("The widget's ceilings, where the call actually starts");

await test("the socket gate for a customer's widget is the widget's own cap", () => {
  const venue = enableEmbed(getLocation(signed.location.id)!, ["https://guarded.test"], {
    maxCallsPerDay: 2,
  });
  for (let i = 0; i < 2; i++) saveCall(startCall(venue, "embed", "website"));
  const fresh = getLocation(venue.id)!;
  // What the socket used to ask: a demo gate, which has nothing to say about a
  // venue that is not a demo — allowed, limit 0.
  assert.equal(checkDemoGate(fresh).allowed, true, "checkDemoGate is not the widget's gate");
  // What it asks now.
  assert.equal(checkEmbedGate(fresh).allowed, false, "two calls with a cap of two was not enough");
});

await test("the widget's per-call ceiling applies to the widget and not the telephone", () => {
  const venue = enableEmbed(getLocation(signed.location.id)!, ["https://guarded.test"], {
    maxCallSeconds: 60,
  });
  assert.equal(maxCallSeconds(venue, "embed"), 60, "the configured cap was not enforced");
  assert.equal(
    maxCallSeconds(venue, "phone"),
    venue.agent.maxCallSeconds,
    "a stranger's cap was applied to a real caller",
  );
  assert.equal(maxCallSeconds(venue, "browser"), venue.agent.maxCallSeconds);
});

await test("the test console does not spend the widget's cap", () => {
  const venue = enableEmbed(getLocation(signed.location.id)!, ["https://guarded.test"], {
    maxCallsPerDay: 1,
  });
  for (let i = 0; i < 5; i++) saveCall(startCall(venue, "browser", "browser-console"));
  assert.equal(
    checkEmbedGate(getLocation(venue.id)!).used,
    2,
    "staff testing their agent switched their own widget off",
  );
});

await test("the test console has a ceiling of its own", () => {
  const venue = getLocation(signed.location.id)!;
  const before = checkConsoleGate(venue).used;
  for (let i = before; i < CONSOLE_CALLS_PER_DAY; i++) {
    saveCall(startCall(venue, "browser", "browser-console"));
  }
  const gate = checkConsoleGate(getLocation(venue.id)!);
  assert.equal(gate.allowed, false, "a signup could run calls at our cost for ever");
  assert.ok(gate.message && !/limit|quota|cap/i.test(gate.message), gate.message);
});

// ---------------------------------------------------------------------------
head("Our own demo line");

await test("a demo call through the browser counts toward the demo cap", () => {
  // The bell on the front page. The socket flags these as demos now; before,
  // only the telephone path did, and seventy calls through the bell counted
  // as none.
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  const before = callsToday(belline);
  const call = startCall(belline, "browser", "bell");
  call.isDemo = true;
  saveCall(call);
  assert.equal(callsToday(getLocation(BELLINE_LOCATION_ID)!), before + 1);
});

await test("the demo cap closes the line when reached", () => {
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  for (let i = callsToday(belline); i < belline.demo!.maxCallsPerDay; i++) {
    const call = startCall(belline, "browser", "bell");
    call.isDemo = true;
    saveCall(call);
  }
  assert.equal(checkDemoGate(getLocation(BELLINE_LOCATION_ID)!).allowed, false);
});

// ---------------------------------------------------------------------------
head("Twilio's signature, without a token");

const url = "https://app.belline.ai/api/twilio/voice";
const params = { To: "+15717785920", From: "+971501234567", CallSid: "CA1" };

await test("a missing token refuses in production", () => {
  assert.equal(
    twilioSignatureValid(url, params, "anything", { token: undefined, production: true }),
    false,
    "a lost environment variable opened metered calls to every venue",
  );
});

await test("a missing token is tolerated in development, so the thing can be run locally", () => {
  assert.equal(twilioSignatureValid(url, params, null, { token: undefined, production: false }), true);
});

await test("with a token, a wrong signature is refused and a right one accepted", async () => {
  const crypto = await import("node:crypto");
  const token = "test-auth-token";
  const payload = url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join("");
  const good = crypto.createHmac("sha1", token).update(payload, "utf8").digest("base64");
  assert.equal(twilioSignatureValid(url, params, good, { token, production: true }), true);
  assert.equal(twilioSignatureValid(url, params, "bad", { token, production: true }), false);
  assert.equal(twilioSignatureValid(url, params, null, { token, production: true }), false);
});

// ---------------------------------------------------------------------------
head("Episodes that are not calls");

await test("the boot sweep leaves message threads alone", () => {
  const venue = getLocation(signed.location.id)!;
  const thread = startCall(venue, "whatsapp", "+971509990009");
  const chat = startCall(venue, "webchat", "Website");
  const line = startCall(venue, "phone", "+971509990010");
  reconcileStaleCalls();
  assert.equal(getCall(thread.id)!.status, "active", "an open WhatsApp thread was marked interrupted");
  assert.equal(getCall(chat.id)!.status, "active", "an open website chat was marked interrupted");
  assert.equal(getCall(line.id)!.status, "failed", "a call the server died under was left active");
  assert.equal(isSpoken("embed"), true);
  assert.equal(isSpoken("webchat"), false);
});

await test("closing a conversation completes its episode", () => {
  const venue = getLocation(signed.location.id)!;
  const thread = startCall(venue, "webchat", "Website");
  closeEpisode(thread.id, "Closed by a test.");
  const done = getCall(thread.id)!;
  assert.equal(done.status, "completed");
  assert.ok(done.endedAt, "no end time");
  assert.equal(done.summary, "Closed by a test.");
  // Idempotent: closing twice does not overwrite what the first close wrote.
  closeEpisode(thread.id, "Closed again.");
  assert.equal(getCall(thread.id)!.summary, "Closed by a test.");
});

// ---------------------------------------------------------------------------
head("Every provider has an adapter, and receipts know their number");

await test("the registry covers every provider the type allows", () => {
  // Two registries drifted once; this is what stops the one that is left from
  // drifting from the type. A provider added to the union without an adapter
  // fails here rather than as a 500 in the inbox.
  const providers = ["meta", "twilio", "internal", "webchat"] as const;
  for (const p of providers) {
    assert.ok(ADAPTERS[p], `no adapter for ${p}`);
    assert.equal(ADAPTERS[p].provider, p);
  }
});

await test("a Meta receipt carries the number it is about", () => {
  const { statuses } = metaAdapter.parse(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: "15550001111", phone_number_id: "PNID1" },
                statuses: [{ id: "wamid.R1", status: "delivered", timestamp: "1700000000" }],
              },
            },
          ],
        },
      ],
    }),
  );
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].toE164, "+15550001111");
  assert.equal(statuses[0].externalNumberId, "PNID1");
});

await test("a Twilio receipt carries the number it went out on", () => {
  const body = new URLSearchParams({
    MessageSid: "SM1",
    MessageStatus: "read",
    From: "whatsapp:+15550002222",
    To: "whatsapp:+971509990009",
  }).toString();
  const { statuses } = twilioAdapter.parse(body);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].toE164, "+15550002222");
});

// ---------------------------------------------------------------------------
head("A business that confirms its own bookings is never told it has one");

const {
  checkRequestReply,
  checkSlotOffers,
  checkTimes,
  publishedTimes,
  repairReply,
  repairRequestReply,
  repairSlotOffers,
  REQUEST_NO_SLOT,
} = await import("../src/lib/agent/honesty");
type ToolTrace = import("../src/lib/types").ToolTrace;
const trace = (name: string, output: unknown): ToolTrace => ({
  at: new Date().toISOString(),
  name,
  input: {},
  output,
  ms: 3,
  ok: true,
});
const { executeTool } = await import("../src/lib/agent/tools");
const guardRoot = path.resolve(import.meta.dirname, "..");
const requestVenue = {
  ...getLocation(signed.location.id)!,
  onboarding: { version: 1 as const, channels: {}, destination: { kind: "requests" as const, setAt: new Date().toISOString() } },
};

await test("replies that claim a booking are caught", () => {
  for (const reply of [
    "You're booked for Friday at 8pm.",
    "Lovely, see you Friday!",
    "Your table for 4 is confirmed.",
    "All set — a table for four at eight.",
    "I've reserved that for you.",
  ]) {
    assert.equal(checkRequestReply(reply).ok, false, reply);
  }
});

await test("honest request replies pass untouched", () => {
  for (const reply of [
    "Your request for a table for 4 on Friday at 8pm is with the team, and they'll get back to you to confirm.",
    "Nothing is booked until the team confirms it.",
    "The team will confirm once it's booked in.",
    "I can't see the diary, so I can't say whether 8pm is free.",
  ]) {
    assert.equal(checkRequestReply(reply).ok, true, reply);
  }
});

await test("a repaired reply keeps the rest and never says confirmed, booked or see you", () => {
  const reply = "Thanks Sara. You're booked for Friday at 8pm, see you then! Parking is behind the building.";
  const repaired = repairRequestReply(reply, checkRequestReply(reply));
  assert.doesNotMatch(repaired, /confirmed|booked|see you/i);
  assert.match(repaired, /Thanks Sara\./);
  assert.match(repaired, /Parking is behind the building\./);
  assert.match(repaired, /with the team/);
});

await test("repeating the requested time back is not an invented time", () => {
  const traces = [{ at: "", name: "take_booking_request", input: {}, output: { requested: true, requested_time: "20:00" }, ms: 1, ok: true }];
  assert.equal(checkTimes("I've passed on your request for 8:00 PM on Friday.", traces).ok, true);
});

await test("the message path runs the request guard for request-only venues", () => {
  const respond = fs.readFileSync(path.join(guardRoot, "src/lib/reception/respond.ts"), "utf8");
  assert.match(respond, /takesRequestsOnly\(location\)/);
  assert.match(respond, /checkRequestReply\(reply\)/);
  assert.match(respond, /ai\.claimed_confirmation/);
});

await test("a request-only venue refuses a diary tool with words to say, not an error", async () => {
  const call = startCall(requestVenue, "webchat", "visitor");
  const out = await executeTool("check_availability", { date: "2030-01-01", service_ids: [] }, { location: requestVenue, call });
  assert.match(JSON.stringify(out.result), /not_supported/);
  assert.match(JSON.stringify(out.result), /take_booking_request/);
});

// ---------------------------------------------------------------------------
head("A business that confirms nothing never proposes a time");

/**
 * Both cases come from Belline's own eight-scenario check, run against a real
 * staging venue that takes requests. It proposed times it had no way to confirm
 * twice: once offering to "send that through" at a time no tool had returned,
 * and once — the instructive one — reasoning from the opening hours to a slot.
 *
 * Stating the hours was right. "The latest we could fit you in is around 5:30"
 * was a promise nothing in the venue's setup could keep.
 */
const DAY = [{ start: 540, end: 1080 }]; // 9 to 6, every day
const slotVenue = {
  ...requestVenue,
  closures: [],
  hours: { 0: DAY, 1: DAY, 2: DAY, 3: DAY, 4: DAY, 5: DAY, 6: DAY },
};
const { grade, scenariosFor } = await import("../src/lib/onboarding/selftest");
const scenarioOf = (id: string) => scenariosFor(slotVenue).find((s) => s.id === id)!;
const graded = (id: string, reply: string, traces: ToolTrace[] = []) =>
  grade(slotVenue, scenarioOf(id), { reply, traces });

await test("the closed-day transcript: the invented slot goes, the hours and their own time stay", () => {
  const reply =
    "We're open Thursdays 9 to 6, so 7 PM would be outside our hours — the latest we could fit you in is around 5:30 PM to finish by 6.";
  const verdict = checkSlotOffers(reply);
  assert.equal(verdict.ok, false, "a proposed slot was not seen as one");
  const repaired = repairSlotOffers(reply, verdict);
  // What must survive: the hours, and the time the customer asked about.
  assert.match(repaired, /open Thursdays 9 to 6/, repaired);
  assert.match(repaired, /7 PM/, repaired);
  // What must not: the slot, and any suggestion Belline can see a diary.
  assert.doesNotMatch(repaired, /5:30|fit you in/i, repaired);
  assert.doesNotMatch(repaired, /anything free|another day/i, repaired);
  assert.match(repaired, /pass it to the team/, repaired);
  // And the whole reply still fails the venue's own check, as it did on staging.
  assert.equal(graded("out_of_hours", reply).passed, false);
});

await test("a slot dressed as the venue's own closing time is caught", () => {
  // This passed every gate: 18:00 is a published closing time and the sentence
  // mentions the hours, so the invention check exempted it and the setup check
  // returned passed. The offer is what makes it wrong, not the number.
  const reply = "We're closed by then, but I could fit you in at 6:00 PM.";
  const verdict = checkTimes(reply, [], publishedTimes(slotVenue));
  assert.equal(verdict.ok, false, "an offer still borrowed the opening-hours exemption");
  assert.deepEqual(verdict.invented, [18 * 60]);
  assert.equal(checkSlotOffers(reply).ok, false);
  assert.equal(graded("out_of_hours", reply).passed, false, "the setup check passed a slot nothing can hold");
});

await test("a time the request tool echoed back may still not be offered", () => {
  // Why this check exists next to the invention check rather than inside it:
  // take_booking_request echoes the customer's own time, which licenses that
  // time for the rest of the conversation. Licensed is not the same as free.
  const traces = [trace("take_booking_request", { requested: true, requested_time: "20:00" })];
  const reply = "I have 8:00 PM for you on Friday.";
  assert.equal(checkTimes(reply, traces).ok, true, "precondition: the echo licenses the time");
  assert.equal(checkSlotOffers(reply).ok, false, "offering it is still a slot nothing can hold");
});

await test("the booking transcript: asking whether to pass it on fails; taking the request passes", () => {
  const asked =
    "Good morning, Sam — happy to send that through. Just to confirm, that's tomorrow at 10:00 AM, to the number 050 123 4567 — shall I pass this on to the team?";
  const askedVerdict = graded("booking", asked);
  assert.equal(askedVerdict.passed, false);
  assert.match(askedVerdict.detail!, /did not pass the booking request/);

  const took = [trace("take_booking_request", { requested: true, requested_time: "10:00" })];
  const done = "Thanks Sam — that's tomorrow at 10:00 AM on 050 123 4567, and it's with the team now to confirm.";
  const doneVerdict = graded("booking", done, took);
  assert.equal(doneVerdict.passed, true, JSON.stringify(doneVerdict));
});

await test("the honest replies a request-only venue must still be able to send", () => {
  for (const reply of [
    "We're open Thursdays 9 to 6, so 7 PM would be outside our hours.",
    "We're open every day from 9:00 AM until 6:00 PM.",
    "Your request for 8:00 PM on Friday is with the team, and they'll get back to you to confirm.",
    "I can't see the diary, so I can't say whether 6:00 PM is free.",
    "Thanks Sam — I've passed your request for 10:00 AM tomorrow to the team.",
  ]) {
    assert.equal(checkSlotOffers(reply).ok, true, reply);
    // Untouched, byte for byte: a guard that rewrites honest replies is one
    // somebody switches off.
    assert.equal(repairSlotOffers(reply, checkSlotOffers(reply)), reply, reply);
  }
});

await test("the repair at a request-only venue never claims to know what is free", () => {
  const reply = "I have 5:30 PM free.";
  const repaired = repairReply(reply, checkTimes(reply, []), { requestsOnly: true });
  assert.equal(repaired, REQUEST_NO_SLOT);
  assert.doesNotMatch(repaired, /anything free|another day|tell you exactly/i, repaired);
  assert.doesNotMatch(repaired, /\d{1,2}:\d{2}/, repaired);
});

await test("a venue with its own diary may still offer the times it checked", () => {
  // The offer test tightens the invention check for everyone, so this is the
  // side that must not move: a checked time, offered, at a venue that can book.
  const diary = getLocation(signed.location.id)!;
  const traces = [trace("check_availability", { slots: [{ time: "10:00", startMin: 600 }] })];
  assert.equal(checkTimes("I have 10:00 free tomorrow — shall I book it?", traces, publishedTimes(diary)).ok, true);
});

await test("the message path runs the slot guard before the invention check", () => {
  const respond = fs.readFileSync(path.join(guardRoot, "src/lib/reception/respond.ts"), "utf8");
  assert.match(respond, /checkSlotOffers\(reply\)/);
  assert.match(respond, /ai\.offered_slot/);
  assert.match(respond, /repairReply\(reply, honesty, \{ requestsOnly \}\)/);
  assert.ok(
    respond.indexOf("checkSlotOffers(reply)") < respond.indexOf("const honesty = checkTimes("),
    "the clause-level repair must run before the sentence-level one",
  );
});

// ---------------------------------------------------------------------------
head("A cancellation at a business that cannot cancel anything");

/**
 * The other half of the instinct commit 5a7b383 gave bookings.
 *
 * A request-only venue has no diary tools at all, so a cancellation has exactly
 * one place to go: take_message. Asked to cancel on staging, Belline asked
 * which booking and took nothing down — polite, on topic, and the customer went
 * away believing it was dealt with while the team still expected them.
 *
 * Pinned at the tool layer as well as the prompt, because the tool list is what
 * the model reads while it decides what it is able to do.
 */
const { toolsFor } = await import("../src/lib/agent/tools");
const { staticPrompt } = await import("../src/lib/agent/prompt");

await test("the tool list gives a cancellation somewhere to go, on both channels", () => {
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(requestVenue, channel);
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("cancel_booking") && !names.includes("lookup_booking"), `${channel} can see a diary it has not got`);
    const message = tools.find((t) => t.name === "take_message")!;
    assert.match(message.description!, /cancel/i, `${channel}: no tool says where a cancellation goes`);
    assert.match(message.description!, /same turn/i, `${channel}: nothing says to take it down in the turn they ask`);
    assert.match(message.description!, /never say/i, channel);
  }
});

await test("the prompt says take it down in the same turn, and never call it cancelled", () => {
  for (const channel of ["voice", "text"] as const) {
    const prompt = staticPrompt(requestVenue, channel);
    assert.match(prompt, /take_message in that same turn/i, channel);
    assert.match(prompt, /never say a booking has been cancelled/i, channel);
  }
});

await test("the cancellation transcript: asking which booking and taking nothing fails; taking it passes", () => {
  const asked = "Good afternoon — happy to help. Can you tell me the date and time of the appointment you'd like to cancel?";
  const only = graded("cancellation", asked);
  assert.equal(only.passed, false);
  assert.match(only.detail!, /neither cancelled the booking nor passed/);
  // And nowhere to send the owner: no setup page cancels a booking.
  assert.equal(only.fix, undefined);

  const took = graded("cancellation", `${asked} I've passed it to the team in the meantime.`, [trace("take_message", { saved: true })]);
  assert.equal(took.passed, true, JSON.stringify(took));
});

await test("the slot verdict sends nobody to a page that has no such control either", () => {
  const echoed = [trace("take_booking_request", { requested: true, requested_time: "20:00" })];
  const v = graded("booking", "I have 8:00 PM for you on Friday.", echoed);
  assert.equal(v.passed, false);
  assert.match(v.detail!, /It offered the customer a time/);
  assert.equal(v.fix, undefined);
});

// ---------------------------------------------------------------------------

void listCalls;
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
