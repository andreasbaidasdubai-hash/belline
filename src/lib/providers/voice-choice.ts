import type { Location, VenueLanguage } from "../types";
import { flag } from "../flags";
import { cartesiaEnabled } from "./tts-cartesia";
import { HOUSE_VOICE_ID } from "./tts";

/** seed-belline.ts `BELLINE_LOCATION_ID`, not imported: that module seeds the store. */
const BELLINE_LOCATION_ID = "loc_belline";

/**
 * Which engine and voice a venue speaks with, on the phone and the website's
 * voice button.
 *
 * ElevenLabs, as always, unless the `voice.unify` flag is on *and* Cartesia's
 * key is set (docs/video/voice.md). Then:
 *
 *   - Belline's own venue, and any venue listed in `VOICE_UNIFY_VENUES`, speak
 *     with `VOICE_UNIFY_VOICE_ID` — the voice the video receptionist speaks
 *     with, so Belle sounds the same on a call, on the website and on video;
 *   - a venue whose agent says `voiceEngine: "cartesia"` speaks its own
 *     `voiceId` on Cartesia.
 *
 * Never a silent call: a venue set to Cartesia where Cartesia is not usable
 * falls back to the house ElevenLabs voice (its `voiceId` is a Cartesia id,
 * which ElevenLabs would refuse), and a venue explicitly on `elevenlabs` is
 * never moved.
 */

type Env = Record<string, string | undefined>;

export type VoiceChoice =
  | { engine: "elevenlabs"; voiceId: string }
  | { engine: "cartesia"; voiceId: string; modelId?: string };

const CARTESIA_ID = /^[A-Za-z0-9-]{8,64}$/;

export function voiceUnifyOn(env: Env = process.env): boolean {
  return flag("voice.unify", env) && cartesiaEnabled(env) && CARTESIA_ID.test((env.VOICE_UNIFY_VOICE_ID ?? "").trim());
}

function unifiedVenues(env: Env): Set<string> {
  return new Set([BELLINE_LOCATION_ID, ...(env.VOICE_UNIFY_VENUES ?? "").split(",").map((v) => v.trim()).filter(Boolean)]);
}

/**
 * @param elevenLabsVoice the ElevenLabs voice this venue would use for the
 *   language (tts.ts `voiceIdFor`), used whenever ElevenLabs speaks.
 */
export function voiceChoice(
  location: Pick<Location, "id" | "agent">,
  elevenLabsVoice: string,
  _language?: VenueLanguage,
  env: Env = process.env,
): VoiceChoice {
  const agent = location.agent;
  const usable = voiceUnifyOn(env);
  const model = (env.CARTESIA_MODEL_ID ?? "").trim() || undefined;

  if (agent.voiceEngine === "cartesia") {
    if (usable && CARTESIA_ID.test(agent.voiceId)) return { engine: "cartesia", voiceId: agent.voiceId, ...(model ? { modelId: model } : {}) };
    return { engine: "elevenlabs", voiceId: HOUSE_VOICE_ID };
  }
  if (agent.voiceEngine !== "elevenlabs" && usable && unifiedVenues(env).has(location.id)) {
    return { engine: "cartesia", voiceId: (env.VOICE_UNIFY_VOICE_ID ?? "").trim(), ...(model ? { modelId: model } : {}) };
  }
  return { engine: "elevenlabs", voiceId: elevenLabsVoice };
}
