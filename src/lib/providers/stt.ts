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
}

const KEEPALIVE_MS = 8000;

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
    };
  }

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
    // Silence that closes a thought. Below ~250 you clip people who pause to
    // think; above ~600 the agent feels slow to react.
    endpointing: phone ? "500" : "300",
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
