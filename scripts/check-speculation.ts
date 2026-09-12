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
 * booked for someone who was still mid-sentence. A guess that reaches a tool
 * that writes stops there, and the real turn continues from that point — so
 * the booking is made once, by the turn allowed to make it, and the sentence
 * the model said on the way to it is not said twice.
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

await test("a guess that needs a writing tool stops rather than running it", async () => {
  if (!live) return;
  const agent = session();
  agent.greeting();
  const events = await drain(
    agent,
    "Book me a table for two tomorrow at eight, the name is Andreas, number 07700900123.",
    true,
  );
  // Either it stopped at the writing tool, or it never reached for one at all
  // — both are correct. What must not happen is a booking, asserted above.
  assert.ok(
    events.includes("abandon") || !events.includes("tool"),
    `unexpected events: ${events.join(", ")}`,
  );
});

await test("nothing to adopt on a fresh session", async () => {
  const agent = session();
  assert.equal(agent.adopt("anything at all"), false);
});

console.log("\nA guess that stopped at a booking is continued, not repeated\n");

await test("the real turn runs the booking the guess asked for, exactly once", async () => {
  if (!live) return;
  const agent = session();
  agent.greeting();
  const ask = "Book me a table for two tomorrow at eight, the name is Andreas, number 07700900123.";
  const before = listBookings({ locationId: restaurant.id }).length;

  // The guess: says its opening, reaches for `book`, stops.
  const guessed: string[] = [];
  let stopped = false;
  for await (const event of agent.respond(ask, { speculative: true })) {
    if (event.type === "sentence") guessed.push(event.text);
    if (event.type === "abandon") stopped = true;
  }
  if (!stopped) return; // The model asked a question instead of booking; nothing to continue.
  assert.equal(listBookings({ locationId: restaurant.id }).length, before, "the guess booked");

  // Adopted, and flagged as unfinished.
  assert.equal(agent.adopt(ask), true, "a stopped guess could not be adopted");
  assert.equal(agent.needsContinuation, true);

  // The real turn picks up at the tool call, not at the caller's words.
  const events: string[] = [];
  let turnText = "";
  let toolsRun = 0;
  for await (const event of agent.respond(ask)) {
    events.push(event.type);
    if (event.type === "tool" && event.trace.name === "book") toolsRun++;
    if (event.type === "turn_end") turnText = event.text;
  }
  assert.equal(agent.needsContinuation, false);
  assert.equal(toolsRun, 1, `book ran ${toolsRun} times`);
  assert.equal(
    listBookings({ locationId: restaurant.id }).length,
    before + 1,
    "the continued turn did not make exactly one booking",
  );
  // The opening the guess spoke is part of the turn's record, and said once.
  // Only sentences long enough to be distinctive are checked for repeats: a
  // "Lovely." can legitimately recur inside "Lovely, you're all booked".
  const opening = guessed.join(" ");
  assert.ok(turnText.startsWith(opening), `the turn lost its opening "${opening.slice(0, 60)}"`);
  for (const sentence of guessed.filter((s) => s.length >= 15)) {
    assert.equal(turnText.split(sentence).length, 2, `"${sentence}" was said twice`);
  }
  // And the history is whole: every tool call answered, so the next turn can
  // be built on it.
  const history = agent.history();
  const asked = new Set<string>();
  const answered = new Set<string>();
  for (const m of history) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as { type: string; id?: string; tool_use_id?: string }[]) {
      if (b.type === "tool_use" && b.id) asked.add(b.id);
      if (b.type === "tool_result" && b.tool_use_id) answered.add(b.tool_use_id);
    }
  }
  assert.deepEqual([...asked].filter((id) => !answered.has(id)), [], "a tool call went unanswered");
});

await test("an unfinished guess is written down as what was heard", () => {
  const agent = session();
  agent.greeting();
  agent.recordUnfinished("What time do you close?", "We close at");
  const history = agent.history();
  assert.equal(history.length, 2);
  assert.equal(history[0].role, "user");
  assert.equal(history[1].role, "assistant");
  assert.equal(history[1].content, "We close at");
  assert.equal(agent.adopt("What time do you close?"), false);
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
