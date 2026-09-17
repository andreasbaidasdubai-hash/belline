# One voice everywhere

The founder wants Belle to sound on the phone and on the website's voice button
exactly as she sounds on the Tavus video call.

## What the docs say (read 17 September 2026)

- A PAL speaks, in order of precedence: `layers.tts.external_voice_id` (a voice
  in your own **Cartesia, ElevenLabs or Azure** account, with `tts_engine`),
  else `layers.tts.voice_id` (a **Tavus Voice**), else the face's
  `default_voice_id` (also a Tavus Voice). "You can use any publicly accessible
  custom voice from ElevenLabs or Cartesia without the provider's API key";
  `api_key` is needed only for private voices.
  — https://docs.tavus.io/sections/conversational-video-interface/pal/tts
- A Tavus Voice is Tavus-managed: "Tavus picks the provider and model that are
  the best fit for the language(s) of the conversation". Only Tavus's own
  `voice_id` (`v…`) is exposed; nothing documents the underlying provider voice
  or any use outside Tavus.
  — https://docs.tavus.io/sections/conversational-video-interface/voices ·
  https://docs.tavus.io/api-reference/voices/list-voices
- `GET /v2/faces/{face_id}` returns `default_voice_id` ("The Voice this face
  speaks with when a PAL sets no voice of its own").
  — https://docs.tavus.io/api-reference/faces/get-face

## The decision

Which case staging is in is decided by two GETs nobody has run yet (no Tavus
calls from this branch). The main session runs:

```powershell
node --import tsx --env-file=.env scripts/video-voice-probe.ts
```

It prints the face's `default_voice_id`, the template PAL's `layers.tts`, and
one of three verdicts (`src/lib/video/voice-probe.ts`):

| What Belle speaks with on video | Can the phone call it directly? | What to do |
|---|---|---|
| `tts_engine: cartesia` + `external_voice_id` in `TAVUS_PAL_ID` | **Yes — option (a)** | Set `CARTESIA_API_KEY`, `VOICE_UNIFY_VOICE_ID=<that id>`, `FLAG_VOICE_UNIFY=on`. |
| `tts_engine: elevenlabs` + `external_voice_id` | **Yes — option (a), no new vendor** | Set Belline's agent voice to that ElevenLabs id in Your business → Agent. |
| A Tavus Voice (`voice_id`, or the face's `default_voice_id`) | **No** — Tavus does not expose or license it outside Tavus | Option (b), below. The exact current video voice cannot be reproduced on the phone. |

**Most likely:** the stock face's own default voice (a Tavus Voice), because the
README's template-PAL step says to "pick the voice" in the dashboard, which
selects Tavus Voices. If so, (a) is impossible with this exact voice and the
honest path is (b): choose one ElevenLabs or Cartesia voice the founder likes,
make the video use it (`VIDEO_TAVUS_TTS_ENGINE` + `VIDEO_TAVUS_EXTERNAL_VOICE_ID`),
listen on video, then give the phone the same voice (ElevenLabs: the agent's
voice; Cartesia: option (a) settings). The founder prefers the current video
voice, so (b) should only be taken after the probe confirms it is a Tavus Voice.

## What was built

**Option (a) — Cartesia for the phone and the voice button.**
`src/lib/providers/tts-cartesia.ts` streams `POST https://api.cartesia.ai/tts/bytes`
(`Authorization: Bearer`, `Cartesia-Version: 2026-08-14`, `model_id` default
`sonic-3.6`, `voice.id`, `language`, `output_format`, `generation_config.speed`
— https://docs.cartesia.ai/api-reference/tts/bytes). The phone gets `pcm_mulaw`
at 8 kHz straight from Cartesia (no transcoding); the browser gets `pcm_s16le`
at 16 kHz. `speak()` dispatches on `engine`; every ElevenLabs request and clip
cache key is byte-for-byte what it was.

`src/lib/providers/voice-choice.ts` decides per venue:

- off unless `FLAG_VOICE_UNIFY=on` **and** `CARTESIA_API_KEY` **and** a
  well-formed `VOICE_UNIFY_VOICE_ID` — otherwise nothing changes anywhere;
- Belline's own venue (plus `VOICE_UNIFY_VENUES`) then speaks
  `VOICE_UNIFY_VOICE_ID` on Cartesia;
- a venue with `agent.voiceEngine: "cartesia"` speaks its own `voiceId` on
  Cartesia, and falls back to the house ElevenLabs voice if Cartesia is not
  usable (never a silent call); `voiceEngine: "elevenlabs"` is never moved.

**Option (b) — the video face on an ElevenLabs/Cartesia voice.**
`VIDEO_TAVUS_TTS_ENGINE=elevenlabs|cartesia` + `VIDEO_TAVUS_EXTERNAL_VOICE_ID`
put `layers.tts: { tts_engine, external_voice_id }` on Belline's PALs (public
voices only; no provider key is sent to Tavus). A shared PAL is remade
automatically when this changes.

## Latency on phone calls

ElevenLabs flash measured 340–350 ms to first audio (tts.ts). Cartesia's Sonic
models are marketed as low-latency streaming, but **nothing is measured here**:
measure with a real key before switching a live phone line, e.g. ten greetings
and ten mid-call sentences each, compared with `npm run bench:voice`. Expected
impact: comparable; one fewer vendor hop than transcoding because μ-law comes
back natively. The greeting and acknowledgement clip caches work unchanged.

## Known gaps

- Cartesia characters are not metered on Belline's rate card (the ElevenLabs
  meter prices credits); visible in Cartesia's dashboard.
- The dashboard's "Hear it" preview still speaks ElevenLabs.
- `check:voice-unify` covers all of the above with stubbed fetches.
