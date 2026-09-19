/**
 * The video panel's behaviour, without the DOM.
 *
 * Everything the panel decides — what state it is in, what a Tavus event
 * means, when to warn and when to end, whether a second click starts a second
 * session — lives here as plain functions, so `check:video` can pin it without
 * a browser and the component is left with rendering and wiring.
 *
 * Nothing server-side is imported: this file is bundled into the visitor's
 * panel. `end-reason.ts` is import-free for the same reason and is the one
 * thing pulled in, so the words said about an ended call live in one place
 * whichever surface is showing them.
 */

import type { VideoEndCause } from "../end-reason";

export type VideoErrorCode =
  | "mic_denied"
  | "mic_missing"
  | "mic_unsupported"
  | "unavailable"
  /** Every room that may be open is open — ours or the provider's limit. */
  | "busy"
  /** No more video calls today. Not the same thing as busy, and not worth waiting for. */
  | "no_calls_today"
  | "failed"
  | "network"
  | "expired";

export type Phase = "intro" | "mic" | "connecting" | "live" | "ended" | "error";

/**
 * How often an open panel tells the server it is still there.
 *
 * Here rather than in `sessions.ts` because the panel is the one that has to
 * obey it and cannot import a server module; the server reads it from here, so
 * the two halves of the deal are one number. The server lets go of a session it
 * has not heard from for `VIDEO_STALE_AFTER_SECONDS` — three of these — which
 * is what stops a closed tab holding a concurrency slot for minutes.
 */
export const VIDEO_HEARTBEAT_SECONDS = 15;

export interface PanelState {
  phase: Phase;
  error?: VideoErrorCode;
  retryable?: boolean;
  /** Epoch ms when the room was joined. The duration counts from here. */
  joinedAt?: number;
  agentSpeaking: boolean;
  visitorSpeaking: boolean;
  muted: boolean;
  reconnecting: boolean;
  warned: boolean;
  captions: { agent: string; visitor: string };
  /** Whose words changed last: the one line under the circle shows theirs. */
  captionLast?: "agent" | "visitor";
  endedReason?: string;
  /**
   * Why it ended, as the server classified it — the only thing the end copy is
   * allowed to branch on. Absent until the end route has answered: the browser
   * cannot tell our ceiling from the provider's from a room that vanished.
   */
  endedCause?: VideoEndCause;
  /** How long the call actually ran, as the server counted it. */
  endedSeconds?: number;
  /** The browser refused to play the face's voice without another tap (iOS). */
  audioBlocked?: boolean;
}

export const INITIAL: PanelState = {
  phase: "intro",
  agentSpeaking: false,
  visitorSpeaking: false,
  muted: false,
  reconnecting: false,
  warned: false,
  captions: { agent: "", visitor: "" },
};

/** What the call adapter (Daily, or the mock) reports. */
export type CallEvent =
  | { type: "joined" }
  | { type: "speaking"; who: "agent" | "visitor"; on: boolean }
  | { type: "caption"; who: "agent" | "visitor"; text: string }
  | { type: "network"; state: "ok" | "reconnecting" }
  | { type: "left"; reason: string }
  | { type: "error"; code: VideoErrorCode }
  | { type: "audio_blocked" };

export type Action =
  | { type: "start" }
  | { type: "mic_granted" }
  | { type: "fail"; code: VideoErrorCode; retryable: boolean }
  | { type: "call"; event: CallEvent; now: number }
  | { type: "mute"; muted: boolean }
  | { type: "warn" }
  | { type: "ended"; reason: string }
  /** The end route's answer, which arrives a moment after the panel has already ended. */
  | { type: "end_cause"; cause: VideoEndCause; seconds: number }
  | { type: "reset" }
  | { type: "audio_unlocked" };

export function reduce(state: PanelState, action: Action): PanelState {
  switch (action.type) {
    case "start":
      // Only from a resting state: a second press while starting is ignored.
      if (state.phase !== "intro" && state.phase !== "ended" && state.phase !== "error") return state;
      return { ...INITIAL, phase: "mic" };
    case "mic_granted":
      return state.phase === "mic" ? { ...state, phase: "connecting" } : state;
    case "fail":
      if (state.phase === "ended") return state;
      return { ...state, phase: "error", error: action.code, retryable: action.retryable, agentSpeaking: false, visitorSpeaking: false };
    case "mute":
      return { ...state, muted: action.muted };
    case "warn":
      return state.phase === "live" ? { ...state, warned: true } : state;
    case "ended":
      if (state.phase === "error") return state;
      return { ...state, phase: "ended", endedReason: action.reason, agentSpeaking: false, visitorSpeaking: false, reconnecting: false };
    case "end_cause":
      // Only ever sharpens an end that has already happened. A late answer
      // must not resurrect a panel the visitor has since restarted.
      if (state.phase !== "ended") return state;
      return { ...state, endedCause: action.cause, endedSeconds: action.seconds };
    case "reset":
      return INITIAL;
    case "audio_unlocked":
      return { ...state, audioBlocked: false };
    case "call":
      return onCall(state, action.event, action.now);
  }
}

function onCall(state: PanelState, event: CallEvent, now: number): PanelState {
  if (state.phase === "ended" || state.phase === "error") return state;
  switch (event.type) {
    case "joined":
      return { ...state, phase: "live", joinedAt: state.joinedAt ?? now };
    case "speaking":
      return event.who === "agent" ? { ...state, agentSpeaking: event.on } : { ...state, visitorSpeaking: event.on };
    case "caption":
      return { ...state, captions: { ...state.captions, [event.who]: event.text.slice(-400) }, captionLast: event.who };
    case "network":
      return { ...state, reconnecting: event.state === "reconnecting" };
    case "left":
      return { ...state, phase: "ended", endedReason: event.reason, agentSpeaking: false, visitorSpeaking: false, reconnecting: false };
    case "error":
      return { ...state, phase: "error", error: event.code, retryable: event.code === "network" || event.code === "failed" };
    case "audio_blocked":
      return { ...state, audioBlocked: true };
  }
}

/** What went wrong, for the visitor: what happened and what they can do next. */
export function errorCopy(code: VideoErrorCode, agent: string): string {
  switch (code) {
    case "mic_denied":
      return `Your microphone is blocked, so ${agent} can't hear you. To talk, allow the microphone for this site — usually the icon beside the address bar — then try again. Or chat instead.`;
    case "mic_missing":
      return "We couldn't find a microphone that works. Check it's connected and not in use by another app, or chat instead.";
    case "mic_unsupported":
      return "This browser can't start a video call here. The chat works everywhere.";
    case "unavailable":
      return "Video calls aren't available right now.";
    // Not "every video line is busy", which reads as a switchboard with
    // something wrong in it, and blamed the visitor for arriving. What is
    // actually true is that she is already talking to somebody, which is an
    // ordinary thing that needs no apology and has an obvious way round it.
    case "busy":
      return `${agent} is on another call right now. Try again in a minute, or chat instead.`;
    case "no_calls_today":
      return `${agent} has no more video calls today. The chat is open now.`;
    case "expired":
      return "This page has been open a while. Reload it to start a call.";
    case "network":
      return "The connection dropped and the call couldn't carry on.";
    case "failed":
    default:
      return "The video call couldn't start.";
  }
}

/** What the state means, in words — the panel never says it with colour alone. */
export function statusText(state: PanelState, agentName: string, greetingSpeaking = false): string {
  // The greeting clip is her, saying the call's first words, and the visitor
  // can both see and hear her doing it. "Connecting…" under a face that is
  // plainly already talking is the page arguing with its own picture — what is
  // connecting underneath is our business, not theirs.
  if (greetingSpeaking && (state.phase === "mic" || state.phase === "connecting")) return `${agentName} is speaking`;
  switch (state.phase) {
    case "intro":
      return "Ready when you are";
    case "mic":
      return "Waiting for your microphone";
    case "connecting":
      return `Connecting to ${agentName}…`;
    case "ended":
      return "Call ended";
    case "error":
      return "Couldn't connect";
    case "live":
      if (state.reconnecting) return "Reconnecting…";
      if (state.agentSpeaking) return `${agentName} is speaking`;
      if (state.muted) return "You're muted";
      if (state.visitorSpeaking) return `${agentName} is listening`;
      return `${agentName} is listening`;
  }
}

// ---------------------------------------------------------------------------
// Duration

export interface DurationView {
  elapsed: number;
  remaining: number;
  phase: "normal" | "warning" | "over";
}

export function durationView(joinedAt: number | undefined, now: number, maxSeconds: number, warnBeforeSeconds: number): DurationView {
  const elapsed = joinedAt ? Math.max(0, Math.floor((now - joinedAt) / 1000)) : 0;
  const remaining = Math.max(0, maxSeconds - elapsed);
  const phase = remaining <= 0 ? "over" : remaining <= warnBeforeSeconds ? "warning" : "normal";
  return { elapsed, remaining, phase };
}

/** 60 → "1 minute", 300 → "5 minutes", 90 → "1 minute 30 seconds", 45 → "45 seconds". */
export function durationWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (m === 0) return unit(r, "second");
  return r === 0 ? unit(m, "minute") : `${unit(m, "minute")} ${unit(r, "second")}`;
}

/**
 * The intro's promise about how long a call runs.
 *
 * `seconds` is what we have actually been delivering (`delivery.ts`), not the
 * number we ask the provider for — those stopped being the same thing the day
 * an account tier started cutting calls short. Null means recent calls do not
 * agree on any length, and a page that cannot keep a promise should not make
 * one: it says the true thing instead, which is that the chat is always there.
 */
export function promiseLine(seconds: number | null): string {
  if (seconds === null) return "These calls are kept short, and you can carry on in chat whenever one ends.";
  return `Calls end after ${durationWords(seconds)}.`;
}

/**
 * The one caption line under the circle: the latest words of whoever spoke
 * last, trimmed from the front so the newest words are the ones on screen.
 */
export function captionLine(state: PanelState, agentName: string, max = 64): string {
  const who = state.captionLast;
  if (!who) return "";
  const text = state.captions[who].replace(/\s+/g, " ").trim();
  if (!text) return "";
  const tail = text.length > max ? `…${text.slice(-(max - 1)).replace(/^\S*\s/, "")}` : text;
  return `${who === "agent" ? agentName : "You"}: ${tail}`;
}

/** 65 → "1:05". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Starting once

/**
 * Wrap an async start so concurrent calls share one run.
 *
 * The button is disabled while starting, and the server dedupes by visitor as
 * well; this is the third lock, for the tap that lands in the same frame as
 * the first one.
 */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    if (running) return running;
    running = fn().finally(() => {
      running = null;
    });
    return running;
  };
}

// ---------------------------------------------------------------------------
// Microphone

export function micErrorCode(err: unknown): VideoErrorCode {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "mic_denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "mic_missing";
  if (name === "NotReadableError" || name === "TrackStartError") return "mic_missing";
  return "mic_unsupported";
}

/** Session-start failures from the server, to what the visitor is told. */
export function startErrorCode(status: number, error: string | undefined): VideoErrorCode {
  if (status === 401) return "expired";
  // Ours and the provider's concurrency are one thing to the visitor: a call is
  // happening and theirs cannot start yet. The daily ceiling is a different
  // thing and used to borrow this wording — "try again in a minute" was never
  // true of it, because in a minute it will still be tomorrow it clears.
  if (error === "busy" || error === "provider_busy") return "busy";
  // Two ceilings, one sentence. "No more video calls today" is true whether
  // the day ran out of sessions or out of the venue's share of its month, and
  // which of the two it was is the venue's business, not the visitor's.
  if (error === "daily_limit" || error === "daily_minutes") return "no_calls_today";
  if (status === 403 || status === 404 || status === 503) return "unavailable";
  return "failed";
}

// ---------------------------------------------------------------------------
// Tavus interaction events → CallEvent

/**
 * Turn Tavus's Daily app messages into what the panel shows.
 *
 * Tavus sends the unified events (`conversation.started_speaking` with a role)
 * and, for now, the legacy ones too (`conversation.replica.started_speaking`),
 * and PAL utterances once as `pal` and once as `replica`. Stateful so each
 * thing is shown once: once a unified event has been seen, legacy duplicates
 * are ignored.
 */
export function createTavusMapper(): (data: unknown) => CallEvent | null {
  let unified = false;
  return (data: unknown) => {
    const msg = data as { message_type?: unknown; event_type?: unknown; properties?: Record<string, unknown> } | null;
    if (!msg || msg.message_type !== "conversation" || typeof msg.event_type !== "string") return null;
    const p = msg.properties ?? {};
    const role = String(p.role ?? "");
    const isAgent = role === "pal" || role === "replica";
    switch (msg.event_type) {
      case "conversation.started_speaking":
      case "conversation.stopped_speaking":
        if (role === "replica") return null;
        unified = true;
        return { type: "speaking", who: isAgent ? "agent" : "visitor", on: msg.event_type.endsWith("started_speaking") };
      case "conversation.replica.started_speaking":
      case "conversation.replica.stopped_speaking":
        if (unified) return null;
        return { type: "speaking", who: "agent", on: msg.event_type.endsWith("started_speaking") };
      case "conversation.user.started_speaking":
      case "conversation.user.stopped_speaking":
        if (unified) return null;
        return { type: "speaking", who: "visitor", on: msg.event_type.endsWith("started_speaking") };
      case "conversation.utterance.streaming":
      case "conversation.utterance": {
        if (role === "replica") return null;
        const speech = typeof p.speech === "string" ? p.speech : "";
        if (!speech) return null;
        return { type: "caption", who: isAgent ? "agent" : "visitor", text: speech };
      }
      default:
        return null;
    }
  };
}

/** The interaction that makes the face answer as if the visitor had said `text`. */
export function respondMessage(conversationId: string, text: string) {
  return {
    message_type: "conversation",
    event_type: "conversation.respond",
    conversation_id: conversationId,
    properties: { text },
  };
}

/**
 * The interaction that makes the face say `text` and nothing else.
 *
 * `respond` would hand the words to the model as though the visitor had said
 * them, and the model would answer something we have not read. This one is
 * spoken verbatim, which is what the quiet prompt needs: it is a line we wrote,
 * in the venue's language, that has to say exactly what it says
 * (`video.quiet.*`). It also leaves the transcript alone — nobody said it to
 * her.
 */
export function echoMessage(conversationId: string, text: string) {
  return {
    message_type: "conversation",
    event_type: "conversation.echo",
    conversation_id: conversationId,
    properties: { text },
  };
}

// ---------------------------------------------------------------------------
// Server-sent events from the model route (the mock's ears)

/** Pull the text out of OpenAI chat-completion SSE frames. Returns [text, rest-of-buffer, done]. */
export function readSseText(buffer: string): [string, string, boolean] {
  let text = "";
  let done = false;
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
      text += parsed.choices?.[0]?.delta?.content ?? "";
    } catch {
      /* a frame that is not ours is not text */
    }
  }
  return [text, rest, done];
}
