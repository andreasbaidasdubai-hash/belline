import crypto from "node:crypto";
import type { Call, Location } from "../types";
import { getCall, getLocation, saveCall } from "../store";
import { startCall } from "../calls";
import { releaseCall } from "../booking/holds";
import { meterCallTime, meterVideoTime } from "../billing/cost";
import { videoSecondsLeft } from "../billing/entitlement";
import { todayIn } from "../time";
import { openException } from "../exceptions";
import { BELLINE_TENANT_ID } from "../tenancy";
import { BELLINE_LOCATION_ID, BELLINE_VIDEO_GREETING } from "../seed-belline";
import { answersIn } from "../language";
import { videoAvailability, type VideoOffReason } from "./availability";
import type { VideoConfig } from "./config";
import { venueVideoSettings } from "./control";
import { videoBackground } from "./backgrounds";
import { venueLook } from "./faces";
import { recordVideoMetric } from "./metrics";
import { videoProvider } from "./provider";
import { signVideoToken } from "./tokens";
import { VideoProviderError, type VideoAvatarProvider, type VideoEvent, type VideoProviderName } from "./types";

/**
 * Live video sessions: created once, ended once, never left running.
 *
 * Held in memory in the one process that also holds the voice sockets, exactly
 * as a telephone call is — a session is a few minutes long and cannot survive a
 * restart anyway, because the provider's room outlives nothing of ours. What
 * must survive is the call record, and that is written to the store at the
 * start and at the end.
 *
 * Four things are guaranteed here rather than hoped for in the browser:
 *
 *   **One session per click.** A second start from the same visitor while the
 *   first is still being created gets the first; one that arrives after gets
 *   the live one. A double click, a retry after a slow network and two tabs all
 *   produce a single room and a single bill.
 *
 *   **A ceiling per venue.** Concurrent sessions, and sessions a day
 *   (availability.ts), because every minute a room is open costs money whether
 *   anybody is talking or not.
 *
 *   **An end.** The provider is told the maximum duration, and a timer here ends
 *   the session a few seconds after it in case the provider did not. A visitor
 *   who never joins is let go of after the join timeout.
 *
 *   **Cleanup that is idempotent.** The visitor's button, the page unloading,
 *   the provider's callback and the timers all call `endVideoSession`, in any
 *   order and as often as they like; the provider is told once and the call
 *   record is closed once.
 */

type Env = Record<string, string | undefined>;

export interface VideoSession {
  id: string;
  locationId: string;
  tenantId: string;
  visitorKey: string;
  callId: string;
  provider: VideoProviderName;
  status: "creating" | "live" | "ended";
  createdAt: number;
  joinedAt?: number;
  endedAt?: number;
  endReason?: string;
  conversationId?: string;
  ephemeralPalId?: string;
  /** The face this call shows, and whether its green is replaced in the panel. */
  faceId?: string;
  greenscreen?: boolean;
  backgroundId?: string;
  roomUrl?: string;
  meetingToken?: string;
  /** For the provider's model requests. Never sent to the browser. */
  llmToken: string;
  /** For the browser's own end, handover and timing reports. */
  clientToken: string;
  greeting: string;
  maxCallSeconds: number;
  warnBeforeSeconds: number;
  timers: ReturnType<typeof setTimeout>[];
  /** The receptionist behind the face; created on the first model request. See engine.ts. */
  agent?: unknown;
  /** The model turn in flight, so a newer request can cut it off. */
  turn?: { abort: AbortController; done: Promise<void> };
  /**
   * A personalised video demo (sales/video-demo): the link it was opened from,
   * and the server-written prospect briefing the receptionist is given. Set
   * only by the demo's own session route, from the link's stored snapshot.
   */
  demo?: { linkId: string; briefing: string };
  /**
   * An owner's support call from the dashboard's Ask Belle: whose it is, and
   * the account briefing written server-side from their own tenant.
   */
  support?: { userId: string; tenantId: string; briefing: string };
  /** Told once, after the call record is closed. Never sent anywhere. */
  onEnded?: (info: { session: VideoSession; call: Call | undefined; seconds: number }) => void | Promise<void>;
}

/** What a demo session adds to a start. */
export interface VideoDemoStart {
  linkId: string;
  briefing: string;
  /** The personalised opening, spoken by the provider before the model is asked anything. */
  greeting: string;
  onEnded?: VideoSession["onEnded"];
}

/** What an owner's support call adds to a start (app/api/belle/video). */
export interface VideoSupportStart {
  userId: string;
  tenantId: string;
  briefing: string;
  greeting: string;
}

/** What the panel receives. The room, a short-lived token, and the limits — nothing else. */
export interface ClientSession {
  sessionId: string;
  provider: VideoProviderName;
  roomUrl: string;
  meetingToken?: string;
  /** The provider's id, which its in-call messages must name. Not a credential. */
  conversationId?: string;
  clientToken: string;
  maxCallSeconds: number;
  warnBeforeSeconds: number;
  captions: boolean;
  perception: boolean;
  greeting: string;
  /** Replace the stream's green with this picture (a path on this app). Absent: show the stream as it is. */
  background?: { id: string; src: string; tone: "light" | "dark" };
}

export type StartResult =
  | { ok: true; session: VideoSession; client: ClientSession; reused: boolean }
  | { ok: false; reason: VideoOffReason | "busy" | "provider_failed" | "no_provider"; retryable: boolean; status: number };

interface Registry {
  sessions: Map<string, VideoSession>;
  pending: Map<string, Promise<StartResult>>;
}

const globalRef = globalThis as unknown as { __bellineVideoSessions?: Registry };

function registry(): Registry {
  globalRef.__bellineVideoSessions ??= { sessions: new Map(), pending: new Map() };
  return globalRef.__bellineVideoSessions;
}

/** Ended sessions are remembered this long, so a late end or callback is a no-op, not a 404. */
const FORGET_AFTER_MS = 15 * 60 * 1000;
/** The provider's own maximum fires first; ours is the backstop. */
const END_GRACE_SECONDS = 5;

export function getVideoSession(sessionId: string): VideoSession | undefined {
  return registry().sessions.get(sessionId);
}

export function liveVideoSessions(locationId?: string): VideoSession[] {
  return [...registry().sessions.values()].filter(
    (s) => s.status !== "ended" && (!locationId || s.locationId === locationId),
  );
}

export function findVideoSessionByConversation(conversationId: string): VideoSession | undefined {
  return [...registry().sessions.values()].find((s) => s.conversationId === conversationId);
}

/** For the checks. Ends nothing at the provider. */
export function clearVideoSessions(): void {
  for (const s of registry().sessions.values()) s.timers.forEach(clearTimeout);
  globalRef.__bellineVideoSessions = { sessions: new Map(), pending: new Map() };
}

/**
 * The opening line: the agent's own name, the business's, and that it is an AI.
 * Belline's own venue introduces the product as well (seed-belline.ts); every
 * other venue is named in its greeting.
 */
export function videoGreeting(location: Location): string {
  const own = venueVideoSettings(location.id)?.greeting?.trim();
  if (own) return own;
  if (location.id === BELLINE_LOCATION_ID) return BELLINE_VIDEO_GREETING;
  return `Hi, I'm ${location.agent.displayName}, the AI concierge for ${location.name}. How may I help you today?`;
}

export async function startVideoSession(
  location: Location,
  visitorId: string,
  opts: { env?: Env; preview?: boolean; provider?: VideoAvatarProvider; demo?: VideoDemoStart; support?: VideoSupportStart } = {},
): Promise<StartResult> {
  const env = opts.env ?? process.env;
  // An owner's support call counts against the support ceiling, never the website's.
  const available = videoAvailability(location, { env, skipLive: opts.preview, kind: opts.support ? "support" : "website" });
  if (!available.on) {
    const status = available.reason === "daily_limit" ? 429 : 403;
    return { ok: false, reason: available.reason, retryable: false, status };
  }
  const provider = opts.provider ?? videoProvider(env, available.config);
  if (!provider) return { ok: false, reason: "no_provider", retryable: false, status: 503 };

  const reg = registry();
  // A demo visitor is keyed by the link as well: the same browser on two
  // prospects' links is two conversations with two different briefings.
  const visitorKey = opts.demo
    ? `${location.id}:demo:${opts.demo.linkId}:${visitorId}`
    : opts.support
      ? `${location.id}:support:${opts.support.userId}`
      : `${location.id}:${visitorId}`;

  // The double click, and the retry after a slow network: the same visitor
  // gets the session already being made, or the one already live.
  const pending = reg.pending.get(visitorKey);
  if (pending) {
    const result = await pending;
    return result.ok ? { ...result, reused: true } : result;
  }
  const live = [...reg.sessions.values()].find((s) => s.visitorKey === visitorKey && s.status === "live");
  if (live) return { ok: true, session: live, client: clientPayload(live, available.config, provider), reused: true };

  if (liveVideoSessions(location.id).length >= available.config.maxConcurrentPerVenue) {
    return { ok: false, reason: "busy", retryable: true, status: 429 };
  }

  // The allowance, not only the deployment's ceiling, decides how long this
  // call may run: video uses voice minutes at VIDEO_VOICE_MINUTE_RATIO, so a
  // call that would run past what is left ends at it instead.
  const limit = videoCallLimitSeconds(location, available.config.maxCallSeconds);
  if (limit === null) return { ok: false, reason: "not_entitled", retryable: false, status: 403 };
  const config = limit === available.config.maxCallSeconds ? available.config : { ...available.config, maxCallSeconds: limit, warnBeforeSeconds: Math.min(available.config.warnBeforeSeconds, Math.floor(limit / 2)) };

  const creation = create(location, visitorKey, config, provider, env, opts.demo, opts.support);
  reg.pending.set(visitorKey, creation);
  try {
    return await creation;
  } finally {
    reg.pending.delete(visitorKey);
  }
}

/**
 * Allowance kept back from a capped call: the room is created, and the call's
 * clock started, a few seconds before the provider's own maximum starts
 * counting, and our backstop timer adds END_GRACE_SECONDS after it.
 */
export const VIDEO_ALLOWANCE_MARGIN_SECONDS = 30;
/** Shorter than this is not a call worth opening. */
const MIN_VIDEO_CALL_SECONDS = 30;

/**
 * How long a video call may run for this venue: the deployment's ceiling, or
 * less when the voice-minute allowance ends sooner. Null when what is left is
 * too short to open a call at all.
 */
export function videoCallLimitSeconds(location: Location, ceiling: number, today: string = todayIn(location.timezone)): number | null {
  const left = videoSecondsLeft(location, today);
  if (left === null) return ceiling;
  const usable = left - VIDEO_ALLOWANCE_MARGIN_SECONDS;
  if (usable < MIN_VIDEO_CALL_SECONDS) return null;
  return Math.min(ceiling, usable);
}

async function create(
  location: Location,
  visitorKey: string,
  config: VideoConfig,
  provider: VideoAvatarProvider,
  env: Env,
  demo?: VideoDemoStart,
  support?: VideoSupportStart,
): Promise<StartResult> {
  const reg = registry();
  const sessionId = `vs_${crypto.randomBytes(9).toString("base64url")}`;
  const startedAt = Date.now();

  const call = startCall(location, "embed", "website");
  call.video = { provider: provider.name, sessionId, ...(support ? { support: true } : {}) };
  // Our own venue and our demo lines are ours to pay for, never a customer's.
  if (location.internal || location.demo?.enabled) call.isDemo = true;
  saveCall(call);

  const settings = venueVideoSettings(location.id);
  const look = venueLook(settings, config);
  const tokenTtl = config.maxCallSeconds + 15 * 60;
  const session: VideoSession = {
    id: sessionId,
    locationId: location.id,
    tenantId: location.tenantId,
    visitorKey,
    callId: call.id,
    provider: provider.name,
    status: "creating",
    createdAt: startedAt,
    llmToken: signVideoToken("llm", sessionId, location.id, tokenTtl, env),
    clientToken: signVideoToken("client", sessionId, location.id, tokenTtl, env),
    greeting: demo?.greeting.trim() || support?.greeting.trim() || videoGreeting(location),
    maxCallSeconds: config.maxCallSeconds,
    warnBeforeSeconds: config.warnBeforeSeconds,
    timers: [],
    faceId: look.faceId,
    greenscreen: look.greenscreen,
    backgroundId: look.background.id,
    ...(demo ? { demo: { linkId: demo.linkId, briefing: demo.briefing }, onEnded: demo.onEnded } : {}),
    ...(support ? { support: { userId: support.userId, tenantId: support.tenantId, briefing: support.briefing } } : {}),
  };
  reg.sessions.set(sessionId, session);
  recordVideoMetric(location, { name: "session_create_started", sessionId });

  try {
    const created = await provider.createSession({
      sessionId,
      locationId: location.id,
      businessName: location.name,
      agentName: location.agent.displayName,
      greeting: session.greeting,
      languages: [settings?.language ?? "en"],
      maxCallSeconds: config.maxCallSeconds,
      absentTimeoutSeconds: config.joinTimeoutSeconds,
      leftTimeoutSeconds: 10,
      llmToken: session.llmToken,
      llmBaseUrl: `${config.publicOrigin}/api/video/llm`,
      callbackUrl: `${config.publicOrigin}/api/video/webhook/${provider.name}?t=${encodeURIComponent(
        signVideoToken("webhook", sessionId, location.id, config.maxCallSeconds + 60 * 60, env),
      )}`,
      // The languages registry takes a context, not the environment alone: the website voice channel's language.
      euPolicy: answersIn(location, { env, channel: "web_voice" }) === "de",
      faceId: look.faceId,
      palId: settings?.palId,
      greenscreen: look.greenscreen,
    });

    if ((session.status as VideoSession["status"]) === "ended") {
      // Ended while it was being created — the kill switch, or the visitor
      // closing the panel. The room exists now, so it is closed now.
      await provider.endSession({ conversationId: created.conversationId, ephemeralPalId: created.ephemeralPalId }).catch(() => undefined);
      return { ok: false, reason: "provider_failed", retryable: false, status: 409 };
    }

    session.status = "live";
    session.conversationId = created.conversationId;
    session.ephemeralPalId = created.ephemeralPalId;
    session.roomUrl = created.roomUrl;
    session.meetingToken = created.meetingToken;
    // What the provider actually did, when it says: one that gave no green
    // screen leaves the panel showing the stream as it is.
    if (created.greenscreen === false) session.greenscreen = false;
    call.video = { ...call.video, conversationId: created.conversationId };
    saveCall(call);

    session.timers.push(
      setTimeout(() => void endVideoSession(sessionId, "max_duration", { by: "timer" }), (config.maxCallSeconds + END_GRACE_SECONDS) * 1000),
      setTimeout(() => {
        if (!session.joinedAt) void endVideoSession(sessionId, "never_joined", { by: "timer" });
      }, config.joinTimeoutSeconds * 1000),
    );
    session.timers.forEach((t) => (t as { unref?: () => void }).unref?.());

    const createMs = Date.now() - startedAt;
    recordVideoMetric(location, { name: "session_created", sessionId, ms: createMs });
    // The start, by how the PAL was had: a kept shared PAL, one made now, or one per call.
    recordVideoMetric(location, { name: "session_create_ms", sessionId, ms: createMs, detail: created.pal ?? provider.name });
    return { ok: true, session, client: clientPayload(session, config, provider), reused: false };
  } catch (err) {
    const retryable = err instanceof VideoProviderError ? err.retryable : true;
    const detail = err instanceof VideoProviderError ? `status_${err.status}` : "error";
    // The provider's words go to the log, which never sees a key or a token.
    console.warn(`[video] ${sessionId} could not start: ${err instanceof Error ? err.message : String(err)}`);
    session.status = "ended";
    session.endedAt = Date.now();
    session.endReason = "create_failed";
    saveCall({
      ...call,
      status: "failed",
      endedAt: new Date().toISOString(),
      outcome: null,
      summary: "The video call could not start.",
      video: { ...call.video!, endReason: "create_failed" },
    });
    recordVideoMetric(location, { name: "session_create_failed", sessionId, ms: Date.now() - startedAt, detail });
    forgetLater(sessionId);
    return { ok: false, reason: "provider_failed", retryable, status: 502 };
  }
}

function clientPayload(session: VideoSession, _config: VideoConfig, provider: VideoAvatarProvider): ClientSession {
  const background = videoBackground(session.backgroundId);
  return {
    sessionId: session.id,
    provider: session.provider,
    roomUrl: session.roomUrl ?? "",
    ...(session.meetingToken ? { meetingToken: session.meetingToken } : {}),
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    clientToken: session.clientToken,
    maxCallSeconds: session.maxCallSeconds,
    warnBeforeSeconds: session.warnBeforeSeconds,
    captions: provider.capabilities.captions,
    perception: false,
    greeting: session.greeting,
    ...(session.greenscreen && background?.src ? { background: { id: background.id, src: background.src, tone: background.tone } } : {}),
  };
}

export type EndedBy = "visitor" | "unload" | "provider" | "timer" | "kill_switch" | "agent" | "staff";

/**
 * End a session. Safe to call any number of times, from anywhere.
 *
 * Returns false when there was nothing left to end.
 */
export async function endVideoSession(
  sessionId: string,
  reason: string,
  opts: { by: EndedBy; provider?: VideoAvatarProvider } = { by: "visitor" },
): Promise<boolean> {
  const session = registry().sessions.get(sessionId);
  if (!session || session.status === "ended") return false;

  const wasLive = session.status === "live";
  session.status = "ended";
  session.endedAt = Date.now();
  session.endReason = reason.slice(0, 80);
  session.timers.forEach(clearTimeout);
  session.timers = [];
  session.turn?.abort.abort();

  const location = getLocation(session.locationId);
  const call = getCall(session.callId);

  // Tell the provider, even when it was the provider that told us: ending an
  // ended conversation is a no-op there, and it is what deletes this
  // session's PAL.
  if (wasLive && session.conversationId) {
    const provider = opts.provider ?? videoProvider();
    try {
      await provider?.endSession({ conversationId: session.conversationId, ephemeralPalId: session.ephemeralPalId });
    } catch (err) {
      console.warn(`[video] ${sessionId} provider cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (call && location) finishCall(call, location, session);
  notifyEnded(session);
  forgetLater(sessionId);
  return true;
}

function notifyEnded(session: VideoSession): void {
  const listener = session.onEnded;
  if (!listener) return;
  session.onEnded = undefined;
  const call = getCall(session.callId);
  const seconds = call?.video?.seconds ?? Math.max(0, Math.round(((session.endedAt ?? Date.now()) - session.createdAt) / 1000));
  try {
    void Promise.resolve(listener({ session, call, seconds })).catch((err) =>
      console.warn(`[video] ${session.id} end listener failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  } catch (err) {
    console.warn(`[video] ${session.id} end listener failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function finishCall(call: Call, location: Location, session: VideoSession): void {
  if (call.status !== "active") return;
  releaseCall(call.id);
  const spoke = call.transcript.some((t) => t.role === "caller");
  const endedAt = new Date(session.endedAt ?? Date.now()).toISOString();
  const seconds = (Date.parse(endedAt) - Date.parse(call.startedAt)) / 1000;
  const finished: Call = {
    ...call,
    status: "completed",
    endedAt,
    outcome: call.outcome ?? (spoke ? "answered_question" : "abandoned"),
    summary: call.summary ?? (spoke ? "Video call on the website." : "Video call ended before anything was said."),
    video: {
      ...(call.video ?? { provider: session.provider, sessionId: session.id }),
      endReason: session.endReason,
      seconds: Math.max(0, Math.round(seconds)),
    },
  };
  saveCall(finished);
  // Usage: billing/usage.ts counts this `embed` call against the voice-minute
  // pool at the video ratio. Cost: the call's time as the bell's would be, and
  // the provider's minutes at the Tavus Business estimate (cost.ts).
  meterCallTime(finished, location, seconds, { stt: false });
  meterVideoTime(finished, seconds, session.provider);
  recordVideoMetric(location, { name: "ended", sessionId: session.id, ms: seconds * 1000, detail: session.endReason });
}

function forgetLater(sessionId: string): void {
  const timer = setTimeout(() => {
    const s = registry().sessions.get(sessionId);
    if (s?.status === "ended") registry().sessions.delete(sessionId);
  }, FORGET_AFTER_MS);
  (timer as { unref?: () => void }).unref?.();
}

/** The kill switch: every live session, now. */
export async function endAllVideoSessions(reason: string, by: EndedBy): Promise<number> {
  const live = liveVideoSessions();
  await Promise.all(live.map((s) => endVideoSession(s.id, reason, { by })));
  return live.length;
}

/** Something the provider told us about a session. */
export async function applyVideoEvent(session: VideoSession, event: VideoEvent): Promise<void> {
  switch (event.kind) {
    case "joined":
      session.joinedAt ??= Date.now();
      return;
    case "ended":
      await endVideoSession(session.id, event.reason, { by: "provider" });
      return;
    case "transcript": {
      // The model route writes every turn as it happens. The provider's copy
      // only fills a record that has none — a call that never reached us.
      const call = getCall(session.callId);
      if (!call || call.transcript.length > 0 || event.turns.length === 0) return;
      const at = new Date().toISOString();
      saveCall({ ...call, transcript: event.turns.slice(0, 200).map((t) => ({ role: t.role, text: t.text.slice(0, 2000), at })) });
      return;
    }
    default:
      return;
  }
}

/** The visitor joined the room (reported by the panel, and by the provider's callback). */
export function markVideoJoined(session: VideoSession): void {
  session.joinedAt ??= Date.now();
}

/**
 * The visitor pressed "Talk to a person".
 *
 * The same thing the receptionist's own handover does on the bell: the call is
 * flagged for the Action Inbox, and on Belline's own line an exception is
 * raised because nobody watches that inbox the way an owner watches theirs.
 * The face is then asked to take their details (see the panel).
 */
export function requestVideoHandover(session: VideoSession): boolean {
  const call = getCall(session.callId);
  const location = getLocation(session.locationId);
  if (!call || !location || session.status !== "live") return false;
  if (!call.escalation) {
    saveCall({ ...call, escalation: "Visitor asked for a person during a video call." });
  }
  recordVideoMetric(location, { name: "handover_requested", sessionId: session.id });
  if (location.tenantId === BELLINE_TENANT_ID) {
    openException({
      tenantId: location.tenantId,
      locationId: location.id,
      kind: "handoff_requested",
      reason: "asked for a person on a video call",
      context: { callId: call.id, channel: "video" },
      source: "system",
    });
  }
  return true;
}
