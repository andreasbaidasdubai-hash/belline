import type { VideoProviderName } from "./types";

/**
 * Everything the video receptionist reads from the environment, in one place.
 *
 * Names only ever leave this module, never values: the ops page and the sales
 * console show which variables are missing, and a key that reached a response
 * would be a key in somebody's browser history.
 *
 * Tavus renamed replica → face and persona → PAL; the old names are aliases
 * (docs/video/tavus-notes.md). The env vars use the current names.
 */

type Env = Record<string, string | undefined>;

/**
 * `shared` (default): one PAL per venue and face, created once by Belline and
 * reused; the session token rides in `conversational_context`. `per_session`:
 * a PAL made and deleted around every call (slower start; the rollback).
 */
export type PalMode = "per_session" | "shared";

/**
 * Which venues the environment opens the video receptionist to.
 *
 *   - `none`  nothing set: no venue, whatever the flag says;
 *   - `list`  the named venue ids and only those (the original allowlist);
 *   - `all`   every venue, asked for out loud with `VIDEO_AVATAR_VENUES=*`.
 *
 * The three are kept apart on purpose. Video costs real Tavus minutes per
 * visitor, so "nobody configured this" and "open it to everybody" must never
 * be the same value: an empty variable stays `none`, exactly as it always has,
 * and a deployment spends on everyone's behalf only once somebody typed the
 * star. The list survives because an operator may want it back — a staged
 * rollout, a provider incident, a market we have not priced yet.
 *
 * Staff's per-venue switch in the video control file outranks all three, in
 * both directions (video/availability.ts `venueAllowlisted`), so a single
 * venue can still be turned off under the wildcard.
 */
export type VideoVenueScope = "none" | "list" | "all";

/** The value of `VIDEO_AVATAR_VENUES` that opens video to every venue. */
export const ALL_VENUES = "*";

export interface VideoConfig {
  provider: VideoProviderName;
  tavus: {
    apiKey: string;
    /** The stock face, e.g. rf90eb925bd8. Goes in `face_id`. */
    faceId: string;
    /** A PAL to copy voice and turn-taking from. Never used as-is: Belline makes its own PALs. */
    palId: string;
    palMode: PalMode;
    apiBase: string;
    /** Tavus's free, never-joinable conversations. For checking credentials only. */
    testMode: boolean;
    /** Tavus's `speculative_inference`. Off: a half-heard sentence must not run a booking. */
    speculative: boolean;
    /** Hard-delete the conversation at Tavus when it ends (its transcript with it). */
    deleteAfterEnd: boolean;
    /**
     * Option (b) of the voice plan (docs/video/voice.md): make the face speak
     * with a public ElevenLabs or Cartesia voice through the PAL's documented
     * `layers.tts.tts_engine` + `external_voice_id`. Unset: the template PAL's
     * voice, or the face's own `default_voice_id`.
     */
    externalVoice: { engine: "elevenlabs" | "cartesia"; voiceId: string } | null;
  };
  /** Signs the per-session tokens. */
  llmSecret: string;
  /** Where Tavus reaches this app: the base of the model route and the webhook. */
  publicOrigin: string;
  maxCallSeconds: number;
  warnBeforeSeconds: number;
  /** A visitor who never joins the room is let go of after this. */
  joinTimeoutSeconds: number;
  /** Video sessions a day on a customer venue's website. */
  maxSessionsPerDay: number;
  /**
   * Belline's own website venue (loc_belline): the homepage bubble takes far
   * more visitors than any customer's site, so it has its own ceiling.
   */
  maxSessionsPerDayBelline: number;
  /**
   * Personalised video-demo sessions a day, across every link. Counted apart
   * from the venue's website sessions (they run on loc_belline but must never
   * use up the homepage's allowance, or the other way round); each link also
   * has its own per-day allowance (sales/video-demo/service.ts demoLimits).
   */
  maxDemoSessionsPerDay: number;
  /**
   * Owners talking to Belle on video from the dashboard's Ask Belle
   * (VIDEO_SUPPORT_MAX_SESSIONS_PER_DAY, default 100). Belline's own support
   * budget: run on Belline's venue, counted apart from its website and demo
   * sessions, and never against the customer's allowance.
   */
  maxSupportSessionsPerDay: number;
  /**
   * Concurrent sessions on a customer venue's website. Small on purpose: a
   * restaurant's site does not have two people on video at once, and every open
   * room costs money.
   */
  maxConcurrentPerVenue: number;
  /**
   * Belline's own venue (loc_belline) again, for the same reason the daily
   * ceiling is split. Every one of these runs on loc_belline at once: the
   * homepage bubble, every personalised demo link a prospect is sitting on, the
   * dashboard's Ask Belle support calls, and our own testing. The customer
   * number (2) turned all of those into one queue of two and refused the
   * founder on a demo.
   */
  maxConcurrentBelline: number;
  /**
   * What the Tavus account itself allows at once.
   *
   * Tavus's published concurrency varies by tier and no API reports the plan
   * (docs/video/tavus-notes.md), so this is a number somebody has to set from
   * the dashboard. Every ceiling above is clamped to it, so raising a venue's
   * number can never silently promise more rooms than the account has — and a
   * refusal that comes from Tavus anyway is classified apart from ours
   * (`provider_busy`) and raises a ticket, because it means this number is
   * wrong rather than that we are busy.
   */
  providerMaxConcurrent: number;
  /** The bubble's muted greeting clip and its poster, for every venue without its own. */
  greetingClipUrl: string;
  greetingPosterUrl: string;
  /**
   * How far `VIDEO_AVATAR_VENUES` opens video: nothing set, a list, or every
   * venue. The ops page says which of the three is in force, because "no venue
   * is on the list" and "every venue is" look identical from a row of Yes/No.
   */
  venueScope: VideoVenueScope;
  /**
   * Venue ids allowed by the environment, beside the ones staff add in the
   * console. Empty under `none` and under `all`, where naming ids would only
   * invite somebody to read the short list as the whole answer.
   */
  venues: string[];
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!raw?.trim() || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * A clip or poster address a visitor's browser may load: https, or a path on
 * this app.
 *
 * An address that is neither is `""` and not the default, deliberately. A
 * deployment that set this to something dangerous, or merely wrong, has said
 * something about what it wants shown, and quietly showing our own file
 * instead would hide the mistake. Nothing set at all is a different thing to
 * say, and `fallback` answers that one.
 */
function httpsOrPath(raw: string | undefined, fallback = ""): string {
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  return /^https:\/\/[^\s"'<>]+$/.test(value) || /^\/[^\s"'<>]*$/.test(value) ? value : "";
}

/**
 * Belle's greeting clip and its poster, as they ship.
 *
 * Both files are in `public/video`, made once against `TAVUS_FACE_ID` by
 * `scripts/video-greeting-clip.ts` and committed, so the greeting works out of
 * the box rather than waiting for somebody to be told to set two environment
 * variables. A deployment with its own face sets them (or the venue's own
 * settings in `video.json`) and those win.
 */
export const GREETING_CLIP_PATH = "/video/greeting-rf90eb925bd8.mp4";
export const GREETING_POSTER_PATH = "/video/greeting-rf90eb925bd8.jpg";

/**
 * `VIDEO_AVATAR_VENUES`, read into a scope and a list.
 *
 * A star anywhere in the value means every venue: `*` on its own is the way to
 * write it, and `loc_one,*` is somebody who has just opened the gate and left
 * the old list behind rather than a contradiction worth refusing over. The
 * remaining ids are dropped in that case so nothing downstream can mistake
 * them for the whole set.
 */
function venueScopeOf(raw: string | undefined): { venueScope: VideoVenueScope; venues: string[] } {
  const parts = (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (parts.some((p) => p === ALL_VENUES || p.toLowerCase() === "all")) return { venueScope: "all", venues: [] };
  if (!parts.length) return { venueScope: "none", venues: [] };
  return { venueScope: "list", venues: parts };
}

function on(raw: string | undefined): boolean {
  return ["on", "1", "true", "yes"].includes((raw ?? "").trim().toLowerCase());
}

function externalVoice(env: Env): VideoConfig["tavus"]["externalVoice"] {
  const engine = (env.VIDEO_TAVUS_TTS_ENGINE ?? "").trim().toLowerCase();
  const voiceId = (env.VIDEO_TAVUS_EXTERNAL_VOICE_ID ?? "").trim();
  if ((engine !== "elevenlabs" && engine !== "cartesia") || !/^[A-Za-z0-9-]{8,64}$/.test(voiceId)) return null;
  return { engine, voiceId };
}

export function videoConfig(env: Env = process.env): VideoConfig {
  const provider: VideoProviderName = (env.VIDEO_AVATAR_PROVIDER ?? "").trim().toLowerCase() === "mock" ? "mock" : "tavus";
  const maxCallSeconds = num(env.VIDEO_MAX_CALL_SECONDS, 300, 30, 1800);
  return {
    provider,
    tavus: {
      apiKey: (env.TAVUS_API_KEY ?? "").trim(),
      faceId: (env.TAVUS_FACE_ID ?? "").trim(),
      palId: (env.TAVUS_PAL_ID ?? "").trim(),
      palMode: (env.VIDEO_TAVUS_PAL_MODE ?? "").trim().toLowerCase() === "per_session" ? "per_session" : "shared",
      apiBase: (env.TAVUS_API_BASE ?? "https://tavusapi.com").trim().replace(/\/+$/, ""),
      testMode: on(env.VIDEO_TAVUS_TEST_MODE),
      speculative: on(env.VIDEO_TAVUS_SPECULATIVE),
      deleteAfterEnd: on(env.VIDEO_TAVUS_DELETE_AFTER_END),
      externalVoice: externalVoice(env),
    },
    llmSecret: (env.VIDEO_LLM_SECRET ?? "").trim(),
    publicOrigin: (env.VIDEO_PUBLIC_ORIGIN ?? env.PUBLIC_ORIGIN ?? "https://app.belline.ai").trim().replace(/\/+$/, ""),
    maxCallSeconds,
    warnBeforeSeconds: Math.min(num(env.VIDEO_WARN_BEFORE_SECONDS, 30, 5, 300), Math.floor(maxCallSeconds / 2)),
    joinTimeoutSeconds: num(env.VIDEO_JOIN_TIMEOUT_SECONDS, 60, 15, 300),
    maxSessionsPerDay: num(env.VIDEO_MAX_SESSIONS_PER_DAY, 20, 1, 1000),
    maxSessionsPerDayBelline: num(env.VIDEO_MAX_SESSIONS_PER_DAY_BELLINE, 300, 1, 5000),
    maxDemoSessionsPerDay: num(env.VIDEO_DEMO_MAX_SESSIONS_PER_DAY, 200, 1, 5000),
    maxSupportSessionsPerDay: num(env.VIDEO_SUPPORT_MAX_SESSIONS_PER_DAY, 100, 1, 5000),
    maxConcurrentPerVenue: num(env.VIDEO_MAX_CONCURRENT_PER_VENUE, 2, 1, 50),
    maxConcurrentBelline: num(env.VIDEO_MAX_CONCURRENT_BELLINE, 8, 1, 50),
    providerMaxConcurrent: num(env.VIDEO_PROVIDER_MAX_CONCURRENT, 10, 1, 200),
    greetingClipUrl: httpsOrPath(env.VIDEO_GREETING_CLIP_URL, GREETING_CLIP_PATH),
    greetingPosterUrl: httpsOrPath(env.VIDEO_GREETING_POSTER_URL, GREETING_POSTER_PATH),
    ...venueScopeOf(env.VIDEO_AVATAR_VENUES),
  };
}

/** Env var names the selected provider still needs. Names, never values. */
export function missingVideoConfig(config: VideoConfig): string[] {
  if (config.provider === "mock") return [];
  const missing: string[] = [];
  if (!config.tavus.apiKey) missing.push("TAVUS_API_KEY");
  if (!config.tavus.faceId) missing.push("TAVUS_FACE_ID");
  if (!config.llmSecret) missing.push("VIDEO_LLM_SECRET");
  if (!/^https:\/\//.test(config.publicOrigin)) missing.push("VIDEO_PUBLIC_ORIGIN (https)");
  return missing;
}
