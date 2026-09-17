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
  maxConcurrentPerVenue: number;
  /** The bubble's muted greeting clip and its poster, for every venue without its own. */
  greetingClipUrl: string;
  greetingPosterUrl: string;
  /** Venue ids allowed by the environment, beside the ones staff add in the console. */
  venues: string[];
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!raw?.trim() || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** A clip or poster address a visitor's browser may load: https, or a path on this app. */
function httpsOrPath(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return /^https:\/\/[^\s"'<>]+$/.test(value) || /^\/[^\s"'<>]*$/.test(value) ? value : "";
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
    maxConcurrentPerVenue: num(env.VIDEO_MAX_CONCURRENT_PER_VENUE, 2, 1, 50),
    greetingClipUrl: httpsOrPath(env.VIDEO_GREETING_CLIP_URL),
    greetingPosterUrl: httpsOrPath(env.VIDEO_GREETING_POSTER_URL),
    venues: (env.VIDEO_AVATAR_VENUES ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
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
