import type { Call, Location } from "../types";
import { flagState } from "../flags";
import { listCalls } from "../store";
import { callDurationSeconds } from "../calls";
import { dateIn, todayIn } from "../time";
import { channelIncluded, monthlyVideoSecondsIncluded, serviceState } from "../billing/entitlement";
import { isActivated } from "../onboarding/journey";
import { videoConfig, missingVideoConfig, type VideoConfig } from "./config";
import { readVideoControl } from "./control";
import { venueLook } from "./faces";
import { BELLINE_LOCATION_ID } from "../seed-belline";

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
 *   8. Today's video sessions are under the ceiling for their kind: the
 *      website's (Belline's own venue has a higher one), the demo-wide one for
 *      a personalised demo link, or the support one for an owner's call from
 *      Ask Belle. No kind can use up another's.
 *   9. Today's video *minutes* are under the venue's share of its month
 *      (`dailyVideoSecondsLimit`). The session count above is a ceiling on
 *      rooms, not on spend, and the two stopped agreeing the moment video was
 *      opened to every venue rather than to Belline's own.
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
  | "daily_limit"
  | "daily_minutes";

export type VideoAvailability =
  | { on: true; config: VideoConfig }
  | { on: false; reason: VideoOffReason; missing?: string[]; message?: string };

export function venueAllowlisted(location: Pick<Location, "id">, config: VideoConfig): boolean {
  const entry = readVideoControl().venues[location.id];
  // Only staff's switch counts; an owner's saved face or background is not one.
  // It is read first and in both directions, which is what lets staff take one
  // venue off video while the environment holds the gate open for the rest.
  if (typeof entry?.enabled === "boolean") return entry.enabled;
  if (config.venueScope === "all") return true;
  return config.venues.includes(location.id);
}

/**
 * Who a video call is for, and therefore whose budget pays for it:
 *
 *   - `website`  a visitor on the venue's own site (the customer's allowance,
 *                or Belline's homepage bubble on `loc_belline`);
 *   - `demo`     a personalised sales demo link (sales/video-demo);
 *   - `support`  an owner's call with Belle from the dashboard's Ask Belle.
 *
 * Demo and support calls both run on Belline's own venue and are paid for by
 * Belline. Each kind is counted and capped on its own, so none of the three can
 * use up another's ceiling — and neither demo nor support ever touches a
 * customer's allowance.
 */
export type VideoSessionKind = "website" | "demo" | "support";

/** Which budget an already-recorded call belongs to. */
export function videoCallKind(video: NonNullable<Call["video"]>): VideoSessionKind {
  if (video.demoLinkId) return "demo";
  if (video.support) return "support";
  return "website";
}

export function videoSessionsToday(location: Location, kind: VideoSessionKind = "website"): number {
  const today = todayIn(location.timezone);
  return listCalls(location.id).filter(
    (c) => c.video && videoCallKind(c.video) === kind && dateIn(c.startedAt, location.timezone) === today,
  ).length;
}

/**
 * Video seconds already spent on this venue today, for this kind of session.
 *
 * Every second a room was open, not every second that will be invoiced.
 * `billableVideoSeconds` writes off a call that ended `failed` and one still
 * running, and both of those are Tavus minutes somebody paid for; a ceiling
 * that ignored them would be a ceiling a visitor could walk through by
 * hanging up badly.
 */
export function videoSecondsToday(location: Location, kind: VideoSessionKind = "website"): number {
  const today = todayIn(location.timezone);
  return listCalls(location.id)
    .filter((c) => c.video && videoCallKind(c.video) === kind && dateIn(c.startedAt, location.timezone) === today)
    .reduce((sum, c) => sum + callDurationSeconds(c), 0);
}

/**
 * How many seconds of video this venue's *website* may spend today.
 *
 * The session count below caps rooms; this caps spend, and until video was
 * opened to every venue the two were close enough to leave alone. They are not
 * any more. A Starter venue's month is 75 voice minutes — 30 minutes of video
 * at the 2.5 ratio — while twenty five-minute sessions a day is 100 minutes of
 * video: three months of allowance, in one afternoon, spent by strangers on a
 * website the owner has not looked at.
 *
 * So the day gets a share of the month. `VIDEO_DAILY_SHARE` of one is the
 * plain form of "a venue cannot empty its month in a day": at a fifth, five
 * full days of video is the fastest a month can go, and a venue that paces
 * itself is never touched by this at all. The floor of one whole call matters
 * as much as the share — a ceiling that refuses the first visitor of the day
 * is a broken widget, not a budget — and `VIDEO_MAX_SESSIONS_PER_DAY` still
 * applies above it.
 *
 * Null where there is no month to take a share of: Belline's own venue, demos,
 * support, an internal or exempt venue, an older product whose minutes are not
 * pooled — and a trial, whose thirty minutes are a total rather than an
 * allowance that comes back, so pacing them would only make trying video twice
 * in an afternoon impossible. None of those spends a customer's month.
 */
export const VIDEO_DAILY_SHARE = 1 / 5;

/**
 * The least of today's budget worth opening a room for. The same number
 * `videoCallLimitSeconds` uses against the month, for the same reason: a call
 * that ends after twenty seconds reads as a fault, not as a limit.
 */
export const MIN_VIDEO_SECONDS_LEFT = 30;

export function dailyVideoSecondsLimit(
  location: Location,
  config: VideoConfig,
  kind: VideoSessionKind = "website",
  today: string = todayIn(location.timezone),
): number | null {
  if (kind !== "website" || location.id === BELLINE_LOCATION_ID) return null;
  const month = monthlyVideoSecondsIncluded(location, today);
  if (month === null) return null;
  return Math.max(config.maxCallSeconds, Math.floor(month * VIDEO_DAILY_SHARE));
}

/** Today's ceiling for this kind of session on this venue. */
export function dailyVideoLimit(location: Pick<Location, "id">, config: VideoConfig, kind: VideoSessionKind = "website"): number {
  if (kind === "demo") return config.maxDemoSessionsPerDay;
  if (kind === "support") return config.maxSupportSessionsPerDay;
  return location.id === BELLINE_LOCATION_ID ? config.maxSessionsPerDayBelline : config.maxSessionsPerDay;
}

/**
 * How many video calls may be running at once on this venue.
 *
 * Split exactly as the daily ceiling is, and for the same reason. Belline's own
 * venue carries the homepage bubble, every personalised demo link, the
 * dashboard's support calls and our own testing, all on `loc_belline`; a
 * customer's site carries one website. Demo and support sessions run on
 * Belline's venue whatever `location` says, so they get Belline's number too.
 *
 * Unlike the daily ceilings, the three kinds are *not* counted apart here. A
 * room is a room at the provider, so a demo and a website call are competing
 * for the same live capacity and have to be counted in the same pool — which is
 * also why the answer is clamped to `providerMaxConcurrent`: our ceiling can be
 * lower than the account's, never higher.
 */
export function concurrentVideoLimit(
  location: Pick<Location, "id">,
  config: VideoConfig,
  kind: VideoSessionKind = "website",
): number {
  const venue =
    kind === "demo" || kind === "support" || location.id === BELLINE_LOCATION_ID
      ? config.maxConcurrentBelline
      : config.maxConcurrentPerVenue;
  return Math.max(1, Math.min(venue, config.providerMaxConcurrent));
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
  if (!opts.skipDailyLimit) {
    if (videoSessionsToday(location, kind) >= dailyVideoLimit(location, config, kind)) {
      return { on: false, reason: "daily_limit" };
    }
    const seconds = dailyVideoSecondsLimit(location, config, kind);
    // A whole call short of the ceiling is not enough room for one: refusing
    // now is kinder than a video window that closes after eleven seconds.
    if (seconds !== null && videoSecondsToday(location, kind) + MIN_VIDEO_SECONDS_LEFT > seconds) {
      return { on: false, reason: "daily_minutes" };
    }
  }
  return { on: true, config };
}

/**
 * What the bubble needs to greet: the clip and poster (the venue's own, else the
 * deployment's), the agent's name, and whether it is the mock. Public, so built
 * from a whitelist; only for a venue that is offering video.
 *
 * `greets` is the one field with teeth. A configured clip is a greeting we made
 * on purpose: the same face, saying words we wrote, on our own origin. Callers
 * play that one aloud on the tap and let the live session drop its hello. What
 * they must never do that to is the *fallback* the pages reach for when nothing
 * is configured — the provider's own stock preview of the face, hot-linked, with
 * no words in it at all. Unmuting that would greet the visitor with silence and
 * then take the live greeting away as well, which is worse than either.
 */
export function videoBubbleConfig(location: Location, env: Env = process.env) {
  const config = videoConfig(env);
  const own = readVideoControl().venues[location.id];
  const pick = (venue: string | undefined, fallback: string) => {
    const v = (venue ?? "").trim();
    return /^https:\/\/[^\s"'<>]+$/.test(v) || /^\/[^\s"'<>]*$/.test(v) ? v : fallback;
  };
  const clipUrl = pick(own?.greetingClipUrl, config.greetingClipUrl);
  return {
    agentName: location.agent.displayName,
    clipUrl,
    posterUrl: pick(own?.greetingPosterUrl, config.greetingPosterUrl),
    greets: Boolean(clipUrl),
    mock: config.provider === "mock",
  };
}

/** The face a venue's bubble and calls show: its own curated pick, else `TAVUS_FACE_ID` (faces.ts). */
export function venueFaceId(location: Pick<Location, "id">, config: VideoConfig): string {
  return venueLook(readVideoControl().venues[location.id], config).faceId;
}

/**
 * May this venue's owner be shown the video settings — the face picker on Your
 * business → Agent, and the link to it from the Channels screen?
 *
 * The standing conditions only: the flag, the provider's credentials, the kill
 * switch, whether the environment or staff opened video to this venue, and
 * whether the venue's plan includes the channel at all. Deliberately not the
 * ones that change by the minute — the widget being switched off, the venue
 * not having gone live yet, today's ceilings, this month's allowance. A
 * setting that disappeared because the twentieth visitor of the day has just
 * hung up would read as a fault.
 *
 * Until today this question had a one-line answer — "is the flag on and is the
 * venue on the list" — because the list held one venue and it was ours. With
 * video open to everybody, an owner whose plan has no voice button would have
 * been shown a picker for a call their visitors can never place, and told
 * underneath it how she looks "on a video call from your website". So the plan
 * is part of the question now.
 */
export function videoSettable(location: Location, env: Env = process.env): boolean {
  try {
    if (!flagState("video.avatar", env).on) return false;
    const config = videoConfig(env);
    if (missingVideoConfig(config).length) return false;
    if (readVideoControl().killSwitch.on) return false;
    if (!venueAllowlisted(location, config)) return false;
    return channelIncluded(location, "web_voice");
  } catch {
    // A broken control file hides a setting, never a whole page.
    return false;
  }
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
