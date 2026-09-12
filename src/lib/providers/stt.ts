import WebSocket from "ws";

/**
 * Streaming speech-to-text (Deepgram).
 *
 * The interesting part of an STT provider for a voice agent is not accuracy,
 * it is *endpointing*: knowing the caller has finished a thought. Get it
 * eager and you interrupt people mid-sentence; get it lazy and every reply
 * feels a beat late. Deepgram's `speech_final` is the signal we act on, with
 * `UtteranceEnd` as a backstop for callers whose line is noisy enough that
 * the endpointer never fires.
 */

export interface SttOptions {
  encoding: "linear16" | "mulaw";
  sampleRate: number;
  /** Words so far, revised as the caller keeps talking. */
  onPartial?: (text: string) => void;
  /** The caller finished a thought — this is the cue to answer. */
  onFinal: (text: string) => void;
  /** Caller started speaking, which is the barge-in trigger. */
  onSpeechStart?: () => void;
  /**
   * The caller has *probably* finished, and it is worth starting an answer.
   *
   * Only Flux produces this. It is the same bet the session makes for itself
   * on nova-3 by watching the transcript go quiet, with the difference that
   * Flux is betting on the sentence sounding finished rather than on the
   * caller having stopped for long enough — which is the bet a person makes.
   */
  onEagerEnd?: (text: string) => void;
  /** The eager guess was wrong; the caller carried on. Throw the work away. */
  onTurnResumed?: () => void;
  onError?: (message: string) => void;
  /**
   * Words this venue expects to hear that a general model will not: its own
   * name, its sections, its dishes and treatments. Deepgram weights these, so
   * "a table on the Terrace" stops coming back as "on the terrorist".
   */
  keyterms?: string[];
}

export interface SttStream {
  send(chunk: Buffer): void;
  close(): void;
  readonly ready: Promise<void>;
  readonly enabled: boolean;
  /** Whether this engine decides for itself when a turn is over. */
  readonly predictsTurnEnd: boolean;
}

const KEEPALIVE_MS = 8000;

/**
 * Silence that closes a thought, on nova-3.
 *
 * Exported because `npm run bench:latency` reports what a caller waits, and a
 * benchmark that carries its own copy of this number stops being a benchmark
 * the first time somebody tunes it here. It had already drifted once.
 */
export const NOVA_ENDPOINTING_MS = {
  /** A lossy 8 kHz line, and callers who pause mid-sentence to check a diary. */
  phone: 500,
  /** Clean 16 kHz from somebody at a desk, watching the agent wait on screen. */
  browser: 240,
} as const;

/**
 * Which recogniser answers the phone.
 *
 * `nova-3` is the default because it is what has taken every call so far and
 * its failure mode is understood. `flux` is better at the thing that matters
 * most — it will not answer half a sentence — but it ends turns on meaning
 * rather than on silence, and meaning is exactly what a caller reciting a
 * phone number does not have half way through. Measured on our own audio it
 * called the turn over after "that's Andreas" and left the number to the next
 * one. That is survivable and arguably human, but it is a change in behaviour
 * that belongs on the demo line before it belongs on a customer's.
 *
 * `npm run bench:turns` is how you decide, on real audio, at phone quality.
 */
export type SttEngine = "nova-3" | "flux";

export function sttEngine(): SttEngine {
  return process.env.STT_ENGINE === "flux" ? "flux" : "nova-3";
}

export function createSttStream(opts: SttOptions): SttStream {
  const key = process.env.DEEPGRAM_API_KEY;

  if (!key) {
    // No key: accept audio and drop it. The caller can still use the text
    // console, and nothing upstream has to special-case a missing provider.
    return {
      send() {},
      close() {},
      ready: Promise.resolve(),
      enabled: false,
      predictsTurnEnd: false,
    };
  }

  if (sttEngine() === "flux") return createFluxStream(opts, key);

  // A phone line is 8 kHz µ-law over a lossy network and callers on one pause
  // more — mid-sentence, to check a diary, because the line lags. The browser
  // console is clean 16 kHz audio from someone sitting at a desk. Holding a
  // desk-tuned endpointer against a phone call is how the agent ends up
  // answering half a sentence, which the caller hears as not being listened to.
  const phone = opts.encoding === "mulaw";

  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    encoding: opts.encoding,
    sample_rate: String(opts.sampleRate),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    // Digits as digits: party sizes, times and phone numbers all arrive as
    // numbers people say aloud, and "twenty twenty five" is not a year.
    numerals: "true",
    // Silence that closes a thought.
    //
    // A phone line gets 500: it is 8 kHz over a lossy network, callers pause
    // mid-sentence to check a diary, and clipping someone reads as not being
    // listened to. A browser is clean 16 kHz from somebody at a desk with the
    // agent visibly waiting on screen, so it can afford to be quicker — and
    // on a demonstration the half-second of dead air after you stop talking
    // is the thing that makes it feel like software rather than a person.
    // 240 is as low as this goes before it starts cutting into pauses.
    endpointing: String(phone ? NOVA_ENDPOINTING_MS.phone : NOVA_ENDPOINTING_MS.browser),
    vad_events: "true",
    // Backstop for a line noisy enough that the endpointer never fires.
    utterance_end_ms: phone ? "1400" : "1000",
  });

  for (const term of opts.keyterms ?? []) {
    if (term.trim()) params.append("keyterm", term.trim());
  }

  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${key}` },
  });

  let open = false;
  const pending: Buffer[] = [];
  /** Finalised words not yet flushed — Deepgram sends a thought in pieces. */
  let settled = "";

  const ready = new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      open = true;
      for (const chunk of pending) socket.send(chunk);
      pending.length = 0;
      resolve();
    });
    socket.once("error", (err) => {
      opts.onError?.(err.message);
      reject(err);
    });
  });
  // A rejected `ready` that nobody awaits would take the process down.
  ready.catch(() => {});

  const keepalive = setInterval(() => {
    if (open && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, KEEPALIVE_MS);

  const flush = () => {
    const text = settled.trim();
    settled = "";
    if (text) opts.onFinal(text);
  };

  socket.on("message", (raw) => {
    let msg: {
      type?: string;
      is_final?: boolean;
      speech_final?: boolean;
      channel?: { alternatives?: { transcript?: string }[] };
    };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "SpeechStarted") {
      opts.onSpeechStart?.();
      return;
    }

    if (msg.type === "UtteranceEnd") {
      // Backstop: endpointing never fired but the caller has clearly stopped.
      flush();
      return;
    }

    if (msg.type !== "Results") return;
    const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";
    if (!transcript) return;

    if (msg.is_final) {
      settled = `${settled} ${transcript}`.trim();
      if (msg.speech_final) flush();
    } else {
      opts.onPartial?.(`${settled} ${transcript}`.trim());
    }
  });

  socket.on("close", () => clearInterval(keepalive));

  return {
    enabled: true,
    predictsTurnEnd: false,
    ready,
    send(chunk) {
      if (open && socket.readyState === WebSocket.OPEN) socket.send(chunk);
      else if (socket.readyState === WebSocket.CONNECTING) pending.push(chunk);
    },
    close() {
      clearInterval(keepalive);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "CloseStream" }));
        socket.close();
      } else {
        socket.terminate();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// A clip, whole
// ---------------------------------------------------------------------------

/**
 * Transcribe a finished recording — a voice note from the web chat.
 *
 * Not a stream: the visitor has already stopped talking, so there is no turn
 * to end and nothing to endpoint. One request, the words back. Same model and
 * the same formatting flags as the live line, so a number said into a voice
 * note comes back as the same digits it would on a call.
 *
 * Throws when no key is set. The caller decides what a visitor is told; this
 * function should not be quietly returning an empty string that reads as
 * "they said nothing".
 */
export async function transcribeClip(
  audio: Buffer,
  mime: string,
  opts: { keyterms?: string[]; signal?: AbortSignal } = {},
): Promise<string> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY is not set.");

  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    smart_format: "true",
    punctuate: "true",
    numerals: "true",
  });
  for (const term of opts.keyterms ?? []) {
    if (term.trim()) params.append("keyterm", term.trim());
  }

  const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": mime },
    body: new Uint8Array(audio),
    signal: opts.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Deepgram ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  return (data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
}

// ---------------------------------------------------------------------------
// Flux
// ---------------------------------------------------------------------------

/**
 * How sure Flux must be that the caller has finished before we answer.
 *
 * Measured on phone-quality audio of our own sentences: at 0.5 a finished
 * question is called over about 280 ms after the caller stops, at 0.7 about
 * 480 ms. The higher number is the default here because the cost of the two
 * mistakes is not symmetric — answering 200 ms sooner is barely noticed, and
 * answering over somebody who had not finished is the single thing callers
 * complain about.
 */
const EOT_THRESHOLD = "0.7";

/**
 * When to start preparing an answer, on a weaker hunch than the above.
 *
 * The work is thrown away if the caller carries on, so this can afford to be
 * wrong. It is the same trade the session makes on nova-3, moved into the
 * model that can hear the intonation.
 */
const EAGER_EOT_THRESHOLD = "0.4";

/**
 * A caller who trails off entirely still has to be answered.
 *
 * Flux will genuinely wait forever on an unfinished sentence — which is right,
 * and is the whole reason to use it, but a caller who says "I'd like a table
 * for, umm..." and then stops needs somebody to say "for how many?" rather
 * than listen politely for five seconds. Deepgram's own default is 5000.
 */
const EOT_TIMEOUT_MS = "1800";

function createFluxStream(opts: SttOptions, key: string): SttStream {
  const params = new URLSearchParams({
    model: "flux-general-en",
    encoding: opts.encoding,
    sample_rate: String(opts.sampleRate),
    eot_threshold: EOT_THRESHOLD,
    eager_eot_threshold: EAGER_EOT_THRESHOLD,
    eot_timeout_ms: EOT_TIMEOUT_MS,
  });

  for (const term of opts.keyterms ?? []) {
    if (term.trim()) params.append("keyterm", term.trim());
  }

  const socket = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, {
    headers: { Authorization: `Token ${key}` },
  });

  let open = false;
  const pending: Buffer[] = [];

  const ready = new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      open = true;
      for (const chunk of pending) socket.send(chunk);
      pending.length = 0;
      resolve();
    });
    socket.once("error", (err) => {
      opts.onError?.(err.message);
      reject(err);
    });
  });
  ready.catch(() => {});

  const keepalive = setInterval(() => {
    if (open && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, KEEPALIVE_MS);

  socket.on("message", (raw) => {
    let msg: { type?: string; event?: string; transcript?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Everything conversational arrives as TurnInfo; `event` is the part that
    // says what happened.
    if (msg.type !== "TurnInfo") return;
    const transcript = (msg.transcript ?? "").trim();

    switch (msg.event) {
      case "StartOfTurn":
        // Flux's own judgement that somebody has started talking — which is
        // what barge-in needs, and is steadier than voice activity because it
        // has already decided the noise was speech.
        opts.onSpeechStart?.();
        break;

      case "Update":
        if (transcript) opts.onPartial?.(transcript);
        break;

      case "EagerEndOfTurn":
        if (transcript) opts.onEagerEnd?.(transcript);
        break;

      case "TurnResumed":
        // The hunch was wrong: they were mid-breath, not finished.
        opts.onTurnResumed?.();
        break;

      case "EndOfTurn":
        if (transcript) opts.onFinal(transcript);
        break;
    }
  });

  socket.on("close", () => clearInterval(keepalive));

  return {
    enabled: true,
    predictsTurnEnd: true,
    ready,
    send(chunk) {
      if (open && socket.readyState === WebSocket.OPEN) socket.send(chunk);
      else if (socket.readyState === WebSocket.CONNECTING) pending.push(chunk);
    },
    close() {
      clearInterval(keepalive);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "CloseStream" }));
        socket.close();
      } else {
        socket.terminate();
      }
    },
  };
}
