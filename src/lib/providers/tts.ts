/**
 * Streaming text-to-speech (ElevenLabs).
 *
 * One HTTP request per speakable fragment, streamed and abortable. That last
 * property is the whole design: when a caller talks over the agent we must
 * stop the audio *now*, and cancelling a fetch is a great deal simpler to
 * reason about than unwinding a shared websocket context.
 *
 * Model choice is a per-venue judgement between latency and warmth, so it is
 * a config field rather than a constant. See `VOICE_MODELS`.
 */

/**
 * The models worth offering. Anything slower than turbo makes the caller wait
 * through a silence they read as "it didn't hear me", which costs more than
 * the extra warmth buys.
 */
export const VOICE_MODELS = [
  {
    id: "eleven_v3_conversational",
    label: "Conversational",
    hint: "Tuned for talking to someone rather than reading to them. Measured at 669 ms to first audio — no slower than the others. Recommended.",
    // Rejects previous_text outright with a 400. It carries conversational
    // cadence natively, which is the reason to pick it, so it needs the
    // conditioning less than the models that do accept it.
    takesContext: false,
  },
  {
    id: "eleven_turbo_v2_5",
    label: "Neutral",
    hint: "Even, professional delivery. Slightly more announcement than conversation.",
    takesContext: true,
  },
  {
    id: "eleven_flash_v2_5",
    label: "Fastest",
    hint: "Flattest delivery. Only worth it if a venue is on a slow connection.",
    takesContext: true,
  },
  {
    id: "eleven_multilingual_v2",
    label: "Studio",
    hint: "Best in a quiet room, but 4.5 s to first audio — far too slow for a phone call.",
    takesContext: true,
  },
] as const;

/**
 * Whether this model accepts the preceding fragment for prosody continuity.
 *
 * Unknown models — a venue pinned to something not on the list — are assumed
 * not to. Sending the field to a model that refuses it is a 400, which would
 * silence every fragment after the first for the length of the call; omitting
 * it merely costs a seam between sentences.
 */
function takesContext(model: string): boolean {
  return VOICE_MODELS.find((m) => m.id === model)?.takesContext ?? false;
}

/**
 * Measured, not assumed: at 8 kHz µ-law, first audio arrives in 669 ms on the
 * conversational model against 751 ms on turbo and 688 ms on flash. The model
 * that sounds least synthetic is not the one that costs latency, so there is
 * no trade to make here and the warmest option is the default.
 */
export const DEFAULT_VOICE_MODEL = "eleven_v3_conversational";

/** Enough preceding speech to carry a contour; more buys nothing. */
const PREVIOUS_TEXT_CHARS = 300;

/**
 * A shade quicker than the voice's natural pace. Slow reads as a recording;
 * much past this and a caller repeating a phone number cannot keep up.
 */
export const DEFAULT_VOICE_SPEED = 1.05;
export const MIN_VOICE_SPEED = 0.8;
export const MAX_VOICE_SPEED = 1.2;

function clampSpeed(speed: number | undefined): number {
  if (typeof speed !== "number" || Number.isNaN(speed)) return DEFAULT_VOICE_SPEED;
  return Math.min(MAX_VOICE_SPEED, Math.max(MIN_VOICE_SPEED, speed));
}

/**
 * `pcm_16000` for the browser console, `ulaw_8000` for the phone network,
 * `mp3_44100_128` only for voice previews in the dashboard — an `<audio>`
 * element will not play raw PCM.
 */
export type TtsFormat = "pcm_16000" | "ulaw_8000" | "mp3_44100_128";

export interface SpeakOptions {
  voiceId: string;
  format: TtsFormat;
  modelId?: string;
  signal?: AbortSignal;
  /**
   * Delivery pace, 0.7 to 1.2, where 1 is the voice's natural rate.
   *
   * A receptionist who is a touch brisk sounds competent; one who is slow
   * sounds like a recording, and on a metered line every caller is paying for
   * the difference. The conversational model honours this more gently than
   * turbo does — measured, the same line runs 5.52 s at 0.8 and 4.56 s at
   * 1.2, against 5.85 s and 3.81 s on turbo.
   */
  speed?: number;
  /**
   * What the agent said immediately before this fragment, in the same turn.
   *
   * We cut a reply at clause boundaries so speech can start before the model
   * has finished writing — but each fragment is then synthesised on its own,
   * and a fragment synthesised on its own restarts the intonation from
   * scratch. Three sentences in a row all opening on the same pitch is a
   * large part of what people hear as "a computer reading to me". Given the
   * preceding words, the engine continues the contour instead of resetting
   * it, and the seam stops being audible.
   */
  previousText?: string;
}

export function ttsEnabled(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

/**
 * Yields raw audio chunks in the requested format. Yields nothing at all when
 * no key is configured, so callers that only want a transcript keep working.
 */
export async function* speak(
  text: string,
  opts: SpeakOptions,
): AsyncGenerator<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !text.trim()) return;

  const model = opts.modelId ?? DEFAULT_VOICE_MODEL;

  const params = new URLSearchParams({ output_format: opts.format });
  // 0 = none, 4 = maximum. Every step above 0 weakens the text normaliser,
  // which is what turns "7pm" into "seven p.m." and reads a phone number back
  // in groups. On the flash model that trade is worth it; on the models chosen
  // *for* their delivery it defeats the point of choosing them.
  if (model === "eleven_flash_v2_5") {
    params.set("optimize_streaming_latency", "2");
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${opts.voiceId}/stream?${params}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        // Only the tail matters for prosody, and sending the whole turn back
        // on every fragment would grow quadratically with the length of the
        // answer.
        ...(opts.previousText && takesContext(model)
          ? { previous_text: opts.previousText.slice(-PREVIOUS_TEXT_CHARS) }
          : {}),
        voice_settings: {
          // Below ~0.45 the delivery wanders between fragments, and because we
          // stream a sentence at a time that wander lands mid-answer. Half is
          // steady without going robotic.
          stability: 0.5,
          similarity_boost: 0.8,
          // A little, not none: zero reads like a station announcement. Much
          // more and it starts acting, which is wrong for a receptionist.
          style: 0.15,
          use_speaker_boost: true,
          speed: clampSpeed(opts.speed),
        },
      }),
      signal: opts.signal,
    },
  );

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs ${response.status}: ${detail.slice(0, 200)}`);
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

/**
 * Audio for a line the agent says verbatim on every call.
 *
 * The greeting is the case that matters. It is identical call after call, yet
 * it was costing a full synthesis round trip — measured at 669 ms — of dead
 * air at the exact moment a caller is deciding whether anyone is there. Held
 * in memory the second caller onward hears it immediately.
 *
 * Deliberately not persisted: it is cheap to rebuild, it must not survive a
 * voice being changed in the dashboard, and a stale greeting on disk would be
 * a genuinely confusing bug to chase.
 */
const CLIP_CACHE_MAX = 24;
const clipCache = new Map<string, Buffer>();

export async function speakClip(text: string, opts: SpeakOptions): Promise<Buffer> {
  const key = [
    opts.voiceId,
    opts.modelId ?? DEFAULT_VOICE_MODEL,
    opts.format,
    clampSpeed(opts.speed),
    text,
  ].join(" ");

  const hit = clipCache.get(key);
  if (hit) {
    // Re-insert so the map stays in least-recently-used order.
    clipCache.delete(key);
    clipCache.set(key, hit);
    return hit;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of speak(text, opts)) chunks.push(chunk);
  const audio = Buffer.concat(chunks);

  if (audio.length > 0) {
    clipCache.set(key, audio);
    if (clipCache.size > CLIP_CACHE_MAX) {
      const oldest = clipCache.keys().next().value;
      if (oldest !== undefined) clipCache.delete(oldest);
    }
  }
  return audio;
}
