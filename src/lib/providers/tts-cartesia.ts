/**
 * Streaming text-to-speech from Cartesia — the second engine, for the one
 * reason it exists: so the telephone and the website's voice button can speak
 * in the same voice as the video receptionist, when that voice is a Cartesia
 * voice (docs/video/voice.md).
 *
 * Request shape from the API reference, read 17 September 2026
 * (https://docs.cartesia.ai/api-reference/tts/bytes): `POST /tts/bytes`,
 * `Authorization: Bearer <key>`, `Cartesia-Version`, a body of `model_id`,
 * `transcript`, `voice` (an id), `language`, `output_format`
 * `{ container, encoding, sample_rate, bit_rate }` and `generation_config.speed`
 * (0.6–1.5). The response body is the audio, streamed.
 *
 * Like the ElevenLabs path: one abortable HTTP request per fragment, so
 * barge-in is `abort()`. Inert without `CARTESIA_API_KEY` — it yields nothing,
 * and the voice choice (voice-choice.ts) never picks it without a key.
 */

import type { TtsFormat } from "./tts";

export const CARTESIA_API_VERSION = "2026-08-14";
export const CARTESIA_DEFAULT_MODEL = "sonic-3.6";
const MIN_SPEED = 0.6;
const MAX_SPEED = 1.5;

type Env = Record<string, string | undefined>;

export function cartesiaEnabled(env: Env = process.env): boolean {
  return Boolean((env.CARTESIA_API_KEY ?? "").trim());
}

/** The formats Belline's transports use, in Cartesia's words. */
export function cartesiaOutputFormat(format: TtsFormat): Record<string, string | number> {
  switch (format) {
    case "pcm_16000":
      return { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 };
    case "ulaw_8000":
      // The phone network's own encoding: no transcoding on the call path.
      return { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 };
    case "mp3_44100_128":
      return { container: "mp3", sample_rate: 44100, bit_rate: 128000 };
  }
}

export interface CartesiaSpeakOptions {
  voiceId: string;
  format: TtsFormat;
  modelId?: string;
  speed?: number;
  languageCode?: string;
  signal?: AbortSignal;
}

/** The request, without the key. Exported so the checks can pin it without a network call. */
export function cartesiaRequest(text: string, opts: CartesiaSpeakOptions, env: Env = process.env) {
  const speed = typeof opts.speed === "number" && Number.isFinite(opts.speed) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, opts.speed)) : 1;
  return {
    url: "https://api.cartesia.ai/tts/bytes",
    headers: { "Cartesia-Version": CARTESIA_API_VERSION, "Content-Type": "application/json" },
    body: {
      model_id: (opts.modelId ?? env.CARTESIA_MODEL_ID ?? "").trim() || CARTESIA_DEFAULT_MODEL,
      transcript: text,
      voice: { id: opts.voiceId },
      language: opts.languageCode ?? "en",
      output_format: cartesiaOutputFormat(opts.format),
      generation_config: { speed: Math.round(speed * 100) / 100 },
    },
  };
}

type Fetch = typeof fetch;

export async function* speakCartesia(
  text: string,
  opts: CartesiaSpeakOptions,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  env: Env = process.env,
): AsyncGenerator<Buffer> {
  const key = (env.CARTESIA_API_KEY ?? "").trim();
  if (!key || !text.trim()) return;
  const request = cartesiaRequest(text, opts, env);
  const response = await fetchImpl(request.url, {
    method: "POST",
    headers: { ...request.headers, Authorization: `Bearer ${key}` },
    body: JSON.stringify(request.body),
    signal: opts.signal,
  });
  if (!response.ok || !response.body) {
    // Status and Cartesia's own words, short. Never the request.
    const detail = await response.text().catch(() => "");
    throw new Error(`Cartesia ${response.status}: ${detail.slice(0, 200)}`);
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}
