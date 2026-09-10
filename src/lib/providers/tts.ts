/**
 * Streaming text-to-speech (ElevenLabs).
 *
 * One HTTP request per speakable fragment, streamed and abortable. That last
 * property is the whole design: when a caller talks over the agent we must
 * stop the audio *now*, and cancelling a fetch is a great deal simpler to
 * reason about than unwinding a shared websocket context.
 *
 * `eleven_flash_v2_5` is the latency-tuned model — roughly 150 ms to first
 * byte. `eleven_turbo_v2_5` sounds better and costs about 200 ms more; it is
 * a per-venue judgement, so it is a config field rather than a constant.
 */

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

  const params = new URLSearchParams({
    output_format: opts.format,
    // 0 = no latency optimisation, 4 = maximum. 3 is the usual sweet spot:
    // noticeably faster with only slight degradation of the text normaliser.
    optimize_streaming_latency: "3",
  });

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
        model_id: opts.modelId ?? "eleven_flash_v2_5",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75,
          speed: 1.0,
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
