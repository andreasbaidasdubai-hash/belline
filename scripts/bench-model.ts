/**
 * Which model should answer the phone?
 *
 * Every venue is seeded on Haiku 4.5, chosen for speed. That is a defensible
 * choice and an untested one: the model writes the dialogue, and the dialogue
 * is most of what a caller means by "it sounded like a person". So this runs
 * the same booking conversation through each candidate and reports both halves
 * of the trade at once —
 *
 *   how long the caller waits for the first *speakable clause*, which is when
 *   audio can start, not when the answer is finished; and
 *
 *   what it actually said, printed in full, because no benchmark is going to
 *   tell you which of two receptionists you would rather be answered by.
 *
 * Read the transcripts first and the milliseconds second. A hundred
 * milliseconds is below the threshold where anybody notices; "Certainly, a
 * table for four has been confirmed" against "Lovely — four of you at half
 * seven, then" is not.
 *
 *   npm run bench:model
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-model-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { AgentSession } = await import("../src/lib/agent/runtime");

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("\n  Needs ANTHROPIC_API_KEY. Set it and run again.\n");
  process.exit(0);
}

seedIfEmpty();
const venue = listLocations().find((l) => l.vertical === "restaurant")!;

/** A whole booking, the way one actually goes. */
const CONVERSATION = [
  "Hi there, do you have a table for four on Friday, around eight?",
  "Half past seven is fine.",
  "It's Andreas, and the number is oh seven seven double oh, nine hundred, one two three.",
];

interface Candidate {
  label: string;
  model: string;
  fast: boolean;
}

const CANDIDATES: Candidate[] = [
  { label: "Haiku 4.5 (as seeded)", model: "claude-haiku-4-5", fast: false },
  { label: "Opus 5, effort low", model: "claude-opus-5", fast: false },
  { label: "Opus 5, effort low + fast mode", model: "claude-opus-5", fast: true },
];

interface TurnResult {
  firstClauseMs: number;
  totalMs: number;
  said: string;
  tools: string[];
  failed?: string;
}

async function converse(c: Candidate): Promise<TurnResult[]> {
  // `fastMode` reads the environment per request, so this is all it takes to
  // put the same code down a different path.
  if (c.fast) process.env.ANTHROPIC_FAST_MODE = "1";
  else delete process.env.ANTHROPIC_FAST_MODE;

  const agent = new AgentSession(
    { ...venue, agent: { ...venue.agent, model: c.model } },
    startCall(venue, "browser", "+44700900123"),
  );
  agent.greeting();

  const results: TurnResult[] = [];
  for (const line of CONVERSATION) {
    const t0 = Date.now();
    let firstClauseMs = -1;
    const said: string[] = [];
    const tools: string[] = [];
    let failed: string | undefined;

    try {
      for await (const event of agent.respond(line)) {
        if (event.type === "sentence") {
          if (firstClauseMs < 0) firstClauseMs = Date.now() - t0;
          said.push(event.text);
        }
        if (event.type === "tool") tools.push(event.trace.name);
        if (event.type === "error") failed = event.message;
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }

    results.push({
      firstClauseMs: firstClauseMs < 0 ? 0 : firstClauseMs,
      totalMs: Date.now() - t0,
      said: said.join(" "),
      tools,
      failed,
    });
  }
  return results;
}

const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
const all: { c: Candidate; turns: TurnResult[] }[] = [];

for (const c of CANDIDATES) {
  process.stdout.write(`  running ${c.label}...`);
  try {
    const turns = await converse(c);
    all.push({ c, turns });
    process.stdout.write(" done\n");
  } catch (err) {
    process.stdout.write(` failed — ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

console.log("\n\n  Caller stops talking → first clause ready to speak");
console.log("  (the model's share of the wait; the voice adds its own on top)\n");
console.log("  candidate                          turn 1   turn 2   turn 3    mean");
console.log("  " + "-".repeat(68));
for (const { c, turns } of all) {
  const cells = turns.map((t) => `${t.firstClauseMs}ms`.padStart(7)).join("  ");
  console.log(`  ${c.label.padEnd(32)} ${cells}  ${`${mean(turns.map((t) => t.firstClauseMs))}ms`.padStart(6)}`);
}

console.log("\n\n  What each one actually said\n");
for (const { c, turns } of all) {
  console.log(`  ${"─".repeat(66)}`);
  console.log(`  ${c.label}\n`);
  turns.forEach((t, i) => {
    console.log(`    caller:  ${CONVERSATION[i]}`);
    console.log(`    Belline: ${t.failed ? `[failed: ${t.failed}]` : t.said || "[said nothing]"}`);
    if (t.tools.length) console.log(`             (tools: ${t.tools.join(", ")})`);
    console.log();
  });
}

console.log(
  "  Latency here is the model only. A hundred milliseconds between two\n" +
    "  candidates is not the deciding factor — how they read out loud is.\n",
);

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
