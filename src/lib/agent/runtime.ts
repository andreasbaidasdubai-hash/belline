import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { Call, Location, ToolTrace } from "../types";
import { callContext, staticPrompt, type AgentChannel } from "./prompt";
import { executeTool, toolsFor } from "./tools";
import { findAvailability } from "../booking";
import { guestBriefing, recallGuest } from "../guests";
import { usesStaffDiary } from "../verticals";
import { minutesToSpoken, parseClock, todayIn } from "../time";

/**
 * The turn engine.
 *
 * The thing that makes a voice agent feel alive is not the model — it is
 * never waiting for a complete answer before speaking. We stream the reply,
 * cut it at clause boundaries, and hand each fragment to the speech engine
 * the moment it is whole enough to say. First audio leaves roughly a third of
 * a second after the model starts producing text, instead of after the last
 * token of the last sentence.
 */

export type AgentEvent =
  | { type: "sentence"; text: string }
  | { type: "tool"; trace: ToolTrace }
  | { type: "control"; action: "end_call" | "transfer"; detail: string }
  | { type: "turn_end"; text: string; firstAudioMs: number }
  /** A speculative turn reached for a tool that writes. Throw it away. */
  | { type: "abandon" }
  | { type: "error"; message: string };

const MAX_TOOL_ROUNDS = 6;

/**
 * Enough of a turn in progress to put the history right if it is cut short.
 *
 * Barge-in is not an error and does not unwind — it simply stops asking the
 * generator for more. Everything needed to close the conversation honestly
 * afterwards therefore has to live outside it.
 */
interface TurnState {
  /** Every clause handed to the voice this turn. */
  spoken: string;
  /** Tool results gathered in the round currently in flight. */
  results: Anthropic.ToolResultBlockParam[];
  /** The turn ran to its own end; nothing to repair. */
  settled: boolean;
}

/**
 * Tools a guess may run.
 *
 * Both only read. Running check_availability twice costs a lookup; running
 * `book` twice costs a table, and a caller who never asked for it. If a
 * speculative turn reaches for anything outside this set it is thrown away
 * and the real turn starts over.
 */
const READ_ONLY_TOOLS = new Set(["check_availability", "lookup_booking"]);

// ---------------------------------------------------------------------------
// Sentence chunking
// ---------------------------------------------------------------------------

/**
 * Cuts a token stream into speakable fragments.
 *
 * The first fragment is allowed to be short and to break on a comma — getting
 * *something* into the caller's ear fast matters more than prosody on the
 * opening clause. After that we prefer full sentences, which sound better.
 */
export class SentenceChunker {
  private buf = "";
  private emitted = 0;

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut === -1) break;
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (piece) {
        out.push(piece);
        this.emitted++;
      }
    }
    return out;
  }

  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    if (rest) this.emitted++;
    return rest || null;
  }

  private findCut(): number {
    const minLen = this.emitted === 0 ? 12 : 20;
    const commaAt = this.emitted === 0 ? 30 : 90;

    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      const next = this.buf[i + 1] ?? " ";

      if (ch === "\n" && i + 1 >= minLen) return i + 1;

      if (ch === "." || ch === "!" || ch === "?") {
        // "7.30", "2.5" — a digit either side is a number, not a full stop.
        if (ch === "." && /\d/.test(this.buf[i - 1] ?? "") && /\d/.test(next)) continue;
        if (!/[\s"')\]]/.test(next) && next !== "") continue;
        if (i + 1 >= minLen) return i + 1;
      }

      if ((ch === "," || ch === ";" || ch === ":") && i + 1 >= commaAt && /\s/.test(next)) {
        return i + 1;
      }
    }
    return -1;
  }
}

// ---------------------------------------------------------------------------

function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * The exact words the agent opens with.
 *
 * A free function, not just a method, because the server synthesises this at
 * boot to warm the audio cache — and it should not have to invent a call
 * record, which would land in the call log and count against the demo's
 * daily cap, merely to ask what the greeting says.
 */
export function greetingFor(location: Location, callerNumber?: string): string {
  const agent = location.agent;
  const guest = callerNumber ? recallGuest(location, callerNumber) : null;

  // Recognition has to happen in the opening line to land at all. By the time
  // the model could produce it the caller has already started talking.
  const base =
    guest?.name && agent.returningGreeting?.trim()
      ? agent.returningGreeting.replace(/\{name\}/g, guest.name)
      : agent.greeting;

  // On a public demo line the disclosure belongs in the first breath, not
  // somewhere the caller has to ask for it.
  const disclosure = location.demo?.enabled ? location.demo.disclosure.trim() : "";
  return disclosure ? `${disclosure} ${base}` : base;
}

/**
 * Request shape for the chosen model.
 *
 * These parameters are not portable across the family, and getting them wrong
 * is a hard API error rather than a degraded answer: Haiku 4.5 rejects both
 * `output_config.effort` and adaptive thinking, so a venue that picked Haiku
 * for speed would have had an agent that could not answer the phone at all.
 *
 * Latency is the whole point here. A caller waiting three seconds in silence
 * assumes the line is dead, so the frontier models run at the lowest effort
 * that still reasons about which tool to call, and Haiku skips thinking
 * altogether.
 */
function modelParams(model: string): {
  thinking?: Anthropic.ThinkingConfigParam;
  output_config?: { effort: "low" | "medium" | "high" };
} {
  if (model.startsWith("claude-haiku")) {
    // No thinking block, no effort — neither is supported, and Haiku is fast
    // enough without deliberating.
    return {};
  }
  return {
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  };
}

/**
 * Whether to pay for the same model to talk faster.
 *
 * Fast mode runs Opus at up to two and a half times the output rate for a
 * premium on output tokens. On most products that is a poor trade; on a
 * telephone it is close to the only thing money can buy, because a reply is
 * spoken as it is written and the caller is listening to the gap.
 *
 * An answer is forty or fifty tokens, so the premium is fractions of a penny
 * a turn — but it is a live-money setting on a hot path, so it is opt-in and
 * off by default. `npm run bench:model` is how to decide whether it earns its
 * keep for a given venue.
 */
function fastMode(model: string): boolean {
  return (
    process.env.ANTHROPIC_FAST_MODE === "1" &&
    (model.startsWith("claude-opus-5") || model.startsWith("claude-opus-4-8"))
  );
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export interface AgentSessionOptions {
  /** The number the other end is reachable on, when we have it. */
  callerNumber?: string;
  /**
   * Spoken or written.
   *
   * Changes two blocks of the system prompt and which control tools exist —
   * see prompt.ts. Everything else about the turn is identical, which is the
   * whole argument: one receptionist, reachable two ways, not two products.
   */
  channel?: AgentChannel;
  /**
   * A conversation already in progress.
   *
   * A phone call lives and dies inside one process, so its history can stay in
   * memory. A message thread cannot: the customer replies twenty minutes later,
   * possibly to a different container, and the turn has to resume from what was
   * written down. Passing it here is how it resumes.
   */
  history?: Anthropic.MessageParam[];
}

export class AgentSession {
  readonly location: Location;
  readonly call: Call;
  readonly channel: AgentChannel;
  private readonly callerNumber?: string;
  private messages: Anthropic.MessageParam[] = [];
  private readonly tools: Anthropic.Tool[];
  private ended = false;
  /** A successful speculation waiting to be adopted, or discarded. */
  private pendingAdopt: { userText: string; messages: Anthropic.MessageParam[] } | null = null;
  /** What was actually said on pickup — the model must not repeat it. */
  private spokenGreeting: string | null = null;

  constructor(location: Location, call: Call, opts: AgentSessionOptions = {}) {
    this.location = location;
    this.call = call;
    this.callerNumber = opts.callerNumber;
    this.channel = opts.channel ?? "voice";
    this.messages = opts.history ? [...opts.history] : [];
    this.tools = toolsFor(location, this.channel);
  }

  /**
   * The conversation so far, to be written down.
   *
   * Returned by value: a caller persisting this must not be handed the array
   * the next turn is about to push onto. Thinking blocks are in here verbatim
   * and have to be — the API rejects a history that drops them — which is also
   * why this is opaque JSON to everything above rather than a shape anybody
   * should be tempted to edit.
   */
  history(): Anthropic.MessageParam[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /**
   * The opening line, spoken before the model is ever called. Saves the
   * caller a second of silence on pickup, which is the single most noticeable
   * second in the whole call.
   */
  greeting(): string {
    this.spokenGreeting = greetingFor(this.location, this.callerNumber);
    return this.spokenGreeting;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Run a turn on a guess, changing nothing.
   *
   * Everything is local: a copy of the history, no writes to the call record,
   * and read-only tools. Yields the same events as a real turn so the caller
   * can buffer them, plus `abandon` when the guess turns out to need a tool
   * that writes.
   *
   * `adopt()` is what makes the work count if the guess was right.
   */
  private async *speculate(userText: string): AsyncGenerator<AgentEvent> {
    if (!hasApiKey()) return;

    const messages: Anthropic.MessageParam[] = [
      ...this.messages,
      { role: "user", content: userText },
    ];

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const chunker = new SentenceChunker();
        const stream = this.open(messages);

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            for (const sentence of chunker.push(event.delta.text)) {
              yield { type: "sentence", text: sentence };
            }
          }
        }
        const tail = chunker.flush();
        if (tail) yield { type: "sentence", text: tail };

        const message = await stream.finalMessage();
        if (message.stop_reason === "refusal") return;

        messages.push({ role: "assistant", content: message.content });
        if (message.stop_reason !== "tool_use") break;

        const toolUses = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        // The line this whole mechanism turns on.
        if (toolUses.some((use) => !READ_ONLY_TOOLS.has(use.name))) {
          yield { type: "abandon" };
          return;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const outcome = await executeTool(
            use.name,
            use.input as Record<string, unknown>,
            { location: this.location, call: this.call, callerNumber: this.callerNumber },
          );
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify(outcome.result),
          });
        }
        messages.push({ role: "user", content: results });
      }

      // Handed over only on success, so a speculation that threw or was
      // abandoned cannot be adopted by mistake.
      this.pendingAdopt = { userText, messages };
    } catch {
      // A failed guess is not an error the caller should ever learn about.
      this.pendingAdopt = null;
    }
  }

  /**
   * Take a successful speculation as the real turn.
   *
   * Only valid for the exact text that was speculated on: adopting a history
   * built from a different sentence would leave the model believing the
   * caller said something they did not.
   */
  adopt(userText: string): boolean {
    if (!this.pendingAdopt || this.pendingAdopt.userText !== userText) return false;
    this.messages = this.pendingAdopt.messages;
    this.pendingAdopt = null;
    return true;
  }

  discardSpeculation(): void {
    this.pendingAdopt = null;
  }


  /**
   * One request to the model, streamed.
   *
   * Shared by the real turn and the speculative one so the two cannot drift:
   * a guess answered under different parameters than the turn that adopts it
   * is a guess that will keep being thrown away for reasons nobody can see.
   */
  private open(messages: Anthropic.MessageParam[]): MessageStream {
    const model = this.location.agent.model;
    const params = {
      model,
      max_tokens: 2048,
      system: this.systemBlocks(),
      tools: this.tools,
      ...modelParams(model),
      messages,
    };

    if (!fastMode(model)) return anthropic().messages.stream(params);

    // Same endpoint and the same wire protocol — `speed` is a request field,
    // not a different API. The cast is only because the beta namespace
    // re-declares the content-block unions under its own names, and every
    // block this code touches is identical in both.
    return anthropic().beta.messages.stream({
      ...params,
      betas: ["fast-mode-2026-02-01"],
      speed: "fast",
    }) as unknown as MessageStream;
  }

  private systemBlocks(): Anthropic.TextBlockParam[] {
    // Guest history goes in the volatile block, after the cache breakpoint —
    // it is different for every caller, so putting it in the cached half
    // would throw the venue's whole prompt out of cache on every call.
    const guest = this.callerNumber
      ? recallGuest(this.location, this.callerNumber)
      : null;

    return [
      {
        type: "text",
        text: staticPrompt(this.location, this.channel),
        // Everything before this point is identical on every turn of every
        // call at this venue, so it is served from cache from turn two on.
        //
        // An hour, not the default five minutes. A venue does not take a call
        // every five minutes, so the default expired between calls and the
        // very first turn of most calls — the one turn where the caller is
        // listening hardest — paid full price and full latency for a prompt
        // that had not changed since yesterday. An hour spans a lunch service.
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "text",
        text: `${callContext(this.location, {
          callerNumber: this.callerNumber,
          channel: this.channel,
        })}

${
          // A telephone has a moment of pickup, and the greeting happens in it
          // before the model is ever called — so the model has to be told not
          // to say hello twice. A message thread has no such moment: the first
          // thing Belline writes *is* the greeting.
          this.channel === "voice"
            ? `You have already greeted the caller with: "${
                this.spokenGreeting ?? this.location.agent.greeting
              }" — do not greet them again.`
            : ""
        }${
          guest ? `\n\n${guestBriefing(this.location, guest)}` : ""
        }`,
      },
    ];
  }

  /**
   * Answer the caller.
   *
   * `speculative` runs the whole turn on a guess — the caller's interim
   * transcript, before they have finished — so the model and the voice are
   * already working during the silence the endpointer is waiting out. The
   * result is held and only released if the guess proves right.
   *
   * A guess must never change anything. In speculative mode the conversation
   * history is a copy, the call record is untouched, and the tools are
   * restricted to the ones that only read. If the model reaches for `book`,
   * `cancel_booking` or anything else that writes, the whole speculation is
   * abandoned and the real turn runs from scratch — half a second of wasted
   * tokens against the possibility of booking a table nobody asked for.
   */
  async *respond(
    userText: string,
    opts: { speculative?: boolean } = {},
  ): AsyncGenerator<AgentEvent> {
    if (opts.speculative) {
      yield* this.speculate(userText);
      return;
    }
    this.messages.push({ role: "user", content: userText });

    if (!hasApiKey()) {
      yield* this.mockRespond(userText);
      return;
    }

    // Barge-in ends a turn by abandoning this generator wherever it happens to
    // be suspended, and a generator abandoned mid-turn leaves the history in a
    // state the next turn cannot recover from. `closeInterruptedTurn` is what
    // makes that survivable, and it can only run from a `finally` — hence the
    // split into two methods rather than one long one.
    const turn: TurnState = { spoken: "", results: [], settled: false };
    try {
      yield* this.runTurn(turn);
    } finally {
      if (!turn.settled) this.closeInterruptedTurn(turn);
    }
  }

  /**
   * Close a turn the caller talked over.
   *
   * Two things go wrong when a turn is abandoned part-way, and both of them
   * outlive the interruption:
   *
   *   The agent forgets it spoke. The assistant message is only written to
   *   the history once the model's stream has finished, so a turn cut off
   *   before then left no trace at all — and an agent that does not know it
   *   just read out three times will happily read them out again.
   *
   *   A tool round is left hanging. If the cut lands between asking for a
   *   tool and writing down what it returned, the history ends on a `tool_use`
   *   with no `tool_result`, which the API rejects outright. Every remaining
   *   turn of that call then fails, and the caller hears the line drop — long
   *   after the interruption that caused it.
   *
   * What is written down is what was handed to the voice, which may be up to
   * one clause more than the caller actually heard. That is the right way to
   * be wrong: believing it said slightly more than it did costs a repeated
   * clause, believing it said nothing costs the whole answer twice.
   */
  private closeInterruptedTurn(turn: TurnState): void {
    const last = this.messages[this.messages.length - 1];

    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const open = last.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (open.length) {
        const done = new Map(turn.results.map((r) => [r.tool_use_id, r]));
        this.messages.push({
          role: "user",
          // Every `tool_use` needs its `tool_result`, in order. The ones that
          // had already run keep their real answer; the rest are told plainly
          // that they never ran, which is true and is something the model can
          // act on if the caller comes back to the same request.
          content: open.map(
            (use) =>
              done.get(use.id) ?? {
                type: "tool_result" as const,
                tool_use_id: use.id,
                content: JSON.stringify({
                  error: "Not run — the caller interrupted. Ask again if you still need this.",
                }),
                is_error: true,
              },
          ),
        });
      }
    }

    if (turn.spoken.trim()) {
      this.messages.push({ role: "assistant", content: turn.spoken.trim() });
    }
  }

  private async *runTurn(turn: TurnState): AsyncGenerator<AgentEvent> {
    const startedAt = Date.now();
    let firstAudioMs = -1;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const chunker = new SentenceChunker();
        const stream = this.open(this.messages);

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            for (const sentence of chunker.push(event.delta.text)) {
              if (firstAudioMs < 0) firstAudioMs = Date.now() - startedAt;
              turn.spoken += (turn.spoken ? " " : "") + sentence;
              yield { type: "sentence", text: sentence };
            }
          }
        }

        const tail = chunker.flush();
        if (tail) {
          if (firstAudioMs < 0) firstAudioMs = Date.now() - startedAt;
          turn.spoken += (turn.spoken ? " " : "") + tail;
          yield { type: "sentence", text: tail };
        }

        const message = await stream.finalMessage();

        if (message.stop_reason === "refusal") {
          yield {
            type: "sentence",
            text: "I'm sorry, I can't help with that one. Let me take a message for the team.",
          };
          break;
        }

        // Thinking blocks must be replayed unchanged, so push the whole
        // content array rather than picking the text out of it.
        this.messages.push({ role: "assistant", content: message.content });

        if (message.stop_reason !== "tool_use") break;

        const toolUses = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        // Held on the turn, not local to the round: if the caller interrupts
        // between a tool returning and its result being written down, the
        // repair needs whatever did come back.
        const results: Anthropic.ToolResultBlockParam[] = (turn.results = []);
        let control: AgentEvent | null = null;

        for (const use of toolUses) {
          const t0 = Date.now();
          let outcome;
          let ok = true;
          try {
            outcome = await executeTool(
              use.name,
              use.input as Record<string, unknown>,
              { location: this.location, call: this.call, callerNumber: this.callerNumber },
            );
          } catch (err) {
            ok = false;
            outcome = {
              result: {
                error: `The system did not respond. Apologise briefly and offer to take a message. (${
                  err instanceof Error ? err.message : String(err)
                })`,
              },
            };
          }

          const trace: ToolTrace = {
            at: new Date().toISOString(),
            name: use.name,
            input: use.input,
            output: outcome.result,
            ms: Date.now() - t0,
            ok,
          };
          this.call.toolCalls.push(trace);
          yield { type: "tool", trace };

          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify(outcome.result),
            is_error: !ok,
          });

          if (outcome.control) {
            control = {
              type: "control",
              action: outcome.control.type === "end_call" ? "end_call" : "transfer",
              detail:
                outcome.control.type === "end_call"
                  ? outcome.control.summary
                  : outcome.control.reason,
            };
          }
        }

        // All results in one user message — splitting them teaches the model
        // to stop making parallel calls.
        this.messages.push({ role: "user", content: results });

        if (control) {
          this.ended = control.action === "end_call" || control.action === "transfer";
          yield control;
          break;
        }
      }
    } catch (err) {
      const message =
        err instanceof Anthropic.RateLimitError
          ? "rate limited"
          : err instanceof Anthropic.APIConnectionError
            ? "cannot reach the model"
            : err instanceof Anthropic.APIError
              ? // Include what the API actually objected to. A bare status
                // code cannot be acted on, and these are usually a bad
                // parameter for the chosen model rather than a transient fault.
                `api error ${err.status}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err);
      console.error(`[agent] ${this.location.name}: ${message}`);
      yield { type: "error", message };
      yield {
        type: "sentence",
        text: "I'm sorry, our system just dropped out. Let me put you through to the team.",
      };
    }

    // The turn reached its own end rather than being cut off, so the history
    // is already whole and needs no repair.
    turn.settled = true;

    if (firstAudioMs >= 0) this.call.latenciesMs.push(firstAudioMs);
    yield {
      type: "turn_end",
      text: turn.spoken,
      firstAudioMs: firstAudioMs < 0 ? 0 : firstAudioMs,
    };
  }

  /**
   * Keyless fallback. It is not trying to be clever — it exists so the
   * booking engine, the tool trace, the transcript and the dashboard are all
   * exercisable before anyone has signed up for an API key.
   */
  private async *mockRespond(userText: string): AsyncGenerator<AgentEvent> {
    const text = userText.toLowerCase();
    const time = text.match(/\b(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?\b/);
    const parsed = time ? parseClock(time[0].replace(/\s/g, "")) : null;
    const party = Number(text.match(/\b(?:for|party of|table for)\s+(\d+)/)?.[1] ?? 2);
    let reply: string;

    if (parsed !== null) {
      const date = todayIn(this.location.timezone);
      const t0 = Date.now();
      const slots = findAvailability(this.location, {
        locationId: this.location.id,
        date,
        preferredMin: parsed,
        partySize: party,
        serviceIds: usesStaffDiary(this.location)
          ? [this.location.salon?.services[0]?.id ?? ""]
          : undefined,
      });
      const trace: ToolTrace = {
        at: new Date().toISOString(),
        name: "check_availability",
        input: { date, time: parsed, party_size: party },
        output: slots,
        ms: Date.now() - t0,
        ok: true,
      };
      this.call.toolCalls.push(trace);
      yield { type: "tool", trace };
      reply = slots.length
        ? `Running without a model key, so this is the booking engine answering directly. Today I have ${slots
            .slice(0, 3)
            .map((s) => minutesToSpoken(s.startMin))
            .join(", ")}. Set ANTHROPIC_API_KEY to hear the real agent.`
        : "Running without a model key. The booking engine found nothing open at that time today.";
    } else {
      reply =
        "No ANTHROPIC_API_KEY is set, so you are talking to a stub. Ask for a time, like \"table for two at eight\", and the real booking engine will answer.";
    }

    for (const sentence of reply.split(/(?<=\.)\s+/)) {
      yield { type: "sentence", text: sentence };
    }
    yield { type: "turn_end", text: reply, firstAudioMs: 0 };
  }
}
