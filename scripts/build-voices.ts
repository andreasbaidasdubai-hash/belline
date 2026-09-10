/**
 * Render the website's demo calls to audio.
 *
 * The landing page claims Belline sounds natural. A transcript cannot make
 * that case — only the voice can — so every line of every scene is
 * synthesised here at build time and shipped as a static file. No API key is
 * needed to *serve* the site, only to change what it says.
 *
 * Clips are content-addressed: the filename is a hash of the voice, the model
 * and the words. Rewording a line generates a new clip; rebuilding without
 * changing anything costs nothing and spends no quota. Nothing is ever
 * deleted automatically — a stale clip is a few kilobytes, a missing one is a
 * silent page.
 *
 *   npm run voices
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VERTICALS } from "./site-content";

const OUT = path.join("public", "audio");
const MANIFEST = path.join(OUT, "manifest.json");
const MODEL = "eleven_v3_conversational";

/**
 * Two voices, so the recording sounds like a conversation rather than one
 * person reading both parts. Bella answers — she is the voice on the live
 * line, and the page would be lying if the demo used a better one.
 */
const VOICES = {
  agent: process.env.ELEVENLABS_VOICE_ID || "hpp4J3VqNfWAUOO0d1Us",
  caller: "onwK4e9ZLuTAKqWW03F9",
} as const;

function keyFor(role: "agent" | "caller", text: string): string {
  return crypto
    .createHash("sha256")
    .update(`${VOICES[role]}|${MODEL}|${text}`)
    .digest("hex")
    .slice(0, 16);
}

async function synthesise(role: "agent" | "caller", text: string): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set.");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICES[role]}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0.15,
          use_speaker_boost: true,
          // The caller is a member of the public on a phone, not a
          // presenter — a shade quicker and less even than the agent.
          speed: role === "caller" ? 1.02 : 1.05,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

fs.mkdirSync(OUT, { recursive: true });

/** text -> clip filename, for every line the site can play. */
const manifest: Record<string, string> = fs.existsSync(MANIFEST)
  ? JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
  : {};

const lines: { role: "agent" | "caller"; text: string }[] = [];
for (const vertical of VERTICALS) {
  for (const scene of vertical.scenes) {
    for (const [role, text] of scene.turns) {
      if (!lines.some((l) => l.text === text)) {
        lines.push({ role: role === "agent" ? "agent" : "caller", text });
      }
    }
  }
}

let made = 0;
let reused = 0;
let bytes = 0;

for (const line of lines) {
  const name = `${keyFor(line.role, line.text)}.mp3`;
  const file = path.join(OUT, name);

  if (fs.existsSync(file)) {
    reused++;
  } else {
    const audio = await synthesise(line.role, line.text);
    fs.writeFileSync(file, audio);
    made++;
    console.log(`  + ${line.role.padEnd(6)} ${name}  ${(audio.length / 1024).toFixed(0)} KB  "${line.text.slice(0, 52)}…"`);
  }
  manifest[line.text] = name;
  bytes += fs.statSync(file).size;
}

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");

console.log(
  `\n  ${lines.length} lines — ${made} rendered, ${reused} already on disk. ` +
    `${(bytes / 1024).toFixed(0)} KB total.\n`,
);
