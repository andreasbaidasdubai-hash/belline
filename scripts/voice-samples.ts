/**
 * The same answer, three ways, so somebody can listen and decide.
 *
 * There is a trade here that no benchmark settles, because half of it is a
 * judgement about how a voice sounds:
 *
 *   Today  `eleven_v3_conversational`, one HTTPS request per clause. The
 *          warmest delivery of the three — and the only one of the three that
 *          the websocket endpoints refuse outright (403), so it cannot have
 *          the other two's advantage. It also rejects `previous_text`, which
 *          means every clause starts its intonation from scratch: three
 *          sentences in a row opening on the same pitch is a large part of
 *          what people hear as a machine reading to them.
 *
 *   Turbo  `eleven_turbo_v2_5` over one websocket context. Flatter per clause,
 *          but the clauses are generated as one continuous piece of speech, so
 *          the seams between them disappear.
 *
 *   Flash  `eleven_flash_v2_5` over one websocket context. Flattest, fastest.
 *
 * Each file is the *whole* three-clause turn, assembled exactly the way the
 * transport assembles it on a real call, at 8 kHz µ-law — so what you hear is
 * what a caller hears, seams and all. Listen for the joins, not the timbre.
 *
 *   npm run voice:samples
 */

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.log("\n  Needs ELEVENLABS_API_KEY. Set it and run again.\n");
  process.exit(0);
}

const VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const FORMAT = "ulaw_8000";
const OUT = path.join(process.cwd(), "voice-samples");

/**
 * A real answer, cut where `SentenceChunker` cuts it.
 *
 * Deliberately one that carries a detail in the middle: the join either side
 * of the times is where a restarted intonation is most audible, and it is also
 * the moment the caller is concentrating hardest.
 */
const TURN = [
  "Of course, let me have a look.",
  "I've got quarter past seven, or half past eight.",
  "Which would suit you better?",
];

const SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.8,
  style: 0.15,
  use_speaker_boost: true,
  speed: 1.05,
};

/**
 * A µ-law WAV header, so the file plays anywhere.
 *
 * The audio itself is untouched — this only describes it. Re-encoding to PCM
 * or MP3 to make it convenient would quietly remove the thing being judged,
 * which is how it sounds after 8 kHz µ-law has had its way with it.
 */
function muLawWav(audio: Buffer): Buffer {
  const header = Buffer.alloc(58);
  let o = 0;
  header.write("RIFF", o); o += 4;
  header.writeUInt32LE(50 + audio.length, o); o += 4;
  header.write("WAVE", o); o += 4;
  header.write("fmt ", o); o += 4;
  header.writeUInt32LE(18, o); o += 4; // fmt chunk size for a non-PCM format
  header.writeUInt16LE(7, o); o += 2;  // WAVE_FORMAT_MULAW
  header.writeUInt16LE(1, o); o += 2;  // mono
  header.writeUInt32LE(8000, o); o += 4;
  header.writeUInt32LE(8000, o); o += 4; // bytes per second
  header.writeUInt16LE(1, o); o += 2;  // block align
  header.writeUInt16LE(8, o); o += 2;  // bits per sample
  header.writeUInt16LE(0, o); o += 2;  // cbSize
  header.write("fact", o); o += 4;
  header.writeUInt32LE(4, o); o += 4;
  header.writeUInt32LE(audio.length, o); o += 4;
  header.write("data", o); o += 4;
  header.writeUInt32LE(audio.length, o); o += 4;
  return Buffer.concat([header.subarray(0, o), audio]);
}

/** One HTTPS request per clause, concatenated — today's pipeline exactly. */
async function viaHttp(model: string): Promise<{ audio: Buffer; ttfa: number[] }> {
  const parts: Buffer[] = [];
  const ttfa: number[] = [];
  for (const clause of TURN) {
    const t0 = Date.now();
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=${FORMAT}`,
      {
        method: "POST",
        headers: { "xi-api-key": KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ text: clause, model_id: model, voice_settings: SETTINGS }),
      },
    );
    if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 140)}`);
    const chunks: Buffer[] = [];
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!chunks.length) ttfa.push(Date.now() - t0);
      chunks.push(Buffer.from(chunk));
    }
    parts.push(Buffer.concat(chunks));
  }
  return { audio: Buffer.concat(parts), ttfa };
}

/** One socket, one context, three sends — the clauses join as one utterance. */
async function viaWebsocket(model: string): Promise<{ audio: Buffer; ttfa: number[] }> {
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE}/multi-stream-input` +
    `?model_id=${model}&output_format=${FORMAT}`;
  const ws = new WebSocket(url, { headers: { "xi-api-key": KEY! } });

  const parts: Buffer[] = [];
  const ttfa: number[] = [];
  let askedAt = 0;
  let sawAudioForClause = false;

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_q, res) => reject(new Error(`${model}: HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as { audio?: string | null };
    if (!msg.audio) return;
    if (!sawAudioForClause) {
      ttfa.push(Date.now() - askedAt);
      sawAudioForClause = true;
    }
    parts.push(Buffer.from(msg.audio, "base64"));
  });

  for (let i = 0; i < TURN.length; i++) {
    askedAt = Date.now();
    sawAudioForClause = false;
    ws.send(
      JSON.stringify({
        text: `${TURN[i]} `,
        context_id: "turn",
        ...(i === 0 ? { voice_settings: SETTINGS } : {}),
      }),
    );
    ws.send(JSON.stringify({ context_id: "turn", flush: true }));
    // Wait for this clause to be spoken before asking for the next, which is
    // what the live session does — it hands over one clause at a time as the
    // model produces them.
    await new Promise((r) => setTimeout(r, 1400));
  }

  ws.send(JSON.stringify({ context_id: "turn", close_context: true }));
  await new Promise((r) => setTimeout(r, 900));
  ws.send(JSON.stringify({ close_socket: true }));
  ws.close();

  return { audio: Buffer.concat(parts), ttfa };
}

// ---------------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });

const CASES: { file: string; label: string; run: () => Promise<{ audio: Buffer; ttfa: number[] }> }[] = [
  {
    file: "1-today-v3-conversational-http.wav",
    label: "today — v3 conversational, one request per clause",
    run: () => viaHttp("eleven_v3_conversational"),
  },
  {
    file: "2-turbo-websocket-one-context.wav",
    label: "turbo v2.5 — one websocket context, clauses joined",
    run: () => viaWebsocket("eleven_turbo_v2_5"),
  },
  {
    file: "3-flash-websocket-one-context.wav",
    label: "flash v2.5 — one websocket context, clauses joined",
    run: () => viaWebsocket("eleven_flash_v2_5"),
  },
];

console.log(`\n  "${TURN.join(" ")}"\n`);

for (const c of CASES) {
  try {
    const { audio, ttfa } = await c.run();
    fs.writeFileSync(path.join(OUT, c.file), muLawWav(audio));
    const secs = (audio.length / 8000).toFixed(2);
    console.log(
      `  ${c.file.padEnd(40)} ${secs}s   first audio per clause: ${ttfa.map((t) => `${t}ms`).join(", ")}`,
    );
    console.log(`      ${c.label}`);
  } catch (err) {
    console.log(`  ${c.file.padEnd(40)} failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  // ElevenLabs counts concurrent streams, and a benchmark that trips its own
  // rate limit measures the rate limit.
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(`\n  written to ${OUT}\n`);
