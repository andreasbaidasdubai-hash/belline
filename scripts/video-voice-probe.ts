/**
 * Which voice does Belle speak with on the video call? Read-only, free.
 *
 * MAIN-SESSION / OWNER-RUN. Two GETs against the real Tavus API, so it never
 * runs in the checks:
 *
 *   node --import tsx --env-file=.env scripts/video-voice-probe.ts [--face <id>] [--pal <id>]
 *
 *   1. GET /v2/faces/{face_id}  → default_voice_id
 *      https://docs.tavus.io/api-reference/faces/get-face
 *   2. GET /v2/pals/{pal_id}    → layers.tts (tts_engine, external_voice_id, voice_id)
 *      https://docs.tavus.io/api-reference/pals/get-pal  (skipped without a PAL id)
 *
 * Prints what speaks, and the exact settings that make the phone and the
 * website's voice button sound the same (docs/video/voice.md). Prints no key.
 */

import { classifyVideoVoice } from "../src/lib/video/voice-probe";

const args = process.argv.slice(2);
const value = (name: string, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const apiKey = (process.env.TAVUS_API_KEY ?? "").trim();
const faceId = (value("face") || process.env.TAVUS_FACE_ID || "").trim();
const palId = (value("pal") || process.env.TAVUS_PAL_ID || "").trim();
const base = (process.env.TAVUS_API_BASE ?? "https://tavusapi.com").replace(/\/+$/, "");

if (process.env.FLAG_STUBS === "on") {
  console.error("Refusing to run under FLAG_STUBS=on: this calls the real Tavus API.");
  process.exit(1);
}
if (!apiKey || !faceId) {
  console.error("Set TAVUS_API_KEY and TAVUS_FACE_ID (or pass --face).");
  process.exit(1);
}

async function get(path: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${base}${path}`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    console.log(`  GET ${path.split("?")[0]} → HTTP ${res.status}`);
    return null;
  }
  return (await res.json()) as Record<string, any>;
}

const face = await get(`/v2/faces/${encodeURIComponent(faceId)}`);
const pal = palId ? await get(`/v2/pals/${encodeURIComponent(palId)}`) : null;
const tts = (pal?.layers?.tts ?? null) as Record<string, unknown> | null;

console.log(`
  face ${faceId}: ${face?.face_name ?? "?"} (${face?.model_name ?? "?"}), default_voice_id=${face?.default_voice_id ?? "none"}
  PAL  ${palId || "(none)"}: tts=${tts ? JSON.stringify({ tts_engine: tts.tts_engine, voice_id: tts.voice_id, external_voice_id: tts.external_voice_id, tts_model_name: tts.tts_model_name }) : "none"}
`);
const verdict = classifyVideoVoice(face, tts);
console.log(`  ${verdict.kind.toUpperCase()}: ${verdict.advice}\n`);
