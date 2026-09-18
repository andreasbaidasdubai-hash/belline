import type { Location } from "../types";
import { isConfigured } from "../db/client";
import { track } from "../reception/events";

/**
 * Timings and outcomes for the video receptionist.
 *
 * Written to the product's own event table (`reception/events.ts`) where there
 * is one, and always kept in a short in-memory list the sales console reads —
 * so "how long until the face spoke?" is answerable on a staging box with no
 * database as well as in production.
 *
 * Names are a closed list. The panel reports some of these itself, and a public
 * endpoint that records any name it is sent is a public endpoint anybody can
 * fill with rubbish.
 */

export const CLIENT_METRICS = [
  "video_selected",
  "mic_prompted",
  "mic_denied",
  /**
   * The greeting clip, on the tap: `ms` is how long the browser took to give
   * it a voice, and `detail` says what happened — `spoken`, `host` (the page
   * around the bubble said it), or why it did not: `no_clip`, `hidden`,
   * `refused`, `host_failed`.
   *
   * The failures are the point. A clip that quietly stops playing is invisible
   * from outside: the call still works, the visitor simply goes back to
   * waiting in silence, which is the thing this was built to remove. This is
   * how that becomes a number instead of something somebody eventually
   * notices.
   */
  "greeting_clip",
  "ready",
  "first_frame",
  "first_response",
  "reconnecting",
  "fallback_chat",
  "fallback_voice",
  "client_error",
  /**
   * The panel saying it is still on screen, every `VIDEO_HEARTBEAT_SECONDS`.
   * No timing, nothing about the visitor: its whole content is that it
   * arrived, which is what stops a closed tab holding a concurrency slot
   * (sessions.ts).
   */
  "alive",
  /**
   * She broke a silence nobody else was going to break: `ms` is how long after
   * the tap, and `detail` is `no_mic` (no microphone ever reached the room) or
   * `waiting` (one did, and it heard nothing). A run of `no_mic` says the
   * microphone gate is failing somewhere real browsers go; a run of `waiting`
   * says visitors do not know they may speak.
   */
  "quiet_prompt",
] as const;

export const SERVER_METRICS = [
  "session_create_started",
  "session_created",
  /** The same timing, with how the PAL was had in `detail`: shared_warm, shared_cold, per_session. */
  "session_create_ms",
  "session_create_failed",
  "llm_first_token",
  "booking_or_lead",
  "handover_requested",
  "duration_warning",
  "ended",
  /** The same ending, classified, with the provider's raw reason in `detail` and the real length in `ms`. */
  "ended_cause",
  /** The provider refused a start for concurrency on the account — not our ceiling. See delivery.ts. */
  "provider_at_capacity",
  /** A live session let go of because its page stopped saying it was there. */
  "session_swept",
  /**
   * A call that ran and was never asked for a word: `ms` is how long it ran and
   * `detail` is `joined` or `never_joined`. The absence of a model request is
   * the only trace a call like this leaves, and an absence is not something
   * anybody greps a log for — so it is written down as a presence, and raises a
   * ticket beside it (sessions.ts `raiseSilentSession`).
   */
  "no_model_requests",
] as const;

export type VideoMetricName = (typeof CLIENT_METRICS)[number] | (typeof SERVER_METRICS)[number];

export interface VideoMetric {
  at: string;
  name: VideoMetricName;
  locationId: string;
  sessionId?: string;
  /** Milliseconds, where the metric is a timing. */
  ms?: number;
  /** A short, non-personal detail: a reason code, a tool name. */
  detail?: string;
}

const KEPT = 500;

const globalRef = globalThis as unknown as { __bellineVideoMetrics?: VideoMetric[] };

export function recentVideoMetrics(): VideoMetric[] {
  return [...(globalRef.__bellineVideoMetrics ?? [])];
}

export function clearVideoMetrics(): void {
  globalRef.__bellineVideoMetrics = [];
}

export function isClientMetric(name: unknown): name is (typeof CLIENT_METRICS)[number] {
  return typeof name === "string" && (CLIENT_METRICS as readonly string[]).includes(name);
}

export function recordVideoMetric(
  location: Pick<Location, "id" | "tenantId" | "businessId">,
  metric: Omit<VideoMetric, "at" | "locationId">,
): void {
  const row: VideoMetric = {
    at: new Date().toISOString(),
    locationId: location.id,
    name: metric.name,
    ...(metric.sessionId ? { sessionId: metric.sessionId } : {}),
    ...(typeof metric.ms === "number" && Number.isFinite(metric.ms) ? { ms: Math.max(0, Math.round(metric.ms)) } : {}),
    ...(metric.detail ? { detail: metric.detail.slice(0, 80) } : {}),
  };
  const list = (globalRef.__bellineVideoMetrics ??= []);
  list.push(row);
  if (list.length > KEPT) list.splice(0, list.length - KEPT);

  if (isConfigured()) {
    void track({
      tenantId: location.tenantId,
      businessId: location.businessId,
      locationId: location.id,
      name: `video.${row.name}`,
      payload: { sessionId: row.sessionId, ms: row.ms, detail: row.detail },
    });
  }
}
