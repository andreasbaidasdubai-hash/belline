/**
 * The Action Inbox.
 *
 * The value of this list is entirely in what it leaves out. An inbox that
 * shows every call is a call log; an inbox that misses the patient Belline
 * sent to A&E is worse than no inbox at all. So these tests are as much about
 * the calls that must NOT appear as the ones that must.
 *
 *   npm run check:attention
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-attn-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, saveCall } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { attentionFor, resolveAttention } = await import("../src/lib/attention");
const type = await import("../src/lib/types");

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

seedIfEmpty();
const clinic = listLocations().find((l) => l.vertical === "clinic")!;

type Turn = { role: "caller" | "agent"; text: string; at: string };

function finished(overrides: Partial<import("../src/lib/types").Call>, said: string[] = []) {
  const call = startCall(clinic, "phone", "+441234567890");
  const transcript: Turn[] = said.map((text, i) => ({
    role: i % 2 === 0 ? "caller" : "agent",
    text,
    at: new Date().toISOString(),
  }));
  return saveCall({
    ...call,
    status: "completed",
    endedAt: new Date().toISOString(),
    transcript,
    ...overrides,
  });
}

console.log("\nWhat must appear\n");

test("a call sent to emergency care is the most urgent thing on the list", () => {
  const call = finished(
    { outcome: "escalated", authorityRuleId: "medical-emergency", summary: "Chest pain" },
    ["My chest is tight and I can't breathe."],
  );
  const items = attentionFor(clinic);
  const item = items.find((i) => i.callId === call.id);
  assert.ok(item, "an escalated call did not reach the inbox");
  assert.equal(item.kind, "escalated");
  assert.equal(items[0].callId, call.id, "it was not sorted to the top");
  assert.match(item.todo, /back/i, "it does not say to ring them back");
});

test("it carries the rule's own reason, not a generic one", () => {
  const item = attentionFor(clinic).find((i) => i.kind === "escalated")!;
  assert.match(item.why, /emergency|appointment/i);
});

test("a message taken is on the list with the details", () => {
  const call = finished({
    outcome: "message_taken",
    escalation: "Sara Meyer (07700900222): wants a callback about her results",
  });
  const item = attentionFor(clinic).find((i) => i.callId === call.id);
  assert.ok(item);
  assert.equal(item.kind, "message");
  assert.match(item.what, /Sara Meyer/);
  assert.equal(item.who, "Sara Meyer", "the caller's name was not lifted from the message");
});

test("a transfer is on the list — somebody should check it landed", () => {
  const call = finished({ outcome: "transferred" });
  assert.ok(attentionFor(clinic).some((i) => i.callId === call.id && i.kind === "transferred"));
});

test("someone who wanted an appointment and left without one is flagged", () => {
  const call = finished({ outcome: "answered_question", summary: "Asked about availability" }, [
    "I'd like to book an appointment for next week.",
    "Let me look at the diary.",
  ]);
  const item = attentionFor(clinic).find((i) => i.callId === call.id);
  assert.ok(item, "business that walked was not flagged");
  assert.equal(item.kind, "booking_failed");
});

console.log("\nWhat must NOT appear\n");

test("a booking that went through is not work", () => {
  const call = finished({ outcome: "booking_created", bookingId: "bk_1" }, [
    "I'd like to book an appointment.",
  ]);
  assert.ok(!attentionFor(clinic).some((i) => i.callId === call.id));
});

test("a question that was simply answered is not work", () => {
  const call = finished({ outcome: "answered_question", summary: "Opening hours" }, [
    "What time do you close on Saturdays?",
  ]);
  assert.ok(
    !attentionFor(clinic).some((i) => i.callId === call.id),
    "an ordinary answered question landed in the inbox",
  );
});

test("a demo-line call is a stranger kicking the tyres, not work", () => {
  const call = finished({ outcome: "message_taken", isDemo: true, escalation: "Someone: hello" });
  assert.ok(!attentionFor(clinic).some((i) => i.callId === call.id));
});

test("a call still in progress is not work yet", () => {
  const call = startCall(clinic, "phone", "+44111");
  assert.ok(!attentionFor(clinic).some((i) => i.callId === call.id));
});

test("an immediate hang-up is noise, not an item", () => {
  const call = finished({ outcome: "abandoned" }, ["Oh, sorry, wrong number."]);
  assert.ok(
    !attentionFor(clinic).some((i) => i.callId === call.id),
    "a two-word wrong number was treated as something to action",
  );
});

console.log("\nClearing the list\n");

test("marking something done removes it", () => {
  const before = attentionFor(clinic);
  assert.ok(before.length > 0);
  resolveAttention(before[0].callId!, "usr_1");
  const after = attentionFor(clinic);
  assert.ok(!after.some((i) => i.callId === before[0].callId), "a cleared item came back");
  assert.equal(after.length, before.length - 1);
});

test("the call itself is not deleted, only cleared", () => {
  const all = attentionFor(clinic, true);
  assert.ok(all.length > attentionFor(clinic).length, "resolved history was thrown away");
});

console.log("\nOrder\n");

test("urgent first, then most recent", () => {
  const items = attentionFor(clinic);
  for (let i = 1; i < items.length; i++) {
    assert.ok(
      items[i - 1].urgency >= items[i].urgency,
      `out of order at ${i}: ${items[i - 1].kind} before ${items[i].kind}`,
    );
  }
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
