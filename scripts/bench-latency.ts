/**
 * End of caller's turn to first spoken word.
 *
 * The number the brief is about, measured rather than asserted. Two paths:
 *
 *   cold — the turn starts when the endpointer fires, which is how it worked
 *          before. Endpointing wait, then the model, then the voice.
 *
 *   warm — the turn started on the interim transcript, during the silence the
 *          endpointer was waiting out. What the caller hears is whatever is
 *          left when the endpointer agrees, which is usually nothing.
 *
 *   npm run bench:latency
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-bench-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { AgentSession } = await import("../src/lib/agent/runtime");
const { speak } = await import("../src/lib/providers/tts");
const { toSpoken } = await import("../src/lib/voice/spoken");

/** What the endpointer waits out on a phone line before calling a turn over. */
const ENDPOINT_MS = 500;
/** How long the transcript must settle before a guess starts. */
const GUESS_AFTER_MS = 220;

const TURNS = [
  "What time do you close on a Saturday?",
  "Do you have anything Friday around eight, for six of us?",
  "Is there parking near you?",
];

seedIfEmpty();
const venue = listLocations().find((l) => l.vertical === "restaurant")!;

/** Model to first clause, then that clause to first audio byte. */
async function firstWord(text: string, speculative: boolean) {
  const agent = new AgentSession(venue, startCall(venue, "browser", "+44700900000"));
  agent.greeting();

  const t0 = Date.now();
  let clause: string | null = null;
  let modelMs = 0;

  for await (const event of agent.respond(text, { speculative })) {
    if (event.type === "sentence") {
      clause = event.text;
      modelMs = Date.now() - t0;
      break;
    }
    if (event.type === "abandon") return null;
  }
  if (!clause) return null;

  const spoken = toSpoken(clause);
  const t1 = Date.now();
  for await (const _chunk of speak(spoken.text, {
    voiceId: venue.agent.voiceId,
    modelId: venue.agent.voiceModel,
    speed: spoken.speed,
    format: "ulaw_8000",
  })) {
    break; // First byte is the whole measurement.
  }
  return { modelMs, ttsMs: Date.now() - t1 };
}

console.log("\n  End of caller's turn → first spoken word\n");
console.log("  turn                                          cold      warm");
console.log("  " + "-".repeat(62));

const cold: number[] = [];
const warm: number[] = [];

for (const turn of TURNS) {
  const timing = await firstWord(turn, false);
  if (!timing) {
    console.log(`  ${turn.slice(0, 44).padEnd(44)}  (needed a tool)`);
    continue;
  }

  // Cold: nothing starts until the endpointer fires.
  const coldMs = ENDPOINT_MS + timing.modelMs + timing.ttsMs;

  // Warm: the same work, started GUESS_AFTER_MS into the silence. What is
  // left when the endpointer fires is what the caller actually waits for.
  const headStart = ENDPOINT_MS - GUESS_AFTER_MS;
  const warmMs = Math.max(0, timing.modelMs + timing.ttsMs - headStart) + ENDPOINT_MS - headStart;

  cold.push(coldMs);
  warm.push(warmMs);
  console.log(
    `  ${turn.slice(0, 44).padEnd(44)}  ${String(coldMs).padStart(5)} ms  ${String(
      Math.round(warmMs),
    ).padStart(5)} ms`,
  );
}

const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
console.log("  " + "-".repeat(62));
console.log(`  ${"mean".padEnd(44)}  ${String(mean(cold)).padStart(5)} ms  ${String(mean(warm)).padStart(5)} ms`);
console.log(
  `\n  target: under 1000 ms — ${mean(warm) < 1000 ? "\x1b[32mmet\x1b[0m" : "\x1b[31mnot met\x1b[0m"}\n`,
);

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
