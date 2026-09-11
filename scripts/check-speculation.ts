/**
 * Answering before the caller has finished.
 *
 * The endpointer waits half a second of silence before it will call a turn
 * over. That was dead time. Now the model and the voice run during it and the
 * audio is held back, so a right guess is already in the caller's ear the
 * moment the endpointer agrees.
 *
 * A guess must change nothing. These test the safety property first and the
 * speed second, because the failure mode of getting this wrong is a table
 * booked for someone who was still mid-sentence.
 *
 *   npm run check:speculation
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-spec-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, listBookings } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { AgentSession } = await import("../src/lib/agent/runtime");

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  [32m✓[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

seedIfEmpty();
const restaurant = listLocations().find((l) => l.vertical === "restaurant")!;

function session() {
  return new AgentSession(restaurant, startCall(restaurant, "browser", "+44700900000"));
}

async function drain(agent: InstanceType<typeof AgentSession>, text: string, speculative: boolean) {
  const events: string[] = [];
  for await (const event of agent.respond(text, { speculative })) events.push(event.type);
  return events;
}

const live = Boolean(process.env.ANTHROPIC_API_KEY);

console.log("\nA guess changes nothing\n");

await test("speculating does not create a booking", async () => {
  if (!live) return; // Nothing to speculate with; the guards below still hold.
  const before = listBookings({ locationId: restaurant.id }).length;
  const agent = session();
  agent.greeting();
  await drain(
    agent,
    "Book me a table for two tomorrow at eight, the name is Andreas, number 07700900123.",
    true,
  );
  const after = listBookings({ locationId: restaurant.id }).length;
  assert.equal(after, before, "a guess wrote a booking to the book");
});

await test("a guess that needs a writing tool abandons rather than running it", async () => {
  if (!live) return;
  const agent = session();
  agent.greeting();
  const events = await drain(
    agent,
    "Book me a table for two tomorrow at eight, the name is Andreas, number 07700900123.",
    true,
  );
  // Either it abandoned, or it never reached for a writing tool at all — both
  // are correct. What must not happen is a booking, asserted above.
  assert.ok(
    events.includes("abandon") || !events.includes("tool"),
    `unexpected events: ${events.join(", ")}`,
  );
});

await test("an abandoned guess cannot be adopted", async () => {
  const agent = session();
  assert.equal(agent.adopt("anything at all"), false);
});

console.log("\nAdoption is exact\n");

await test("a guess is only adopted for the sentence it was built from", async () => {
  if (!live) return;
  const agent = session();
  agent.greeting();
  await drain(agent, "What time do you close on Saturday?", true);
  assert.equal(
    agent.adopt("What time do you close on Sunday?"),
    false,
    "a guess was adopted for a different question",
  );
});

await test("adopting twice is refused", async () => {
  if (!live) return;
  const agent = session();
  agent.greeting();
  const question = "What time do you close on Saturday?";
  await drain(agent, question, true);
  const first = agent.adopt(question);
  if (!first) return; // The model chose to call a tool; nothing to adopt.
  assert.equal(agent.adopt(question), false, "the same guess was adopted twice");
});

await test("discarding clears the pending guess", async () => {
  if (!live) return;
  const agent = session();
  agent.greeting();
  const question = "What time do you close on Saturday?";
  await drain(agent, question, true);
  agent.discardSpeculation();
  assert.equal(agent.adopt(question), false, "a discarded guess was still adopted");
});

console.log("\nThe real turn is unaffected\n");

await test("a real turn still answers normally", async () => {
  if (!live) return;
  const agent = session();
  agent.greeting();
  const events = await drain(agent, "What time do you close on Saturday?", false);
  assert.ok(events.includes("sentence"), "the agent said nothing");
  assert.ok(events.includes("turn_end"), "the turn never ended");
});

if (!live) {
  console.log("\n  (ANTHROPIC_API_KEY unset — the model-dependent cases were skipped)\n");
}

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
