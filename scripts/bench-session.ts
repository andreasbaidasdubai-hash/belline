// End of the caller's words → first audio byte leaving the session, through
// the real VoiceSession with a fake transport. Cold (no guess) against warm
// (a guess started HEAD_START ms before the endpointer fires, as in the
// browser). Live keys, temp data dir, read-only on the diary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-guess-"));
// No recogniser: the words are handed to the session directly.
delete process.env.DEEPGRAM_API_KEY;

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation } = await import("../src/lib/store");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");
const { startCall } = await import("../src/lib/calls");
const { VoiceSession } = await import("../src/lib/voice/session");
const { NOVA_ENDPOINTING_MS } = await import("../src/lib/providers/stt");
const { GUESS_AFTER_MS } = await import("../src/lib/voice/session");

seedIfEmpty();
const venue = getLocation(BELLINE_LOCATION_ID)!;
const HEAD_START = NOVA_ENDPOINTING_MS.browser - GUESS_AFTER_MS;

function fakeTransport() {
  const t = {
    input: { encoding: "linear16" as const, sampleRate: 16000 },
    output: "pcm_16000" as const,
    screen: true,
    firstAudioAt: 0,
    answerAt: 0,
    ack: "",
    inAnswer: false,
    bytes: 0,
    turnEnded: null as null | (() => void),
    sendAudio(chunk: Buffer) {
      if (!t.firstAudioAt) t.firstAudioAt = Date.now();
      if (t.inAnswer && !t.answerAt) t.answerAt = Date.now();
      t.bytes += chunk.length;
    },
    sendEvent(event: Record<string, unknown>) {
      if (event.type === "transcript" && event.role === "agent") {
        const text = String(event.text);
        if ((ACKNOWLEDGEMENTS as readonly string[]).includes(text) && !t.inAnswer) t.ack = text;
        else t.inAnswer = true;
      }
      if (event.type === "turn_end" && t.turnEnded) t.turnEnded();
    },
    clearAudio() {},
    close() {},
  };
  return t;
}

async function run(question: string, warm: boolean) {
  const t = fakeTransport();
  const session = new VoiceSession(venue, startCall(venue, "browser", "browser-console"), t);
  // Skip start(): the greeting is a cached clip and not what is being measured.
  const s = session as unknown as { startGuess(text: string): void; generation: number };
  s.generation = 1;

  if (warm) {
    s.startGuess(question);
    await new Promise((r) => setTimeout(r, HEAD_START));
  }
  const t0 = Date.now();
  const ended = new Promise<void>((r) => (t.turnEnded = r));
  await session.onText(question);
  await ended;
  await session.end("answered_question");
  return {
    first: t.firstAudioAt - t0,
    answer: (t.answerAt || t.firstAudioAt) - t0,
    ack: t.ack,
    total: Date.now() - t0,
  };
}

const { ACKNOWLEDGEMENTS } = await import("../src/lib/voice/session");

console.log(`\n  Caller's last word → first sound / first word of the answer (browser, ${venue.name}, head start ${HEAD_START} ms)\n`);
console.log("  question                                     cold                     warm");
for (const q of [
  "What time do you close on a Saturday?",
  "How much does it cost per month?",
  "Do you work with dental clinics?",
]) {
  const c = await run(q, false);
  const w = await run(q, true);
  const fmt = (r: Awaited<ReturnType<typeof run>>) =>
    `${String(r.first).padStart(4)} ms ${r.ack ? `"${r.ack}"`.padEnd(13) : "".padEnd(13)} answer ${String(r.answer).padStart(4)} ms`;
  console.log(`  ${q.padEnd(44)} ${fmt(c)}   ${fmt(w)}`);
}
console.log("\n  (plus the endpointer's " + NOVA_ENDPOINTING_MS.browser + " ms of silence on both, and the network to the browser)\n");

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
