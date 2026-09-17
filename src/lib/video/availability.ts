import type { Location } from "../types";
import { flagState } from "../flags";
import { listCalls } from "../store";
import { dateIn, todayIn } from "../time";
import { channelIncluded, serviceState } from "../billing/entitlement";
import { isActivated } from "../onboarding/journey";
import { videoConfig, missingVideoConfig, type VideoConfig } from "./config";
import { readVideoControl } from "./control";
import { venueLook } from "./faces";

/**
 * May this venue offer the video receptionist, right now?
 *
 * Every condition has to hold, in this order, and the first that fails is the
 * reason — which the sales console shows staff, and nobody else ever sees:
 *
 *   1. The `video.avatar` flag is on (explicit; needs Tavus's credentials unless
 *      the mock was asked for, and the mock is refused in production).
 *   2. The provider is fully configured.
 *   3. Nobody at Belline has thrown the kill switch.
 *   4. The venue is on the list — the environment's or the console's.
 *   5. The venue's website widget is switched on.
 *   6. The venue has gone live (a signed-in owner previews through the page).
 *   7. The venue's plan includes the web voice button, and is answering.
 *   8. Today's video sessions are under the ceiling: the website's, or for an
 *      owner's support call from Ask Belle the support one, so neither can use
 *      up the other.
 *
 * Deliberately not part of this: the bell's own daily ceiling. A busy day of
 * spoken calls must not switch video off, and video must not use up the bell.
 */

type Env = Record<string, string | undefined>;

export type VideoOffReason =
  | "flag_off"
  | "unsafe"
  | "not_configured"
  | "killed"
  | "not_allowlisted"
  | "widget_off"
  | "not_live"
  | "not_entitled"
  | "daily_limit";

export type VideoAvailability =
  | { on: true; config: VideoConfig }
  | { on: false; reason: VideoOffReason; missing?: string[]; message?: string };

export function venueAllowlisted(location: Pick<Location, "id">, config: VideoConfig): boolean {
  const entry = readVideoControl().venues[location.id];
  // Only staff's switch counts; an owner's saved face or background is not one.
  if (typeof entry?.enabled === "boolean") return entry.enabled;
  return config.venues.includes(location.id);
}

/** A website visitor's video call, or an owner's support call with Belle from the dashboard. */
export type VideoSessionKind = "website" | "support";

export function videoSessionsToday(location: Location, kind: VideoSessionKind = "website"): number {
  const today = todayIn(location.timezone);
  return listCalls(location.id).filter(
    (c) => c.video && Boolean(c.video.support) === (kind === "support") && dateIn(c.startedAt, location.timezone) === today,
  ).length;
}

/** Today's ceiling for this kind of session. */
export function dailyVideoLimit(config: VideoConfig, kind: VideoSessionKind = "website"): number {
  return kind === "support" ? config.maxSupportSessionsPerDay : config.maxSessionsPerDay;
}

export function videoAvailability(
  location: Location,
  opts: { env?: Env; skipLive?: boolean; skipDailyLimit?: boolean; kind?: VideoSessionKind } = {},
): VideoAvailability {
  const env = opts.env ?? process.env;
  const state = flagState("video.avatar", env);
  if (!state.on) return { on: false, reason: state.reason === "unsafe" ? "unsafe" : "flag_off", missing: state.missing };

  const config = videoConfig(env);
  const missing = missingVideoConfig(config);
  if (missing.length) return { on: false, reason: "not_configured", missing };

  if (readVideoControl().killSwitch.on) return { on: false, reason: "killed" };
  if (!venueAllowlisted(location, config)) return { on: false, reason: "not_allowlisted" };
  if (!location.embed?.enabled) return { on: false, reason: "widget_off" };
  if (!opts.skipLive && !isActivated(location)) return { on: false, reason: "not_live" };

  if (!channelIncluded(location, "web_voice")) return { on: false, reason: "not_entitled" };
  const service = serviceState(location, todayIn(location.timezone), { channel: "web_voice" });
  if (!service.answering) return { on: false, reason: "not_entitled", message: service.callerMessage };

  const kind = opts.kind ?? "website";
  if (!opts.skipDailyLimit && videoSessionsToday(location, kind) >= dailyVideoLimit(config, kind)) {
    return { on: false, reason: "daily_limit" };
  }
  return { on: true, config };
}

/**
 * What the bubble needs to greet: the clip and poster (the venue's own, else the
 * deployment's), the agent's name, and whether it is the mock. Public, so built
 * from a whitelist; only for a venue that is offering video.
 */
export function videoBubbleConfig(location: Location, env: Env = process.env) {
  const config = videoConfig(env);
  const own = readVideoControl().venues[location.id];
  const pick = (venue: string | undefined, fallback: string) => {
    const v = (venue ?? "").trim();
    return /^https:\/\/[^\s"'<>]+$/.test(v) || /^\/[^\s"'<>]*$/.test(v) ? v : fallback;
  };
  return {
    agentName: location.agent.displayName,
    clipUrl: pick(own?.greetingClipUrl, config.greetingClipUrl),
    posterUrl: pick(own?.greetingPosterUrl, config.greetingPosterUrl),
    mock: config.provider === "mock",
  };
}

/** The face a venue's bubble and calls show: its own curated pick, else `TAVUS_FACE_ID` (faces.ts). */
export function venueFaceId(location: Pick<Location, "id">, config: VideoConfig): string {
  return venueLook(readVideoControl().venues[location.id], config).faceId;
}

/** What the widget's public config says: offered or not, and nothing about why. */
export function videoOffered(location: Location, env: Env = process.env): boolean {
  try {
    return videoAvailability(location, { env }).on;
  } catch {
    // A broken control file or a provider refusal hides a button, never a widget.
    return false;
  }
}
