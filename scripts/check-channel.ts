/**
 * One brain, two mouths.
 *
 * The whole argument for building WhatsApp inside Belline rather than beside
 * it is that a business configures itself once. The way that claim fails is
 * not dramatically — it is a second prompt that drifts, and one day the agent
 * quotes a different cancellation policy on WhatsApp than it does on the
 * telephone, and nobody notices until a guest does.
 *
 * So this pins the property directly: everything that comes from the Business
 * Brain is byte-identical across channels, and the only differences are the
 * two blocks that describe the medium and the control verbs that belong to it.
 *
 *   npm run check:channel
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-channel-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation } = await import("../src/lib/store");
const { staticPrompt, callContext } = await import("../src/lib/agent/prompt");
const { toolsFor } = await import("../src/lib/agent/tools");

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

seedIfEmpty();
const salon = getLocation("loc_lumiere")!;
const restaurant = getLocation("loc_azure")!;

const voice = staticPrompt(salon, "voice");
const text = staticPrompt(salon, "text");

console.log("\n\x1b[1mThe business is configured once\x1b[0m\n");

test("every house rule appears on both channels", () => {
  for (const policy of salon.agent.policies) {
    assert.ok(voice.includes(policy), `voice is missing a policy: ${policy.slice(0, 50)}`);
    assert.ok(text.includes(policy), `text is missing a policy: ${policy.slice(0, 50)}`);
  }
  assert.ok(salon.agent.policies.length > 0, "the fixture has no policies to test with");
});

test("every FAQ answer appears on both channels", () => {
  for (const faq of salon.agent.faqs) {
    assert.ok(voice.includes(faq.a), `voice is missing an answer: ${faq.q}`);
    assert.ok(text.includes(faq.a), `text is missing an answer: ${faq.q}`);
  }
  assert.ok(salon.agent.faqs.length > 0, "the fixture has no FAQs to test with");
});

test("the persona and the venue's own details are the same on both", () => {
  for (const fragment of [salon.agent.persona, salon.name, salon.address, salon.phone]) {
    assert.ok(voice.includes(fragment), `voice is missing: ${fragment.slice(0, 40)}`);
    assert.ok(text.includes(fragment), `text is missing: ${fragment.slice(0, 40)}`);
  }
});

test("the booking rules are the same on both", () => {
  const rule = "Never state availability from memory or assumption";
  assert.ok(voice.includes(rule));
  assert.ok(text.includes(rule));
});

test("services and prices are the same on both", () => {
  for (const service of salon.salon!.services.slice(0, 3)) {
    assert.ok(voice.includes(service.name), `voice is missing ${service.name}`);
    assert.ok(text.includes(service.name), `text is missing ${service.name}`);
  }
});

test("the two prompts differ only where the medium does", () => {
  // Everything outside the medium and closing blocks should be identical. If
  // this ever fails, something venue-specific has been written into one branch
  // and not the other — which is the drift this file exists to catch.
  const strip = (p: string) =>
    p
      .replace(/# You are speaking[\s\S]*?\n\n# Booking rules/, "\n\n# Booking rules")
      .replace(/# You are writing[\s\S]*?\n\n# Booking rules/, "\n\n# Booking rules")
      .replace(/# Ending the call[\s\S]*$/, "")
      .replace(/# When to fetch a person[\s\S]*$/, "")
      // The opening sentence names the medium, deliberately.
      .replace("answering the telephone for", "answering for")
      .replace("answering messages for", "answering for")
      .replace("Call the people who get in touch", "Call the people");
  assert.equal(strip(text), strip(voice));
});

console.log("\n\x1b[1mThe medium is the only difference\x1b[0m\n");

test("voice is told it is heard, text is told it is read", () => {
  assert.ok(voice.includes("read aloud by a speech engine"));
  assert.ok(text.includes("One message, sent once"));
  assert.equal(voice.includes("One message, sent once"), false);
  assert.equal(text.includes("read aloud by a speech engine"), false);
});

test("text is told not to write a menu, voice is told not to write markdown", () => {
  assert.ok(text.includes('never "reply 1 for bookings"'));
  assert.ok(text.includes("Never break an answer into three bubbles"));
  assert.ok(voice.includes("Never use markdown"));
});

test("times are spoken on one and written on the other", () => {
  assert.ok(voice.includes('"seven thirty" or "quarter past eight"'));
  assert.ok(text.includes('"4:30 PM"'));
});

test("a call ends; a conversation does not", () => {
  assert.ok(voice.includes("# Ending the call"));
  assert.equal(text.includes("# Ending the call"), false);
  assert.ok(text.includes("# When to fetch a person"));
});

console.log("\n\x1b[1mThe control verbs belong to the channel\x1b[0m\n");

const voiceTools = toolsFor(salon, "voice").map((t) => t.name);
const textTools = toolsFor(salon, "text").map((t) => t.name);

test("the working tools are identical on both channels", () => {
  const working = [
    "check_availability",
    "book",
    "lookup_booking",
    "change_booking",
    "cancel_booking",
    "join_waitlist",
    "take_message",
  ];
  for (const name of working) {
    assert.ok(voiceTools.includes(name), `voice is missing ${name}`);
    assert.ok(textTools.includes(name), `text is missing ${name}`);
  }
});

test("only voice can end or transfer a call", () => {
  assert.ok(voiceTools.includes("end_call"));
  assert.ok(voiceTools.includes("transfer_call"));
  assert.equal(textTools.includes("end_call"), false, "the agent can hang up a message thread");
  assert.equal(textTools.includes("transfer_call"), false);
});

test("only text can hand the thread to a person", () => {
  assert.ok(textTools.includes("request_human_handoff"));
  assert.equal(voiceTools.includes("request_human_handoff"), false);
});

test("the handoff tool asks for a summary, not just a reason", () => {
  // Staff should not have to read the thread before they can reply. If this
  // field ever becomes optional, that is the thing that quietly breaks.
  const tool = toolsFor(salon, "text").find((t) => t.name === "request_human_handoff")!;
  const required = (tool.input_schema as { required?: string[] }).required ?? [];
  assert.ok(required.includes("summary"));
  assert.ok(required.includes("reason"));
});

test("a restaurant still gets party size and a salon still gets services", () => {
  // The vertical shape survives the channel split — it would be easy to lose
  // it in a branch.
  const rBook = toolsFor(restaurant, "text").find((t) => t.name === "book")!;
  const sBook = toolsFor(salon, "text").find((t) => t.name === "book")!;
  const req = (t: typeof rBook) => (t.input_schema as { required?: string[] }).required ?? [];
  assert.ok(req(rBook).includes("party_size"));
  assert.ok(req(sBook).includes("service_ids"));
});

console.log("\n\x1b[1mContext\x1b[0m\n");

test("the context calls them a caller or a customer, correctly", () => {
  const v = callContext(salon, { callerNumber: "+971501234567", channel: "voice" });
  const t = callContext(salon, { callerNumber: "+971501234567", channel: "text" });
  assert.ok(v.includes("caller is dialling from"));
  assert.ok(t.includes("customer is messaging from"));
});

test("both are given today's date in the venue's own timezone", () => {
  const v = callContext(salon, { channel: "voice" });
  const t = callContext(salon, { channel: "text" });
  assert.ok(v.includes(salon.timezone));
  assert.ok(t.includes(salon.timezone));
  // And both are told to resolve "tomorrow" themselves rather than pass it on.
  assert.ok(v.includes("Work out what"));
  assert.ok(t.includes("Work out what"));
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
