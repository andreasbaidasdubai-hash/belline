/**
 * Talking over Belline.
 *
 * Barge-in is not an error path, it is the normal way people use a telephone,
 * and it has to leave the conversation in a state the next turn can be built
 * on. Two things used to go wrong the moment a caller cut in, and neither of
 * them announced itself at the time:
 *
 *   The agent forgot it had spoken, because the assistant message was only
 *   written down once the model's stream finished — which an interrupted turn
 *   never reaches. It would then offer the same three times again.
 *
 *   A tool round was left hanging. Cut in between asking for availability and
 *   writing down what came back, and the history ends on a `tool_use` with no
 *   `tool_result`. The API rejects that outright, so *every remaining turn of
 *   the call* failed — the caller heard the line drop half a minute after the
 *   interruption that actually caused it.
 *
 * The last test is the one that matters: it does not inspect the history, it
 * hands it back to the API and insists the call can carry on.
 *
 *   npm run check:interruption
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-barge-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { AgentSession } = await import("../src/lib/agent/runtime");
const { isBackchannel, invitesAnswer } = await import("../src/lib/voice/backchannel");

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
const restaurant = listLocations().find((l) => l.vertical === "restaurant")!;
const live = Boolean(process.env.ANTHROPIC_API_KEY);

function session() {
  const agent = new AgentSession(restaurant, startCall(restaurant, "browser", "+44700900000"));
  agent.greeting();
  return agent;
}

type Agent = InstanceType<typeof AgentSession>;

/**
 * Answer, then stop asking for more the moment `at` happens.
 *
 * Breaking out of the loop is precisely what the live session does when the
 * caller talks over the agent — the generator is abandoned where it stands.
 */
async function interruptAt(agent: Agent, text: string, at: string): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of agent.respond(text)) {
    seen.push(event.type);
    if (event.type === at) break;
  }
  return seen;
}

async function drain(agent: Agent, text: string): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of agent.respond(text)) seen.push(event.type);
  return seen;
}

/** Tool calls the model asked for that were never answered. */
function orphanedToolUses(history: { role: string; content: unknown }[]): string[] {
  const asked = new Set<string>();
  const answered = new Set<string>();
  for (const message of history) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type: string; id?: string; tool_use_id?: string }[]) {
      if (block.type === "tool_use" && block.id) asked.add(block.id);
      if (block.type === "tool_result" && block.tool_use_id) answered.add(block.tool_use_id);
    }
  }
  return [...asked].filter((id) => !answered.has(id));
}

// ---------------------------------------------------------------------------

console.log("\nListening noises are not interruptions\n");

await test("the things people say while they listen", () => {
  for (const phrase of ["mm-hmm", "Mhm", "yeah", "okay.", "right", "of course", "got it", "uh-huh"]) {
    assert.ok(isBackchannel(phrase), `"${phrase}" should read as a backchannel`);
  }
});

await test("a sentence that merely starts like one is not one", () => {
  for (const phrase of [
    "yeah but can you make it seven instead",
    "okay so what about Friday",
    "right, cancel it then",
    "sure, and do you do parking",
  ]) {
    assert.ok(!isBackchannel(phrase), `"${phrase}" was ignored as a backchannel`);
  }
});

await test("word soup does not slip through", () => {
  // Every word here is on the list of things a listener says. The phrase is
  // not, which is the whole reason the match is on the phrase.
  assert.ok(!isBackchannel("I see you Thursday"));
  assert.ok(!isBackchannel("yes I see, and thanks for the table"));
  assert.ok(!isBackchannel(""));
  assert.ok(!isBackchannel("   "));
});

await test("after a question, a short answer is an answer", () => {
  assert.ok(invitesAnswer("Shall I put that down for you?"));
  assert.ok(!invitesAnswer("That's Thursday at half past seven."));
});

console.log("\nAn interrupted turn leaves a conversation that still works\n");

await test("what was said is written down", async () => {
  if (!live) return;
  const agent = session();
  await interruptAt(agent, "What time do you close on Saturday?", "sentence");

  const history = agent.history();
  const last = history[history.length - 1];
  assert.equal(last?.role, "assistant", "the interrupted turn left no trace at all");
  assert.equal(typeof last.content, "string", "expected the spoken words, verbatim");
  assert.ok(
    String(last.content).trim().length > 0,
    "an empty assistant turn is no better than a missing one",
  );
});

await test("an interrupted tool round answers every tool it asked for", async () => {
  if (!live) return;
  const agent = session();
  // Availability is the read-only tool the model reaches for constantly, so
  // this is the interruption a real caller is most likely to land on.
  const seen = await interruptAt(agent, "Do you have a table for four on Friday at eight?", "tool");
  if (!seen.includes("tool")) return; // The model answered without a tool; nothing to orphan.

  const orphans = orphanedToolUses(agent.history() as { role: string; content: unknown }[]);
  assert.deepEqual(orphans, [], "a tool call was left without a result — the next turn cannot run");
});

await test("the call carries on after being cut off mid-tool", async () => {
  if (!live) return;
  const agent = session();
  await interruptAt(agent, "Do you have a table for four on Friday at eight?", "tool");

  // The real proof. Not "does the history look right" but "does the API take
  // it" — this is the turn that used to fail for the rest of the call.
  const events = await drain(agent, "Sorry, make that six of us.");
  assert.ok(!events.includes("error"), "the turn after an interruption failed");
  assert.ok(events.includes("sentence"), "the agent said nothing on the next turn");
});

await test("a turn that finishes normally is unchanged", async () => {
  if (!live) return;
  const agent = session();
  await drain(agent, "What time do you close on Saturday?");

  const history = agent.history();
  const last = history[history.length - 1];
  assert.equal(last?.role, "assistant");
  // A completed turn keeps the model's own content blocks — thinking included,
  // which the API insists on seeing replayed unchanged.
  assert.ok(Array.isArray(last.content), "a completed turn was flattened to a string");
});

if (!live) {
  console.log("\n  (ANTHROPIC_API_KEY unset — the model-dependent cases were skipped)\n");
}

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
