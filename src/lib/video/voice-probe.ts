/**
 * What voice the video receptionist actually speaks with, and whether the
 * phone and the website's voice button can call that voice directly.
 *
 * From Tavus's docs (read 17 September 2026):
 *   - A PAL's voice is, in order: `layers.tts.external_voice_id` (a voice in
 *     your own Cartesia, ElevenLabs or Azure account, with `tts_engine`), else
 *     `layers.tts.voice_id` (a Tavus Voice), else the face's
 *     `default_voice_id` (also a Tavus Voice).
 *     https://docs.tavus.io/sections/conversational-video-interface/pal/tts
 *   - A Tavus Voice is Tavus-managed: "Tavus picks the provider and model that
 *     are the best fit"; only Tavus's own `voice_id` is exposed, and nothing
 *     documents using it outside Tavus.
 *     https://docs.tavus.io/sections/conversational-video-interface/voices ·
 *     https://docs.tavus.io/api-reference/faces/get-face
 *
 * So the phone can share the video voice directly only when that voice is an
 * external Cartesia or ElevenLabs voice. Pure: `scripts/video-voice-probe.ts`
 * does the two GETs and prints this verdict.
 */

export type VoiceVerdict =
  | { kind: "external"; engine: "cartesia" | "elevenlabs"; voiceId: string; advice: string }
  | { kind: "tavus"; voiceId: string; source: "pal" | "face"; advice: string }
  | { kind: "unknown"; advice: string };

export function classifyVideoVoice(
  face: { default_voice_id?: unknown } | null,
  palTts: { tts_engine?: unknown; external_voice_id?: unknown; voice_id?: unknown } | null,
): VoiceVerdict {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const engine = str(palTts?.tts_engine).toLowerCase();
  const external = str(palTts?.external_voice_id);
  if (external && (engine === "cartesia" || engine === "elevenlabs")) {
    return {
      kind: "external",
      engine,
      voiceId: external,
      advice:
        engine === "cartesia"
          ? `Option (a): set CARTESIA_API_KEY, VOICE_UNIFY_VOICE_ID=${external} and FLAG_VOICE_UNIFY=on. Belline's own venue then speaks this voice on the phone and the voice button.`
          : `Option (a), no new vendor: set Belline's agent voice to the ElevenLabs voice ${external} in Your business → Agent (it is already Belline's engine).`,
    };
  }
  const tavusVoice = str(palTts?.voice_id);
  if (tavusVoice) {
    return {
      kind: "tavus",
      voiceId: tavusVoice,
      source: "pal",
      advice:
        "A Tavus Voice: not callable outside Tavus. Option (b): pick an ElevenLabs or Cartesia voice both can use, e.g. VIDEO_TAVUS_TTS_ENGINE=elevenlabs and VIDEO_TAVUS_EXTERNAL_VOICE_ID=<Belline's agent voice id> (public voices need no key).",
    };
  }
  const faceVoice = str(face?.default_voice_id);
  if (faceVoice) {
    return {
      kind: "tavus",
      voiceId: faceVoice,
      source: "face",
      advice:
        "The face's own default Tavus Voice: not callable outside Tavus. To keep this exact voice, only Tavus can speak it. Option (b): choose a shared ElevenLabs/Cartesia voice (VIDEO_TAVUS_TTS_ENGINE + VIDEO_TAVUS_EXTERNAL_VOICE_ID), listen on video, then set the same voice for the phone.",
    };
  }
  return { kind: "unknown", advice: "Tavus returned no voice for this face or PAL. Check TAVUS_FACE_ID and TAVUS_PAL_ID." };
}
