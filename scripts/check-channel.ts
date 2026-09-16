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

console.log("\n\x1b[1mThe forwarding test call\x1b[0m\n");

{
  const { upsertLocation, listCalls, findCallBySid } = await import("../src/lib/store");
  const { openWindow, isVerificationCall, recordVerificationCall, verificationState, TEST_SCRIPT, WINDOW_MINUTES } = await import(
    "../src/lib/telephony/verify"
  );
  const { startCall } = await import("../src/lib/calls");
  const { billableVoiceMinutes } = await import("../src/lib/billing/usage");
  const { journey } = await import("../src/lib/onboarding/journey");
  const { listExceptions } = await import("../src/lib/exceptions");

  // Async tests in this block; the ones above are synchronous.
  const tests: [string, () => void | Promise<void>][] = [];
  const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
  const quiet = <T,>(fn: () => T): T => {
    const error = console.error;
    console.error = () => {};
    try {
      return fn();
    } finally {
      console.error = error;
    }
  };

  const BELLINE = "+97140000001";
  const OWN = "+971501234567";
  const venue = () => getLocation("loc_lumiere")!;
  upsertLocation({
    ...venue(),
    phone: BELLINE,
    agent: { ...venue().agent, transferNumber: OWN },
    onboarding: { version: 1, channels: {} },
  });
  const now = new Date();
  const params = (extra: Record<string, string> = {}) => ({ To: BELLINE, From: "+971509999999", CallSid: "CA_test_1", ...extra });

  t("with no window open, a call to the Belline number is a real call", () => {
    assert.equal(isVerificationCall(venue(), params(), now), false);
  });

  t("inside the window, a call to the venue's number is the test; to another number it is not", () => {
    const opened = openWindow(venue(), "du", now);
    assert.ok(opened.ok);
    assert.equal(venue().onboarding?.channels.phone?.carrier, "du");
    assert.equal(isVerificationCall(venue(), params(), now), true);
    assert.equal(isVerificationCall(venue(), params({ To: "+97140000999" }), now), false);
  });

  t("when Twilio names the forwarding line, it has to be the owner's own", () => {
    assert.equal(isVerificationCall(venue(), params({ ForwardedFrom: "045550000" }), now), false, "a stranger's forwarded call counted");
    assert.equal(isVerificationCall(venue(), params({ ForwardedFrom: "0501234567" }), now), true, "the owner's line in national form was refused");
    assert.equal(isVerificationCall(venue(), params({ CalledVia: "+971501234567" }), now), true);
  });

  t("the window closes after ten minutes", () => {
    const after = new Date(now.getTime() + (WINDOW_MINUTES + 1) * 60_000);
    assert.equal(isVerificationCall(venue(), params(), after), false);
  });

  t("a test call marks forwarding verified, is stored as a test, bills 0 and is kept out of the call list", () => {
    const before = listCalls(venue().id).length;
    const call = recordVerificationCall(venue(), params(), now);
    assert.equal(call.isTest, true);
    assert.equal(call.transcript[0].text, TEST_SCRIPT);
    assert.equal(billableVoiceMinutes(call), 0);
    assert.ok(venue().onboarding?.channels.phone?.forwardingVerifiedAt);
    assert.equal(venue().onboarding?.channels.phone?.verification, undefined, "the window stayed open after verifying");
    assert.equal(listCalls(venue().id).length, before, "the test call shows in the venue's calls and counts");
    assert.ok(listCalls(venue().id, { includeTests: true }).some((c) => c.id === call.id));
    assert.equal(journey(venue()).steps.find((s) => s.id === "channels")!.done, true);
    assert.equal(verificationState(venue()).state, "verified");
  });

  t("the same CallSid twice records one test call", () => {
    const again = recordVerificationCall(venue(), params(), now);
    assert.equal(again.id, findCallBySid("CA_test_1")!.id);
    assert.equal(listCalls(venue().id, { includeTests: true }).filter((c) => c.callSid === "CA_test_1").length, 1);
  });

  t("the same CallSid twice on a real call creates one call", () => {
    const a = startCall(venue(), "phone", "+971508888888", { callSid: "CA_real_1" });
    const b = startCall(venue(), "phone", "+971508888888", { callSid: "CA_real_1" });
    assert.equal(a.id, b.id);
    assert.equal(listCalls(venue().id).filter((c) => c.callSid === "CA_real_1").length, 1);
    const c = startCall(venue(), "phone", "+971508888888", { callSid: "CA_real_2" });
    assert.notEqual(c.id, a.id);
  });

  t("two windows with no call open a ticket; the owner is shown what to check", () => {
    const salonB = getLocation("loc_azure")!;
    upsertLocation({ ...salonB, phone: "+97140000002", onboarding: { version: 1, channels: {} } });
    const t0 = new Date("2026-09-15T10:00:00.000Z");
    const late = (m: number) => new Date(t0.getTime() + m * 60_000);
    openWindow(getLocation(salonB.id)!, "eand", t0);
    assert.equal(quiet(() => verificationState(getLocation(salonB.id)!, late(11))).state, "expired");
    openWindow(getLocation(salonB.id)!, "eand", late(12));
    const second = quiet(() => verificationState(getLocation(salonB.id)!, late(30)));
    assert.deepEqual(second, { state: "expired", failedWindows: 2 });
    assert.equal(listExceptions({ locationId: salonB.id, kind: "forwarding_unverified_2x" }).length, 1);
  });

  t("the voice webhook still refuses a bad signature before it looks at the window", async () => {
    const { POST } = await import("../src/app/api/twilio/voice/route");
    const keep = { ...process.env };
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    try {
      const res = await POST(
        new Request("https://app.belline.ai/api/twilio/voice", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "forged", host: "app.belline.ai" },
          body: new URLSearchParams(params({ CallSid: "CA_forged" })).toString(),
        }),
      );
      assert.equal(res.status, 403);
      assert.equal(findCallBySid("CA_forged"), undefined);
    } finally {
      process.env = keep;
    }
  });

  t("a signed call inside the window gets the test script and hangs up, with no stream", async () => {
    const crypto = await import("node:crypto");
    const { POST } = await import("../src/app/api/twilio/voice/route");
    const salonC = getLocation("loc_azure")!;
    upsertLocation({ ...salonC, phone: "+97140000003", onboarding: { version: 1, channels: {} } });
    openWindow(getLocation(salonC.id)!, "du");
    const keep = { ...process.env };
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    try {
      const url = "https://app.belline.ai/api/twilio/voice";
      const form = { To: "+97140000003", From: "+971507777777", CallSid: "CA_signed_1" };
      const payload = url + Object.keys(form).sort().map((k) => k + form[k as keyof typeof form]).join("");
      const signature = crypto.createHmac("sha1", "test-token").update(payload, "utf8").digest("base64");
      const send = () =>
        POST(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature, host: "app.belline.ai", "x-forwarded-proto": "https" },
            body: new URLSearchParams(form).toString(),
          }),
        );
      const res = await send();
      const xml = await res.text();
      assert.equal(res.status, 200);
      assert.ok(xml.includes("Belline test call"), xml);
      assert.ok(!xml.includes("<Stream"), "the test call opened a metered stream");
      assert.ok(getLocation(salonC.id)!.onboarding?.channels.phone?.forwardingVerifiedAt);
      const retry = await (await send()).text();
      assert.ok(retry.includes("Belline test call"), "Twilio's retry of the same call reached the agent");
      assert.equal(listCalls(salonC.id, { includeTests: true }).filter((c) => c.callSid === "CA_signed_1").length, 1);
    } finally {
      process.env = keep;
    }
  });

  t("a real call to a venue that has not gone live is not answered: no stream, no agent; once live, it is", async () => {
    const crypto = await import("node:crypto");
    const { POST } = await import("../src/app/api/twilio/voice/route");
    const venueD = getLocation("loc_lumiere")!;
    upsertLocation({ ...venueD, phone: "+97140000004", onboarding: { version: 1, channels: { phone: { forwardingVerifiedAt: "2026-09-15T10:00:00.000Z" } } } });
    const keep = { ...process.env };
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    try {
      const url = "https://app.belline.ai/api/twilio/voice";
      const call = async (sid: string) => {
        const form = { To: "+97140000004", From: "+971506666666", CallSid: sid };
        const payload = url + Object.keys(form).sort().map((k) => k + form[k as keyof typeof form]).join("");
        const signature = crypto.createHmac("sha1", "test-token").update(payload, "utf8").digest("base64");
        const res = await POST(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature, host: "app.belline.ai", "x-forwarded-proto": "https" },
            body: new URLSearchParams(form).toString(),
          }),
        );
        assert.equal(res.status, 200);
        return res.text();
      };
      const before = await quiet(() => call("CA_not_live_1"));
      assert.ok(!before.includes("<Stream"), "a real customer reached the agent before Go live");
      assert.ok(before.includes("<Hangup/>"));
      assert.doesNotMatch(before, /setup|trial|checks|go live|plan/i, "the caller was told about the owner's setup");
      const live = getLocation(venueD.id)!;
      upsertLocation({ ...live, onboarding: { ...live.onboarding!, activatedAt: "2026-09-15T11:00:00.000Z" } });
      const after = await quiet(() => call("CA_live_1"));
      assert.ok(after.includes("<Stream"), after);
    } finally {
      process.env = keep;
    }
  });

  for (const [name, fn] of tests) {
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
}

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
