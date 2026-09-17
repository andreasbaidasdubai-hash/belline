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
  "ready",
  "first_frame",
  "first_response",
  "reconnecting",
  "fallback_chat",
  "fallback_voice",
  "client_error",
] as const;

export const SERVER_METRICS = [
  "session_create_started",
  "session_created",
  "session_create_failed",
  "llm_first_token",
  "booking_or_lead",
  "handover_requested",
  "duration_warning",
  "ended",
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
