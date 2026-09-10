import type { Call, Location } from "../types";
import { AgentSession } from "../agent/runtime";
import { createSttStream, type SttStream } from "../providers/stt";
import { speak, ttsEnabled, type TtsFormat } from "../providers/tts";
import { saveCall } from "../store";
import { maxCallSeconds } from "../demo";

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
  private lastSpeechEndedAt = 0;
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
      onPartial: (text) => this.transport.sendEvent({ type: "partial", text }),
      onFinal: (text) => void this.onCallerTurn(text),
      onError: (message) => this.transport.sendEvent({ type: "stt_error", message }),
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
    await this.say(greeting, ++this.generation);
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
    if (!this.speaking && !this.thinking) return;
    // Deepgram fires SpeechStarted on noise too. Only treat it as barge-in
    // once the agent has actually been talking for a moment, otherwise the
    // agent's own first syllable through a speakerphone cuts itself off.
    this.interrupt();
  }

  private interrupt(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.speaking = false;
    this.thinking = false;
    this.transport.clearAudio();
    this.transport.sendEvent({ type: "interrupted" });
  }

  private async onCallerTurn(text: string): Promise<void> {
    if (this.closed || !text.trim()) return;

    // Anything still in flight belongs to the previous turn.
    if (this.speaking || this.thinking) this.interrupt();

    const gen = ++this.generation;
    this.pushTranscript("caller", text);
    this.transport.sendEvent({ type: "transcript", role: "caller", text });
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

  /** Speak one fragment, abortable, dropping output from a stale generation. */
  private async say(text: string, gen: number): Promise<void> {
    if (!ttsEnabled()) {
      // Text-only mode still needs the transcript to reach the console.
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    this.speaking = true;
    try {
      for await (const chunk of speak(text, {
        voiceId: this.location.agent.voiceId,
        format: this.transport.output,
        signal: controller.signal,
      })) {
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
        this.lastSpeechEndedAt = Date.now();
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
