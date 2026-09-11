import type { Call, Location } from "../types";
import { AgentSession } from "../agent/runtime";
import { createSttStream, type SttStream } from "../providers/stt";
import { speak, speakClip, ttsEnabled, type TtsFormat } from "../providers/tts";
import { saveCall } from "../store";
import { maxCallSeconds } from "../demo";
import { speechKeyterms } from "../verticals";
import { assessAuthority, type Assessment } from "../agent/authority";
import { toSpoken } from "./spoken";

/**
 * One live call.
 *
 * Wires speech in -> agent -> speech out, and owns the two behaviours that
 * separate a voice agent from a chatbot with a microphone:
 *
 *   Barge-in. The moment the caller speaks over the agent, the agent stops.
 *   Not at the end of the sentence — mid-word. Anything else feels like
 *   arguing with a recording, and it is the first thing people notice.
 *
 *   Generation fencing. A cancelled turn may still have a model stream and
 *   two TTS requests in flight. Every unit of work carries the generation it
 *   belongs to and output from a stale generation is dropped on the floor,
 *   so an interrupted answer can never leak into the next one.
 */

/**
 * How long the agent must have been speaking before a voice-activity blip
 * counts as the caller interrupting. Long enough to cover the agent's own
 * first syllable echoing back off a speakerphone, short enough that a caller
 * who genuinely talks over the greeting is still obeyed.
 */
const BARGE_IN_GUARD_MS = 400;

/**
 * How settled an interim transcript must be before it is worth guessing on.
 *
 * Too eager and every syllable starts a turn that is immediately thrown away;
 * too patient and the endpointer fires first and the work was pointless. A
 * caller who has stopped producing new words for this long has almost always
 * finished, which is the same judgement the endpointer is making — only this
 * one is free to be wrong.
 */
const GUESS_AFTER_MS = 140;

/** Below this a transcript is a filler word, not a turn. */
const GUESS_MIN_CHARS = 10;

interface Guess {
  /** The interim transcript this was built from. */
  text: string;
  /** Fragments, already synthesised, waiting to be released. */
  ready: { text: string; audio: Buffer }[];
  /** Set when the model reached for a tool that writes, or the run failed. */
  dead: boolean;
  /** Resolves when the speculative run has finished one way or another. */
  done: Promise<void>;
  abort: AbortController;
}

/**
 * Two transcripts of the same sentence.
 *
 * Deepgram's interim and final differ in punctuation and capitalisation far
 * more often than in words, and a guess is only safe to use if the caller
 * said the same thing — not something that merely starts the same way.
 */
function sameUtterance(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

export interface Transport {
  /** Format the caller's audio arrives in. */
  input: { encoding: "linear16" | "mulaw"; sampleRate: number };
  /** Format the agent's audio must be produced in. */
  output: TtsFormat;
  sendAudio(chunk: Buffer): void;
  /** Structured events for the browser console; a no-op for telephony. */
  sendEvent(event: Record<string, unknown>): void;
  /** Drop whatever is buffered at the far end — used for barge-in. */
  clearAudio(): void;
  close(): void;
}

export class VoiceSession {
  private readonly agent: AgentSession;
  private readonly call: Call;
  private readonly location: Location;
  private readonly transport: Transport;
  private stt: SttStream | null = null;

  private generation = 0;
  private speaking = false;
  private thinking = false;
  private abort: AbortController | null = null;
  private speakingSince = 0;
  /** What has already been spoken this turn, to carry prosody across cuts. */
  private spokenThisTurn = "";
  /**
   * A turn being prepared on a guess, before the caller has finished.
   *
   * The endpointer waits half a second of silence before it will call a turn
   * finished. That half second was dead time: nothing started until it
   * elapsed, so the caller paid for it twice — once waiting to be understood,
   * again waiting for an answer. Now the model and the voice run during it
   * and the audio is held. If the guess was right it is already in the
   * caller's ear the moment the endpointer agrees.
   */
  private guess: Guess | null = null;
  private guessTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private timeout: NodeJS.Timeout | null = null;

  constructor(
    location: Location,
    call: Call,
    transport: Transport,
    callerNumber?: string,
  ) {
    this.location = location;
    this.call = call;
    this.transport = transport;
    this.agent = new AgentSession(location, call, callerNumber);
  }

  async start(): Promise<void> {
    this.stt = createSttStream({
      encoding: this.transport.input.encoding,
      sampleRate: this.transport.input.sampleRate,
      onSpeechStart: () => this.onSpeechStart(),
      onPartial: (text) => {
        this.transport.sendEvent({ type: "partial", text });
        this.considerGuess(text);
      },
      onFinal: (text) => void this.onCallerTurn(text),
      onError: (message) => this.transport.sendEvent({ type: "stt_error", message }),
      keyterms: speechKeyterms(this.location),
    });

    this.transport.sendEvent({
      type: "ready",
      location: { id: this.location.id, name: this.location.name, vertical: this.location.vertical },
      stt: this.stt.enabled,
      tts: ttsEnabled(),
      llm: Boolean(process.env.ANTHROPIC_API_KEY),
    });

    // Hard stop, so a caller who puts the phone down on the table does not
    // hold a session (and a meter) open indefinitely. Shorter on a demo line.
    this.timeout = setTimeout(
      () => void this.end("abandoned", "Call exceeded the maximum duration."),
      maxCallSeconds(this.location) * 1000,
    );

    const greeting = this.agent.greeting();
    this.pushTranscript("agent", greeting);
    this.transport.sendEvent({ type: "transcript", role: "agent", text: greeting });
    await this.say(greeting, ++this.generation, { cache: true });
    // Close the bubble so the caller's first reply does not get merged into
    // the greeting in the console.
    this.transport.sendEvent({ type: "turn_end", latencyMs: 0 });
  }

  /** Raw audio from the caller, already in `transport.input` format. */
  onAudio(chunk: Buffer): void {
    this.stt?.send(chunk);
  }

  /** Text typed in the console instead of spoken. */
  async onText(text: string): Promise<void> {
    await this.onCallerTurn(text);
  }

  private onSpeechStart(): void {
    // Deepgram fires SpeechStarted on any speech-shaped energy: the tail of
    // the caller's own sentence, a breath, line noise on a mobile. Two guards,
    // because without them the agent silently drops the turn it is already
    // working on and the caller hears nothing back.
    //
    // While merely thinking there is no audio to cut off, so a VAD blip has
    // nothing to interrupt — and cancelling here would bin the turn the caller
    // just finished. Real continued speech still arrives as a fresh final
    // transcript, and `onCallerTurn` interrupts properly at that point.
    if (!this.speaking) return;

    // And once speaking, ignore the first moments: on a speakerphone the
    // agent's own opening syllable comes back down the line and would cut
    // itself off mid-word.
    if (Date.now() - this.speakingSince < BARGE_IN_GUARD_MS) return;

    this.interrupt();
  }

  /**
   * Start preparing an answer while the caller is still being listened to.
   *
   * Debounced on the transcript settling rather than on a timer from the last
   * word, because a caller mid-sentence produces new text continuously and
   * each new word should cancel the guess built on the old one.
   */
  private considerGuess(partial: string): void {
    const text = partial.trim();
    if (this.closed || this.speaking || this.thinking) return;
    if (text.length < GUESS_MIN_CHARS) return;
    if (this.guess && sameUtterance(this.guess.text, text)) return;

    this.dropGuess();
    if (this.guessTimer) clearTimeout(this.guessTimer);
    this.guessTimer = setTimeout(() => this.startGuess(text), GUESS_AFTER_MS);
  }

  private startGuess(text: string): void {
    if (this.closed || this.speaking || this.thinking) return;

    const abort = new AbortController();
    const guess: Guess = { text, ready: [], dead: false, done: Promise.resolve(), abort };
    this.guess = guess;

    guess.done = (async () => {
      try {
        for await (const event of this.agent.respond(text, { speculative: true })) {
          if (abort.signal.aborted) return;
          if (event.type === "abandon" || event.type === "error") {
            guess.dead = true;
            return;
          }
          if (event.type !== "sentence") continue;

          // Synthesised now, held back. This is the half second being bought.
          const spoken = toSpoken(event.text);
          const chunks: Buffer[] = [];
          for await (const chunk of speak(spoken.text, {
            voiceId: this.location.agent.voiceId,
            modelId: this.location.agent.voiceModel,
            speed: spoken.speed * ((this.location.agent.voiceSpeed ?? 1.05) / 1.05),
            format: this.transport.output,
            signal: abort.signal,
          })) {
            chunks.push(chunk);
          }
          if (abort.signal.aborted) return;
          guess.ready.push({ text: event.text, audio: Buffer.concat(chunks) });
        }
      } catch {
        guess.dead = true;
      }
    })();
  }

  private dropGuess(): void {
    if (this.guessTimer) {
      clearTimeout(this.guessTimer);
      this.guessTimer = null;
    }
    if (!this.guess) return;
    this.guess.abort.abort();
    this.guess = null;
    this.agent.discardSpeculation();
  }

  /**
   * Use a guess, if it turned out to be right.
   *
   * Everything has to line up: the caller said what we guessed, the run
   * finished without reaching for a tool that writes, and the agent agrees
   * the history it built belongs to this exact sentence. Anything short of
   * that and the real turn runs from scratch — the cost of being wrong is
   * some wasted tokens, and the cost of being wrong *and using it anyway* is
   * answering a question nobody asked.
   */
  private async useGuess(text: string, gen: number): Promise<boolean> {
    const guess = this.guess;
    if (!guess || !sameUtterance(guess.text, text)) {
      this.dropGuess();
      return false;
    }

    await guess.done;
    if (gen !== this.generation) return false;
    if (guess.dead || guess.ready.length === 0 || !this.agent.adopt(guess.text)) {
      this.dropGuess();
      return false;
    }

    this.guess = null;
    for (const fragment of guess.ready) {
      if (gen !== this.generation) return true;
      this.transport.sendEvent({ type: "transcript", role: "agent", text: fragment.text });
      this.speaking = true;
      this.speakingSince = Date.now();
      this.transport.sendAudio(fragment.audio);
      this.spokenThisTurn = `${this.spokenThisTurn} ${fragment.text}`.trim();
    }
    this.speaking = false;
    this.appendAgentTurn(guess.ready.map((f) => f.text).join(" "), 0);
    this.transport.sendEvent({ type: "turn_end", latencyMs: 0 });
    saveCall(this.call);
    return true;
  }

  private interrupt(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.speaking = false;
    this.thinking = false;
    this.spokenThisTurn = "";
    this.dropGuess();
    this.transport.clearAudio();
    this.transport.sendEvent({ type: "interrupted" });
  }

  private async onCallerTurn(text: string): Promise<void> {
    if (this.closed || !text.trim()) return;

    // Anything still in flight belongs to the previous turn.
    if (this.speaking || this.thinking) this.interrupt();

    const gen = ++this.generation;
    // A new answer starts a new contour — the previous turn's words would
    // condition this one toward a cadence that no longer fits.
    this.spokenThisTurn = "";
    this.pushTranscript("caller", text);
    this.transport.sendEvent({ type: "transcript", role: "caller", text });

    // Before the model, not after. For the handful of categories where being
    // wrong once is unacceptable — someone describing an emergency, someone
    // asking reception for clinical advice — the answer is fixed and the
    // model is never consulted, so there is nothing for it to be talked out
    // of. Everything else is its judgement, which is most turns.
    const breach = assessAuthority(this.location, text);
    if (breach) {
      await this.enforce(breach, gen);
      return;
    }

    // The answer may already be synthesised and waiting, prepared while the
    // endpointer was still deciding the caller had stopped.
    if (await this.useGuess(text, gen)) return;

    this.thinking = true;

    let endAfter: string | null = null;

    try {
      for await (const event of this.agent.respond(text)) {
        if (gen !== this.generation) return;

        switch (event.type) {
          case "sentence":
            this.thinking = false;
            this.transport.sendEvent({ type: "transcript", role: "agent", text: event.text });
            await this.say(event.text, gen);
            if (gen !== this.generation) return;
            break;

          case "tool":
            this.transport.sendEvent({ type: "tool", trace: event.trace });
            break;

          case "control":
            endAfter = event.action;
            break;

          case "error":
            this.transport.sendEvent({ type: "error", message: event.message });
            break;

          case "turn_end":
            this.appendAgentTurn(event.text, event.firstAudioMs);
            this.transport.sendEvent({
              type: "turn_end",
              latencyMs: event.firstAudioMs,
            });
            break;
        }
      }
    } finally {
      if (gen === this.generation) {
        this.thinking = false;
        saveCall(this.call);
      }
    }

    if (endAfter && gen === this.generation) {
      await this.end(
        this.call.outcome ?? (endAfter === "transfer" ? "transferred" : "answered_question"),
        this.call.summary,
      );
    }
  }

  /**
   * Carry out an authority rule.
   *
   * The words are the rule's own, verbatim, and the call ends or transfers
   * according to the rule rather than according to how the conversation felt.
   * Recorded on the call so there is an auditable answer to "why did it say
   * that" — which is the question that actually gets asked afterwards.
   */
  private async enforce(breach: Assessment, gen: number): Promise<void> {
    const { rule } = breach;
    this.call.authorityRuleId = rule.id;

    this.pushTranscript("agent", rule.say);
    this.transport.sendEvent({ type: "transcript", role: "agent", text: rule.say });
    this.transport.sendEvent({ type: "escalated", ruleId: rule.id, reason: rule.reason });

    await this.say(rule.say, gen);
    if (gen !== this.generation) return;

    if (rule.then === "end_call") {
      await this.end("escalated", rule.reason);
      return;
    }
    await this.end(rule.then === "transfer" ? "transferred" : "message_taken", rule.reason);
  }

  /** Speak one fragment, abortable, dropping output from a stale generation. */
  private async say(text: string, gen: number, opts?: { cache?: boolean }): Promise<void> {
    if (!ttsEnabled()) {
      // Text-only mode still needs the transcript to reach the console.
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    this.speaking = true;
    this.speakingSince = Date.now();

    // Between deciding what to say and saying it: prices become words,
    // references are spelled out, and a fragment carrying a time or a total
    // is delivered slower than the talk around it — because the caller is
    // writing it down. See spoken.ts.
    const spoken = toSpoken(text);

    const voice = {
      voiceId: this.location.agent.voiceId,
      modelId: this.location.agent.voiceModel,
      // A venue's configured pace shifts the whole range rather than
      // overriding it, so "slower for numbers" survives being tuned.
      speed: spoken.speed * ((this.location.agent.voiceSpeed ?? 1.05) / 1.05),
      format: this.transport.output,
      signal: controller.signal,
      previousText: this.spokenThisTurn || undefined,
    };

    try {
      if (opts?.cache) {
        // A line that repeats verbatim every call. Handed over whole rather
        // than streamed — both transports re-frame, and barge-in still works
        // because clearAudio flushes whatever the far end has buffered.
        const audio = await speakClip(spoken.text, { ...voice, previousText: undefined });
        if (gen !== this.generation) return;
        if (audio.length) this.transport.sendAudio(audio);
        return;
      }

      for await (const chunk of speak(spoken.text, voice)) {
        if (gen !== this.generation) return;
        this.transport.sendAudio(chunk);
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        this.transport.sendEvent({
          type: "tts_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (this.abort === controller) this.abort = null;
      if (gen === this.generation) {
        this.speaking = false;
        this.spokenThisTurn = `${this.spokenThisTurn} ${text}`.trim();
      }
    }
  }

  private pushTranscript(role: "caller" | "agent" | "system", text: string): void {
    this.call.transcript.push({ role, text, at: new Date().toISOString() });
  }

  /**
   * The agent's turn arrives as fragments; the transcript wants one entry per
   * turn, so fragments are merged rather than appended one line each.
   */
  private appendAgentTurn(text: string, latencyMs: number): void {
    if (!text.trim()) return;
    this.call.transcript.push({
      role: "agent",
      text,
      at: new Date().toISOString(),
      latencyMs,
    });
  }

  async end(outcome: Call["outcome"], summary?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.dropGuess();
    this.abort?.abort();
    this.stt?.close();

    this.call.status = "completed";
    this.call.endedAt = new Date().toISOString();
    this.call.outcome = this.call.outcome ?? outcome;
    if (summary) this.call.summary = summary;
    saveCall(this.call);

    this.transport.sendEvent({ type: "ended", outcome: this.call.outcome, summary: this.call.summary });
    // Give the last audio frames a moment to drain before hanging up.
    setTimeout(() => this.transport.close(), 600);
  }
}
