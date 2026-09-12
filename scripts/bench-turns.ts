/**
 * Whose turn is it?
 *
 * Deciding that the caller has finished talking is the single decision that
 * most determines whether a voice agent feels like a person. Too eager and it
 * answers half a sentence; too patient and every reply lands a beat late. Both
 * read as "it isn't really listening", and neither shows up in a transcript.
 *
 * So this measures it, on synthesised phone audio, at 8 kHz µ-law, fed in real
 * time in 80 ms frames the way Twilio delivers it — against both recognisers:
 *
 *   nova-3  waits out a fixed 500 ms of silence. It cannot tell a finished
 *           sentence from an unfinished one, so it treats them the same.
 *
 *   flux    decides on the shape of the sentence as well as the silence, so
 *           it can answer a finished question sooner *and* wait longer on
 *           somebody who is obviously still thinking.
 *
 * The last two clips are the interesting ones. A caller who trails off is the
 * case a fixed endpointer gets wrong every single time.
 *
 *   npm run bench:turns
 */

import WebSocket from "ws";

const DG = process.env.DEEPGRAM_API_KEY;
const EL = process.env.ELEVENLABS_API_KEY;

if (!DG || !EL) {
  console.log(
    "\n  Needs DEEPGRAM_API_KEY (to listen) and ELEVENLABS_API_KEY (to make\n" +
      "  something to listen to). Set both and run again.\n",
  );
  process.exit(0);
}

const VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

const CLIPS = [
  { label: "a finished question", text: "Do you have a table for four on Friday at eight?" },
  { label: "a finished answer", text: "That's Andreas, and it's for six people." },
  { label: "a phone number", text: "It's zero seven, seven double oh, nine hundred, one two three." },
  { label: "trailing off", text: "I'd like to book a table for, umm..." },
  { label: "thinking aloud", text: "Can I move it to, hang on, let me check," },
];

async function phoneAudio(text: string): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: { "xi-api-key": EL!, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 80 ms of 8 kHz µ-law, which is what Deepgram asks for. */
const FRAME = 640;
/** How long to hold the line quiet afterwards before giving up on a verdict. */
const PAD_FRAMES = 40;

/**
 * A quiet line, not a dead one.
 *
 * Values just below 0xFF are near-silence in µ-law. Padding with a flat 0xFF
 * is digital silence, which no telephone has ever produced, and it is not what
 * either model was trained on.
 */
function lineNoise(): Buffer {
  const f = Buffer.alloc(FRAME);
  for (let i = 0; i < f.length; i++) f[i] = 0xf8 + Math.floor(Math.random() * 8);
  return f;
}

async function play(ws: WebSocket, audio: Buffer, onSpeechEnd: () => void) {
  for (let i = 0; i < audio.length; i += FRAME) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(audio.subarray(i, i + FRAME));
    await new Promise((r) => setTimeout(r, 78));
  }
  onSpeechEnd();
  for (let i = 0; i < PAD_FRAMES; i++) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(lineNoise());
    await new Promise((r) => setTimeout(r, 78));
  }
}

interface Verdict {
  /** Milliseconds from the last frame of speech to "your turn". */
  ms?: number;
  /** What it believed the caller said. */
  text?: string;
}

async function listen(
  url: string,
  audio: Buffer,
  verdict: (msg: Record<string, unknown>, settle: (text: string) => void) => void,
): Promise<Verdict> {
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${DG}` } });
  let endedAt = 0;
  const out: Verdict = {};
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const settle = (text: string) => {
    if (out.ms !== undefined) return;
    // Before the speech even finished — the model called it early. Report it
    // as a negative rather than as a nonsense number off the epoch.
    out.ms = endedAt ? Date.now() - endedAt : 0;
    out.text = text;
    resolveDone();
  };

  ws.on("message", (raw) => {
    try {
      verdict(JSON.parse(raw.toString()), settle);
    } catch {
      /* not JSON, or a shape we do not care about */
    }
  });
  ws.on("close", () => resolveDone());
  ws.on("error", () => resolveDone());
  ws.on("open", () => void play(ws, audio, () => (endedAt = Date.now())).then(() => ws.close()));

  await done;
  try {
    ws.close();
  } catch {
    /* already closed */
  }
  return out;
}

const NOVA = `wss://api.deepgram.com/v1/listen?${new URLSearchParams({
  model: "nova-3", language: "en", encoding: "mulaw", sample_rate: "8000",
  channels: "1", interim_results: "true", smart_format: "true", punctuate: "true",
  numerals: "true", endpointing: "500", vad_events: "true", utterance_end_ms: "1400",
})}`;

const flux = (eot: string) =>
  `wss://api.deepgram.com/v2/listen?${new URLSearchParams({
    model: "flux-general-en", encoding: "mulaw", sample_rate: "8000",
    eot_threshold: eot, eager_eot_threshold: "0.4", eot_timeout_ms: "1800",
  })}`;

console.log("\n  Caller stops → the recogniser hands over the turn");
console.log("  (8 kHz µ-law, 80 ms frames, real time — as Twilio delivers it)\n");
console.log("  clip                    nova-3 500   flux 0.5   flux 0.7");
console.log("  " + "-".repeat(58));

for (const clip of CLIPS) {
  const audio = await phoneAudio(clip.text);

  let settled = "";
  const nova = await listen(NOVA, audio, (m, settle) => {
    if (m.type === "UtteranceEnd") return settle(settled.trim());
    if (m.type !== "Results") return;
    const alt = (m.channel as { alternatives?: { transcript?: string }[] })?.alternatives?.[0];
    const t = alt?.transcript ?? "";
    if (!t) return;
    if (m.is_final) {
      settled = `${settled} ${t}`.trim();
      if (m.speech_final) settle(settled);
    }
  });

  const onFlux = (m: Record<string, unknown>, settle: (t: string) => void) => {
    if (m.type === "TurnInfo" && m.event === "EndOfTurn") settle(String(m.transcript ?? "").trim());
  };
  const f5 = await listen(flux("0.5"), audio, onFlux);
  const f7 = await listen(flux("0.7"), audio, onFlux);

  const ms = (v: Verdict) => (v.ms === undefined ? "never" : `${v.ms}ms`).padStart(8);
  console.log(`  ${clip.label.padEnd(22)}${ms(nova)}   ${ms(f5)}   ${ms(f7)}`);
  console.log(`      said:  "${clip.text}"`);
  console.log(`      nova:  "${nova.text ?? ""}"`);
  console.log(`      flux:  "${f7.text ?? ""}"`);
}

console.log(
  "\n  'never' on a trailing-off clip is the right answer, not a failure — it\n" +
    "  means the model waited, and the live session's eot_timeout_ms is what\n" +
    "  eventually prompts the caller. nova-3 answering those is the bug.\n",
);
