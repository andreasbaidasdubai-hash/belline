/**
 * Putting a caller through — only where somebody can actually be put through.
 *
 *   npm run check:transfer
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-transfer-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { executeTool } = await import("../src/lib/agent/tools");
const { authorityRules } = await import("../src/lib/agent/authority");
const { TwilioTransport } = await import("../src/lib/voice/transports");

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

seedIfEmpty();
const withNumber = listLocations().find((l) => l.agent.transferNumber)!;
const salon = listLocations().find((l) => l.vertical === "salon")!;
const clinic = listLocations().find((l) => l.vertical === "clinic")!;

console.log("\n\x1b[1mThe tool\x1b[0m\n");

await test("on a real phone call with a number, it transfers", async () => {
  const call = startCall(withNumber, "phone", "+971501234567");
  const out = await executeTool("transfer_call", { reason: "urgent" }, { location: withNumber, call, liveTransfer: true });
  assert.equal(out.control?.type, "transfer");
  assert.match(JSON.stringify(out.result), /putting them through/);
});

await test("where the line cannot dial, it takes a message instead of hanging up", async () => {
  const call = startCall(withNumber, "browser", "browser-console");
  const out = await executeTool("transfer_call", { reason: "urgent" }, { location: withNumber, call, liveTransfer: false });
  assert.equal(out.control, undefined);
  assert.match(JSON.stringify(out.result), /take_message/);
});

await test("with no transfer number, it never transfers", async () => {
  const v = { ...withNumber, agent: { ...withNumber.agent, transferNumber: "" } };
  const call = startCall(v, "phone", "+971501234567");
  const out = await executeTool("transfer_call", { reason: "urgent" }, { location: v, call, liveTransfer: true });
  assert.equal(out.control, undefined);
});

console.log("\n\x1b[1mThe rules\x1b[0m\n");

await test("a transfer rule has words for a line that cannot put anybody through", () => {
  for (const rule of [...authorityRules(salon), ...authorityRules(clinic)].filter((r) => r.then === "transfer")) {
    assert.ok(rule.sayIfNoTransfer, `${rule.id} has no fallback wording`);
    assert.doesNotMatch(rule.sayIfNoTransfer!, /put(ting)? you through/i);
  }
});

await test("a clinical question becomes a callback from the clinical team, not a transfer to the desk", () => {
  const rule = authorityRules(clinic).find((r) => r.id === "clinical-advice")!;
  assert.equal(rule.then, "message");
});

console.log("\n\x1b[1mThe telephone\x1b[0m\n");

await test("a Twilio stream with no call id cannot transfer", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = new TwilioTransport({} as any, "MZ1");
  assert.equal(t.canTransfer, false);
});

console.log("\n\x1b[1mOnly numbers in the venue's own country\x1b[0m\n");

const { checkTransferNumber, venueMarket, applyRules } = await import("../src/lib/onboarding/rules");
const { recordStep, NO_FACTS } = await import("../src/lib/onboarding/journey");
const dubai = listLocations().find((l) => l.vertical === "restaurant")!;
const zurich = listLocations().find((l) => l.timezone === "Europe/Zurich")!;
const inSetup = {
  ...dubai,
  onboarding: { version: 1 as const, channels: {}, destination: { kind: "requests" as const, setAt: "2026-09-15T10:00:00.000Z" } },
};

await test("a venue's country is its plan's market, else its currency and clock", () => {
  assert.equal(venueMarket(dubai), "AE");
  assert.equal(venueMarket(zurich), "CH");
  assert.equal(venueMarket({ ...zurich, subscription: { ...(zurich.subscription ?? {}), market: "GB" } as never }), "GB");
});

await test("UAE numbers are accepted in every usual form, as E.164", () => {
  assert.deepEqual(checkTransferNumber("+971 4 555 0100", "AE"), { ok: true, e164: "+97145550100" });
  assert.deepEqual(checkTransferNumber("04 555 0100", "AE"), { ok: true, e164: "+97145550100" });
  assert.deepEqual(checkTransferNumber("00971 50 123 4567", "AE"), { ok: true, e164: "+971501234567" });
  assert.deepEqual(checkTransferNumber("+41 44 555 21 81", "CH"), { ok: true, e164: "+41445552181" });
});

await test("a number outside the venue's country is refused, with the reason", () => {
  const out = checkTransferNumber("+44 20 7946 0958", "AE");
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /outside United Arab Emirates.*international/);
  assert.equal(checkTransferNumber("0044 20 7946 0958", "AE").ok, false);
});

await test("premium-rate numbers, letters and the wrong length are refused", () => {
  for (const raw of ["+971 900 123 456", "call me", "+971 12", "", "+971 4 555 0100 999 999"]) {
    assert.equal(checkTransferNumber(raw, "AE").ok, false, raw);
  }
});

await test("the rules step refuses +44 for a UAE venue and saves nothing", () => {
  const out = recordStep(inSetup, { kind: "rules", rules: { transferNumber: "+44 20 7946 0958" } }, NO_FACTS);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 422);
  assert.equal(out.field, "transferNumber");
  assert.match(out.error, /outside United Arab Emirates/);
});

await test("a UAE number is saved where transfer_call reads it, and the step is confirmed", () => {
  const out = recordStep(inSetup, { kind: "rules", rules: { transferNumber: "+971 4 555 0391", notify: "Owner@Example.com" } }, NO_FACTS);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.location.agent.transferNumber, "+97145550391");
  assert.equal(out.location.onboarding!.escalation!.transferNumber, "+97145550391");
  assert.equal(out.location.onboarding!.escalation!.notifyEmail, "owner@example.com");
  assert.ok(out.location.onboarding!.rulesConfirmedAt);
});

await test("a WhatsApp alert number follows the same country rule; bad emails and long lists are refused", () => {
  assert.equal(applyRules(inSetup, { notify: "+44 7700 900123" }).ok, false);
  // With its country code (since 2026-09-16 a number is never saved without one; the field converts a local entry).
  assert.equal(applyRules(inSetup, { notify: "050 123 4567" }).ok, false);
  const wa = applyRules(inSetup, { notify: "+971 50 123 4567" });
  assert.ok(wa.ok && wa.location.onboarding!.escalation!.notifyWhatsApp === "+971501234567");
  assert.equal(applyRules(inSetup, { notify: "owner@" }).ok, false);
  assert.equal(applyRules(inSetup, { neverSay: Array.from({ length: 11 }, (_, i) => `rule ${i}`).join("\n") }).ok, false);
});

await test("a foreign number saved before the rule existed is still never dialled", async () => {
  const v = { ...withNumber, agent: { ...withNumber.agent, transferNumber: "+44 20 7946 0958" } };
  const call = startCall(v, "phone", "+971501234567");
  const out = await executeTool("transfer_call", { reason: "urgent" }, { location: v, call, liveTransfer: true });
  assert.equal(out.control, undefined);
});

await test("a Swiss venue still puts calls through to its Swiss number", async () => {
  const call = startCall(zurich, "phone", "+41791234567");
  const out = await executeTool("transfer_call", { reason: "urgent" }, { location: zurich, call, liveTransfer: true });
  assert.equal(out.control?.type, "transfer");
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
