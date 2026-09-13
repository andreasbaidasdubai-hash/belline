import type { Call, DateStr, Location, ToolTrace } from "../types";
import { AgentSession } from "../agent/runtime";
import { createSttStream, type SttStream } from "../providers/stt";
import { speak, speakClip, ttsEnabled, type TtsFormat } from "../providers/tts";
import { saveCall } from "../store";
import { maxCallSeconds } from "../demo";
import { speechKeyterms } from "../verticals";
import { assessAuthority, type Assessment } from "../agent/authority";
import { toSpoken } from "./spoken";
import { isBackchannel, invitesAnswer } from "./backchannel";
import { findAvailability } from "../booking";
import { releaseCall } from "../booking/holds";
import { todayIn, minutesToClock, minutesToSpoken } from "../time";

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
 * How long to let voice activity stand before believing it, when no words
 * have arrived to explain it.
 *
 * Voice activity says *something* made a noise; it does not say whether that
 * noise was a caller taking the floor or a caller saying "mm-hmm" while they
 * listen. The transcript answers that, and it arrives a moment later. So the
 * agent keeps talking for this long, and cuts off either when the words prove
 * it is a real interruption or when they never come at all.
 *
 * Cutting a fifth of a second late is not perceptible — a person takes about
 * as long to stop. Cutting on every "yeah" is very perceptible indeed.
 */
const BARGE_IN_CONFIRM_MS = 220;

/**
 * How settled an interim transcript must be before it is worth guessing on.
 *
 * Too eager and every syllable starts a turn that is immediately thrown away;
 * too patient and the endpointer fires first and the work was pointless. A
 * caller who has stopped producing new words for this long has almost always
 * finished, which is the same judgement the endpointer is making — only this
 * one is free to be wrong.
 */
export const GUESS_AFTER_MS = 140;

/** Below this a transcript is a filler word, not a turn. */
const GUESS_MIN_CHARS = 10;

interface Guess {
  /** The interim transcript this was built from. */
  text: string;
  /** Fragments, already synthesised, waiting to be released. */
  ready: { text: string; audio: Buffer }[];
  /** The run has stopped producing — finished, handed over, or failed. */
  finished: boolean;
  /** It failed. What is in `ready` was said correctly; nothing after it exists. */
  dead: boolean;
  /**
   * The model asked for a tool that writes, which a guess may not run. The
   * words it produced first are in `ready`; the real turn continues from the
   * tool call, without saying them again.
   */
  handoff: boolean;
  /** Resolves the next time a fragment is ready or the run stops. */
  changed: () => Promise<void>;
  abort: AbortController;
}

/**
 * A promise that resolves when poked, then arms itself again.
 *
 * The consumer of a guess waits on this between fragments rather than on the
 * whole run, which is the difference between the caller hearing the first
 * sentence when it is ready and hearing it when the last one is.
 */
function signal(): { wait: () => Promise<void>; fire: () => void } {
  let resolve: () => void = () => {};
  let pending = new Promise<void>((r) => (resolve = r));
  return {
    wait: () => pending,
    fire: () => {
      const done = resolve;
      pending = new Promise<void>((r) => (resolve = r));
      done();
    },
  };
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
  /**
   * Whether the caller can see anything.
   *
   * A browser can be shown the times as well as told them, which removes the
   * worst moment in booking by voice — holding four of them in your head
   * while deciding. A telephone cannot, and must never be sent them.
   */
  screen?: boolean;
  sendAudio(chunk: Buffer): void;
  /** Structured events for the browser console; a no-op for telephony. */
  sendEvent(event: Record<string, unknown>): void;
  /** Drop whatever is buffered at the far end — used for barge-in. */
  clearAudio(): void;
  close(): void;
  /** Whether this transport can put the caller through to a person. Telephone only. */
  readonly canTransfer?: boolean;
  transfer?(to: string): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Exactly what the text-to-speech vendor is asked for.
 *
 * Shared with the boot-time greeting warm-up in server.ts, and that is the
 * whole point of it existing. The clip cache is keyed on the text *and* the
 * speed, and the warm-up used to build both itself: it cached the raw
 * greeting at the venue's configured pace, while `say` asks for the
 * `toSpoken` rewrite at a pace derived from it. The two never matched, so the
 * greeting was re-rendered on every single call while the logs happily
 * reported it warmed.
 */
export function voiceParams(
  location: Location,
  spoken: { text: string; speed: number },
  format: TtsFormat,
) {
  return {
    text: spoken.text,
    voiceId: location.agent.voiceId,
    modelId: location.agent.voiceModel,
    // A venue's configured pace shifts the whole range rather than overriding
    // it, so "slower for numbers" survives being tuned.
    speed: spoken.speed * ((location.agent.voiceSpeed ?? 1.05) / 1.05),
    format,
  };
}

/**
 * The greeting clip, in the form the first call will ask for it.
 *
 * `cache: true` on the greeting means `say` hands it over whole from the clip
 * cache — but only if the key matches to the character and the decimal.
 */
export function greetingClip(location: Location, greeting: string, format: TtsFormat) {
  return voiceParams(location, toSpoken(greeting), format);
}

/**
 * What Belline says the instant a caller finishes, while the answer is still
 * being worked out.
 *
 * The model's first clause takes the better part of a second to arrive and
 * the voice a third of one more, and nothing about either is going to get
 * much faster. What a person does with that second is not sit in silence:
 * they say "sure" or "let me see", and the silence that follows is a person
 * thinking rather than a line that has gone dead. Each of these is a cached
 * clip, so it costs nothing at the time, and each is a bare acknowledgement
 * rather than a promise — "Sure." commits to nothing, and reads correctly in
 * front of a yes, a no, and a question back.
 *
 * Rotated rather than random so the same caller does not hear the same one
 * three turns running, and never on a turn that already has audio to play.
 */
export const ACKNOWLEDGEMENTS = ["Sure.", "Okay.", "Right.", "Let me see."] as const;

/**
 * How long a turn may be silent before an acknowledgement is said.
 *
 * Long enough that a guess with its first fragment already waiting is not
 * pre-empted, short enough that the caller is never left wondering. A person
 * takes about this long to say "sure" after a question.
 */
const ACKNOWLEDGE_AFTER_MS = 250;

/** The acknowledgement clips, as the session will ask for them — for warming. */
export function acknowledgementClips(location: Location, format: TtsFormat) {
  return ACKNOWLEDGEMENTS.map((line) => voiceParams(location, toSpoken(line), format));
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
   * and the audio is held until the endpointer agrees — then released a
   * fragment at a time, as each one is ready.
   *
   * It used to be released only once the *whole* run had finished: every
   * sentence generated, every sentence synthesised. A right guess — the
   * common case — therefore made the caller wait for the end of the answer
   * before hearing the start of it, which on a three-sentence reply was two
   * to three seconds of silence that the cold path would not have had.
   */
  private guess: Guess | null = null;
  private guessTimer: NodeJS.Timeout | null = null;
  /**
   * A noise made over the agent that has not yet been judged.
   *
   * Non-zero from the moment voice activity is detected until the turn is
   * either interrupted or finished, so that a caller who opens with "yeah"
   * and carries on into "yeah, actually, can you make it seven" is judged
   * again on every revision of the transcript rather than only on the first.
   */
  private bargeInAt = 0;
  private bargeInTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private timeout: NodeJS.Timeout | null = null;
  /** Fires if the turn has produced no audio soon enough — see ACKNOWLEDGEMENTS. */
  private ackTimer: NodeJS.Timeout | null = null;
  /** The acknowledgement said this turn, if one was, for the transcript. */
  private ackSaid = "";
  /** Whether any of the answer proper has reached the caller this turn. */
  private answered = false;
  /** Caller turns so far, to rotate the acknowledgements. */
  private turns = 0;

  constructor(
    location: Location,
    call: Call,
    transport: Transport,
    callerNumber?: string,
  ) {
    this.location = location;
    this.call = call;
    this.transport = transport;
    this.agent = new AgentSession(location, call, {
      callerNumber,
      channel: "voice",
      liveTransfer: Boolean(transport.canTransfer && transport.transfer && location.agent.transferNumber?.trim()),
    });
  }

  private get liveTransfer(): boolean {
    return Boolean(
      this.transport.canTransfer && this.transport.transfer && this.location.agent.transferNumber?.trim(),
    );
  }

  async start(): Promise<void> {
    this.stt = createSttStream({
      encoding: this.transport.input.encoding,
      sampleRate: this.transport.input.sampleRate,
      onSpeechStart: () => this.onSpeechStart(),
      onPartial: (text) => {
        this.transport.sendEvent({ type: "partial", text });
        this.considerGuess(text);
        this.considerBargeIn(text);
      },
      onFinal: (text) => void this.onCallerTurn(text),
      // Flux only. The recogniser has decided the sentence sounds finished,
      // which is a better reason to start answering than the transcript
      // having gone quiet for a tenth of a second — and it arrives earlier.
      onEagerEnd: (text) => this.startGuess(text),
      onTurnResumed: () => this.dropGuess(),
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
      maxCallSeconds(this.location, this.call.channel) * 1000,
    );

    const greeting = this.agent.greeting();
    this.pushTranscript("agent", greeting);
    this.transport.sendEvent({ type: "transcript", role: "agent", text: greeting });
    // Before the greeting has finished playing, not after: the point is that
    // the times are already there while Belline is still talking.
    this.openingTimes();

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

    // Not an interruption yet — a candidate for one. Voice activity alone
    // cannot tell a caller taking the floor from a caller saying "mm-hmm",
    // and the transcript that can is a fraction of a second behind. Keep
    // talking until either the words settle it or they fail to arrive.
    if (this.bargeInAt) return;
    this.bargeInAt = Date.now();
    this.bargeInTimer = setTimeout(() => {
      this.bargeInTimer = null;
      // Noise, with no words to explain it, for long enough that talking over
      // it is the bigger risk. Stop.
      if (this.speaking) this.interrupt();
    }, BARGE_IN_CONFIRM_MS);
  }

  /**
   * Judge a noise made over the agent, now that there are words for it.
   *
   * Runs on every revision of the interim transcript, so an utterance that
   * starts as agreement and turns into an interruption is caught the moment
   * it turns.
   */
  private considerBargeIn(text: string): void {
    if (!this.speaking || !this.bargeInAt) return;

    // Listening noise. Carry on talking — but leave the judgement open, in
    // case this is the opening word of a real sentence.
    //
    // Unless a question has just been put to them, in which case even a bare
    // "yes" is an answer, and ignoring it would leave both sides waiting.
    if (isBackchannel(text) && !invitesAnswer(this.spokenThisTurn)) {
      if (this.bargeInTimer) {
        clearTimeout(this.bargeInTimer);
        this.bargeInTimer = null;
      }
      return;
    }

    this.interrupt();
  }

  private clearBargeIn(): void {
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.bargeInTimer = null;
    this.bargeInAt = 0;
  }

  /**
   * Start preparing an answer while the caller is still being listened to.
   *
   * Debounced on the transcript settling rather than on a timer from the last
   * word, because a caller mid-sentence produces new text continuously and
   * each new word should cancel the guess built on the old one.
   */
  private considerGuess(partial: string): void {
    // When the recogniser will tell us itself, stop second-guessing it. Flux
    // fires `EagerEndOfTurn` on the shape of the sentence; this timer fires on
    // the transcript going quiet, and running both means two guesses racing
    // over the same words.
    if (this.stt?.predictsTurnEnd) return;

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

    // Reached directly from the recogniser as well as from the timer, and the
    // recogniser may revise itself. Never leave a previous guess running: it
    // holds a model stream and a synthesis, and both cost money to ignore.
    if (this.guess) {
      if (sameUtterance(this.guess.text, text)) return;
      this.dropGuess();
    }

    const abort = new AbortController();
    const tick = signal();
    const guess: Guess = {
      text,
      ready: [],
      finished: false,
      dead: false,
      handoff: false,
      changed: tick.wait,
      abort,
    };
    this.guess = guess;

    void (async () => {
      try {
        for await (const event of this.agent.respond(text, { speculative: true })) {
          if (abort.signal.aborted) return;
          if (event.type === "abandon") {
            guess.handoff = true;
            return;
          }
          if (event.type === "error") {
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
          tick.fire();
        }
      } catch {
        guess.dead = true;
      } finally {
        guess.finished = true;
        tick.fire();
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
   * The caller must have said what we guessed — to the word, ignoring
   * punctuation — or the real turn runs from scratch. Given that, whatever
   * the guess has ready goes into the caller's ear now, and each further
   * fragment follows the moment it is synthesised, while the run is still
   * going.
   *
   * Three ways it ends. It finishes, and the history is adopted whole. It
   * reached for a tool that writes and stopped there: the history is adopted
   * up to that point and the caller returns false so the real turn *continues*
   * it — runs the tool, lets the model carry on — rather than starting over
   * and saying the opening twice. Or it failed: what was already said is
   * written down as said, and the turn ends there.
   */
  private async useGuess(text: string, gen: number): Promise<boolean> {
    const guess = this.guess;
    if (!guess || !sameUtterance(guess.text, text)) {
      this.dropGuess();
      return false;
    }

    // Ours from here. Detached from `this.guess` so a later dropGuess() does
    // not abort it, and attached to `this.abort` so an interruption does.
    this.guess = null;
    if (this.guessTimer) {
      clearTimeout(this.guessTimer);
      this.guessTimer = null;
    }
    this.abort = guess.abort;

    let released = 0;
    for (;;) {
      while (released < guess.ready.length) {
        if (gen !== this.generation) return true;
        const fragment = guess.ready[released++];
        this.answering();
        this.transport.sendEvent({ type: "transcript", role: "agent", text: fragment.text });
        if (!this.speaking) this.speakingSince = Date.now();
        this.speaking = true;
        this.transport.sendAudio(fragment.audio);
        this.spokenThisTurn = `${this.spokenThisTurn} ${fragment.text}`.trim();
      }
      if (guess.finished) break;
      await guess.changed();
      if (gen !== this.generation) return true;
    }
    if (this.abort === guess.abort) this.abort = null;
    this.speaking = false;

    const said = guess.ready.map((f) => f.text).join(" ");

    if (guess.dead || (!guess.handoff && !this.agent.adopt(guess.text))) {
      this.agent.discardSpeculation();
      // Nothing reached the caller, so nothing is lost by starting over.
      if (released === 0) return false;
      // Something did, and then the run broke. The half they heard is
      // recorded as said; the next thing they say gets a fresh turn.
      this.agent.recordUnfinished(text, said);
      this.appendAgentTurn(said, 0);
      this.transport.sendEvent({ type: "turn_end", latencyMs: 0 });
      saveCall(this.call);
      return true;
    }

    if (guess.handoff) {
      // The opening has been said. The real turn takes the history from here
      // and runs the tool the guess was not allowed to.
      if (!this.agent.adopt(guess.text)) {
        this.agent.recordUnfinished(text, said);
        this.appendAgentTurn(said, 0);
        this.transport.sendEvent({ type: "turn_end", latencyMs: 0 });
        saveCall(this.call);
        return true;
      }
      return false;
    }

    this.appendAgentTurn(said, 0);
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
    // Write down the part the caller actually heard before cutting in. The
    // turn is abandoned, not undone — it was said, it is on the recording,
    // and a transcript that skips it reads as though Belline sat silent
    // while the caller talked over nothing.
    this.cancelAcknowledgement();
    // `spokenThisTurn` already carries the acknowledgement, if there was one.
    this.ackSaid = "";
    if (this.spokenThisTurn.trim()) this.appendAgentTurn(this.spokenThisTurn.trim(), 0);
    this.spokenThisTurn = "";
    this.clearBargeIn();
    this.dropGuess();
    this.transport.clearAudio();
    this.transport.sendEvent({ type: "interrupted" });
  }

  private async onCallerTurn(text: string): Promise<void> {
    if (this.closed || !text.trim()) return;

    // "Mm-hmm" over the top of an answer is not a turn, and treating it as
    // one is worse than ignoring it twice over: the sentence gets cut off,
    // and then the agent has to find something to say about "mm-hmm".
    //
    // The endpointer will deliver it as a finished utterance all the same,
    // which is why this guard is here as well as on the barge-in path — the
    // two arrive by different routes and either one alone leaves a hole.
    if (
      (this.speaking || this.thinking) &&
      isBackchannel(text) &&
      !invitesAnswer(this.spokenThisTurn)
    ) {
      this.pushTranscript("caller", text);
      this.transport.sendEvent({ type: "transcript", role: "caller", text });
      return;
    }

    // Anything still in flight belongs to the previous turn.
    if (this.speaking || this.thinking) this.interrupt();
    this.clearBargeIn();

    const gen = ++this.generation;
    // A new answer starts a new contour — the previous turn's words would
    // condition this one toward a cadence that no longer fits.
    this.spokenThisTurn = "";
    this.answered = false;
    this.ackSaid = "";
    this.turns++;
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

    // From here the caller is waiting. If nothing has reached them shortly,
    // Belline says so out loud rather than leaving the line silent.
    this.armAcknowledgement(gen);

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
            this.offerSlots(event.trace);
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

    // "Putting you through" only where somebody can actually be put through.
    const said =
      rule.then === "transfer" && !this.liveTransfer && rule.sayIfNoTransfer ? rule.sayIfNoTransfer : rule.say;

    this.pushTranscript("agent", said);
    this.transport.sendEvent({ type: "transcript", role: "agent", text: said });
    this.transport.sendEvent({ type: "escalated", ruleId: rule.id, reason: rule.reason });

    await this.say(said, gen);
    if (gen !== this.generation) return;

    if (rule.then === "end_call") {
      await this.end("escalated", rule.reason);
      return;
    }
    await this.end(rule.then === "transfer" ? "transferred" : "message_taken", rule.reason);
  }

  /**
   * Put the times on screen, when the caller has a screen.
   *
   * The worst moment in booking by voice is being read four times and having
   * to hold them in your head while deciding. On a phone line there is no
   * answer to that — the agent reads them and that is the medium. In a browser
   * there is a screen going spare, so the same times it is about to say are
   * also shown, and tapping one is faster than saying it.
   *
   * Derived from the tool's own result rather than sent separately, so the
   * page cannot show a time the engine did not actually offer. Availability
   * has exactly one source and this is not a second one.
   */
  /**
   * Put times on screen before anybody has asked for them.
   *
   * The agent will get to availability in its own time — often three or four
   * turns in, after a name. That is correct for a phone call and wasteful on
   * a screen, where the next few openings can simply be sitting there while
   * the greeting plays. Somebody who already knows when they want to come can
   * tap one and skip the conversation entirely.
   *
   * Never on the telephone, where there is nothing to look at. Never fatal:
   * a venue with no bookable services, or a diary that throws, costs the
   * caller nothing here — they still have the conversation.
   */
  private openingTimes(): void {
    if (!this.transport.screen) return;
    const serviceIds = this.location.salon?.services.map((s) => s.id);
    if (!serviceIds?.length) return;

    try {
      // The first service only. Offering every service's openings at once on a
      // venue with eight of them is a wall, not a help.
      const days = this.openDays(todayIn(this.location.timezone), [serviceIds[0]]);
      if (days.length) this.transport.sendEvent({ type: "slots", days });
    } catch {
      // A diary that cannot be read is the conversation's problem, not the
      // opening screen's.
    }
  }

  /**
   * The next few days that actually have something free.
   *
   * Not the next few days — the next few *open* ones. A salon closed on Sunday
   * and Monday would otherwise spend two of five columns saying nothing, which
   * is how a picker teaches somebody that it is not worth looking at.
   *
   * Bounded twice: at most five days shown, and at most three weeks walked. A
   * venue with nothing free for a month should return a short list and let the
   * conversation handle it, not spin through a year of empty diary.
   */
  private openDays(
    from: DateStr,
    serviceIds: string[],
    staffId?: string,
  ): { date: DateStr; options: { time: string; spoken: string; with?: string }[] }[] {
    const days: { date: DateStr; options: { time: string; spoken: string; with?: string }[] }[] = [];

    for (let i = 0; i < 21 && days.length < 5; i++) {
      const day = new Date(`${from}T12:00:00Z`);
      day.setUTCDate(day.getUTCDate() + i);
      const date = day.toISOString().slice(0, 10);

      const slots = findAvailability(this.location, {
        locationId: this.location.id,
        date,
        serviceIds,
        ...(staffId ? { staffId } : {}),
      });
      if (!slots.length) continue;

      days.push({
        date,
        // Capped per day: a day with fifty free slots is a scroll nobody
        // reads, and the agent is only going to speak two or three anyway.
        options: slots.slice(0, 18).map((s) => ({
          time: minutesToClock(s.startMin),
          spoken: minutesToSpoken(s.startMin),
          ...(s.staffName ? { with: s.staffName } : {}),
        })),
      });
    }

    return days;
  }

  /**
   * Put the diary on screen behind what the agent just said.
   *
   * The tool answers one question — is this day free — because that is the
   * question a caller asks out loud. A screen can answer a better one: here is
   * that day, and here are the next few, choose. So the day the agent checked
   * leads, and the days after it are filled in beside it.
   *
   * Cheap enough to do inline: the diary is a local file and this is the same
   * search the tool just ran, a handful more times, while the agent is still
   * speaking its first sentence.
   */
  private offerSlots(trace: ToolTrace): void {
    if (trace.name !== "check_availability") return;
    const result = trace.output as
      | { available?: boolean; date?: string; options?: { time: string; spoken: string; with?: string }[] }
      | undefined;
    if (!result?.available || !result.date || !result.options?.length) return;
    if (!this.transport.screen) return;

    const asked = {
      date: result.date,
      // Capped: a day with fifty free slots is a scroll nobody reads.
      options: result.options.slice(0, 18),
    };

    let days = [asked];
    try {
      const input = trace.input as { service_ids?: string[]; staff_id?: string } | undefined;
      const serviceIds = input?.service_ids?.length
        ? input.service_ids
        : this.location.salon?.services.slice(0, 1).map((s) => s.id);

      if (serviceIds?.length) {
        const after = new Date(`${result.date}T12:00:00Z`);
        after.setUTCDate(after.getUTCDate() + 1);
        days = [
          asked,
          ...this.openDays(after.toISOString().slice(0, 10), serviceIds, input?.staff_id).slice(0, 4),
        ];
      }
    } catch {
      // The day the agent named is the one that matters. Failing to find the
      // ones after it costs a column, not the call.
    }

    this.transport.sendEvent({ type: "slots", days });
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
      ...voiceParams(this.location, spoken, this.transport.output),
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
        this.answering();
        if (audio.length) this.transport.sendAudio(audio);
        return;
      }

      for await (const chunk of speak(spoken.text, voice)) {
        if (gen !== this.generation) return;
        this.answering();
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
    // The acknowledgement was heard, so it is written down — once, in front
    // of whichever part of the answer follows it.
    const said = this.ackSaid ? `${this.ackSaid} ${text}`.trim() : text;
    this.ackSaid = "";
    if (!said.trim()) return;
    this.call.transcript.push({
      role: "agent",
      text: said,
      at: new Date().toISOString(),
      latencyMs,
    });
  }

  // --- acknowledging -------------------------------------------------------

  /** Say something soon, unless the answer gets there first. */
  private armAcknowledgement(gen: number): void {
    this.cancelAcknowledgement();
    if (!ttsEnabled()) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      void this.acknowledge(gen);
    }, ACKNOWLEDGE_AFTER_MS);
  }

  private cancelAcknowledgement(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  /** The answer proper has started; an acknowledgement would now be in its way. */
  private answering(): void {
    this.answered = true;
    this.cancelAcknowledgement();
  }

  private async acknowledge(gen: number): Promise<void> {
    if (gen !== this.generation || this.answered || this.closed) return;
    const line = ACKNOWLEDGEMENTS[this.turns % ACKNOWLEDGEMENTS.length];
    const spoken = toSpoken(line);
    let audio: Buffer;
    try {
      audio = await speakClip(spoken.text, voiceParams(this.location, spoken, this.transport.output));
    } catch {
      // A missing acknowledgement is silence, which is what there was before.
      return;
    }
    // The clip may have been cold and taken a moment; if the answer arrived
    // in the meantime, or the caller spoke, it is too late to say "sure".
    if (gen !== this.generation || this.answered || this.closed || !audio.length) return;
    this.ackSaid = line;
    this.spokenThisTurn = line;
    this.transport.sendEvent({ type: "transcript", role: "agent", text: line });
    this.transport.sendAudio(audio);
  }

  async end(outcome: Call["outcome"], summary?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.cancelAcknowledgement();
    this.dropGuess();
    this.abort?.abort();
    this.stt?.close();

    // Whatever this call was holding goes back on the market now, however the
    // call ended. A dropped line that keeps its last quoted table until the
    // timer runs out costs the venue exactly the bookings it is busiest taking.
    releaseCall(this.call.id);

    this.call.status = "completed";
    this.call.endedAt = new Date().toISOString();
    this.call.outcome = this.call.outcome ?? outcome;
    if (summary) this.call.summary = summary;
    saveCall(this.call);

    this.transport.sendEvent({ type: "ended", outcome: this.call.outcome, summary: this.call.summary });

    // Put them through. The call is redirected before the socket closes, so
    // Twilio dials the team instead of hanging up when the stream ends. A
    // short pause first: "putting you through now" is still playing, and a
    // redirect cuts it off mid-word.
    if (this.call.outcome === "transferred" && this.liveTransfer) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const to = this.location.agent.transferNumber!.trim();
      const result = await this.transport.transfer!(to);
      this.call.transfer = { to, at: new Date().toISOString(), ok: result.ok, detail: result.detail };
      saveCall(this.call);
      if (!result.ok) {
        console.warn("[transfer] failed for %s: %s", this.call.id, result.detail);
        // Never a silent hang-up after "putting you through".
        const sorry =
          "I'm sorry, I couldn't put you through just now. The team has your number and what you told me, and they'll call you back.";
        this.pushTranscript("agent", sorry);
        saveCall(this.call);
        await this.say(sorry, this.generation).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }

    // Give the last audio frames a moment to drain before hanging up.
    setTimeout(() => this.transport.close(), 600);
  }
}
