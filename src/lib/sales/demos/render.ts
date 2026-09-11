import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DemoScript } from "./script";

/**
 * Turning a demo script into audio.
 *
 * Two voices, so it sounds like a conversation rather than one person reading
 * both parts — the same pairing the marketing site already uses, and the agent
 * voice is deliberately the one on the live line. A demo that uses a better
 * voice than the product is a lie the first real call exposes.
 *
 * **Clips live outside `public/`.** That is not tidiness: `npm run site`
 * copies every mp3 under `public/` into the marketing build, so a prospect's
 * personalised demo would ship to belline.ai and sit there under a real
 * business's name. They go under DATA_DIR instead and are served by a route
 * handler that checks expiry.
 *
 * Content-addressed on voice + model + text, so re-rendering an unchanged line
 * costs nothing and re-wording one produces a new file rather than a stale
 * cached clip.
 */

const MODEL = "eleven_v3_conversational";

const VOICES = {
  agent: process.env.ELEVENLABS_VOICE_ID || "hpp4J3VqNfWAUOO0d1Us",
  caller: "onwK4e9ZLuTAKqWW03F9",
} as const;

export type Role = keyof typeof VOICES;

export function demoRoot(): string {
  const base = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
  return path.join(base, "demos");
}

export function clipId(role: Role, text: string): string {
  return crypto
    .createHash("sha256")
    .update(`${VOICES[role]}|${MODEL}|${text}`)
    .digest("hex")
    .slice(0, 16);
}

export function ttsAvailable(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

async function synthesise(role: Role, text: string): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set — demos cannot be rendered.");

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
          // The caller is a member of the public on a phone, not a presenter.
          speed: role === "caller" ? 1.02 : 1.05,
        },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export interface RenderedClip {
  id: string;
  role: Role;
  text: string;
  bytes: number;
  reused: boolean;
}

export interface RenderResult {
  clips: RenderedClip[];
  madeCount: number;
  reusedCount: number;
  totalBytes: number;
  /** Characters billed by the speech vendor — only the newly synthesised ones. */
  charactersBilled: number;
}

/**
 * Render every line of a script, plus the closing disclosure.
 *
 * The disclosure is rendered as an ordinary agent clip so it cannot be
 * silently dropped by a player that stops early: it is part of the audio, not
 * an overlay on the page.
 */
export async function renderScript(
  script: DemoScript,
  disclosure: string,
): Promise<RenderResult> {
  const root = demoRoot();
  fs.mkdirSync(root, { recursive: true });

  const lines: { role: Role; text: string }[] = [
    ...script.turns.map((t) => ({ role: t.role as Role, text: t.text })),
    { role: "agent", text: disclosure },
  ];

  const clips: RenderedClip[] = [];
  let madeCount = 0;
  let reusedCount = 0;
  let totalBytes = 0;
  let charactersBilled = 0;

  for (const line of lines) {
    const id = clipId(line.role, line.text);
    const file = path.join(root, `${id}.mp3`);

    if (fs.existsSync(file)) {
      const bytes = fs.statSync(file).size;
      clips.push({ id, role: line.role, text: line.text, bytes, reused: true });
      reusedCount++;
      totalBytes += bytes;
      continue;
    }

    const audio = await synthesise(line.role, line.text);
    // Temp file then rename: a half-written clip whose name is a hash of its
    // intended content would be cached forever as correct.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, audio);
    fs.renameSync(tmp, file);

    clips.push({ id, role: line.role, text: line.text, bytes: audio.length, reused: false });
    madeCount++;
    totalBytes += audio.length;
    charactersBilled += line.text.length;
  }

  return { clips, madeCount, reusedCount, totalBytes, charactersBilled };
}

/** Resolve a clip id to a file, refusing anything that is not a plain id. */
export function clipPath(id: string): string | null {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const file = path.join(demoRoot(), `${id}.mp3`);
  return fs.existsSync(file) ? file : null;
}

/**
 * ElevenLabs bills per character. Roughly $0.10–0.30 per 1,000 on the usual
 * plans; configurable because the rate depends on the plan and a stale
 * constant misreports cost-per-demo.
 */
export function ttsCostUsd(characters: number): number {
  const perThousand = Number(process.env.ELEVENLABS_COST_PER_1K_CHARS ?? 0.18);
  return (characters / 1000) * perThousand;
}
