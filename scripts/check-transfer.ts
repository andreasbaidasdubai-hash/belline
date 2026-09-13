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

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
