# Tavus CVI — what the docs actually say

Read on 17 September 2026 from docs.tavus.io (raw pages and the OpenAPI
contract at https://docs.tavus.io/openapi.yaml). No Tavus API was called while
writing this. Anything marked **not documented** was looked for and not found;
the code treats those points as assumptions and the owner test script in
`README.md` checks each of them on staging.

## Naming

Tavus renamed **replica → face** and **persona → PAL**. The old names are still
accepted: "`/v2/personas`, `/v2/replicas`, `persona_id`, `replica_id`, and
related aliases" remain supported.
— https://docs.tavus.io/api-reference/overview ·
https://docs.tavus.io/api-reference/faces/list-faces

Belline uses the current names everywhere: `face_id`, `pal_id`, and the env
vars `TAVUS_FACE_ID` / `TAVUS_PAL_ID`. A stock face id such as
`rf90eb925bd8` (the founder's pick) goes in **`face_id`** — the docs' own
examples put `r…` ids there (`"face_id": "rc9cff32ceba"`).
— https://docs.tavus.io/api-reference/authentication

## Create conversation

`POST https://tavusapi.com/v2/conversations`, header `x-api-key`.
— https://docs.tavus.io/api-reference/conversations/create-conversation

| Field | Notes |
|---|---|
| `face_id` | Required unless the PAL has a default face; a request value overrides the PAL's. |
| `pal_id` | The PAL. |
| `conversation_name`, `callback_url` | As expected. |
| `conversational_context` | "Optional context that will be appended to any context provided in the PAL". Where it lands in a custom LLM request is **not documented**. |
| `custom_greeting` | Per conversation. PALs have no greeting field. |
| `require_auth` | Returns `meeting_token`; token lifetime = `participant_absent_timeout`. — https://docs.tavus.io/sections/conversational-video-interface/conversation/customizations/private-rooms |
| `test_mode` | "without incurring any costs"; created as `ended`, does not count toward concurrency. |
| `policy` | Enum `eu`. |
| `audio_only` | Voice-only conversation. |
| `max_participants` | Top level, min 2, the PAL counts as one. |
| `properties.max_call_duration` | Seconds, default 3600, silently capped at the plan maximum. — https://docs.tavus.io/sections/conversational-video-interface/conversation/customizations/call-duration-and-timeout |
| `properties.participant_left_timeout` | Seconds after the last participant leaves; default 0. |
| `properties.participant_absent_timeout` | API reference: from creation, if nobody joins, default 300. The timeout page's example reads differently (inactivity while present). **The docs contradict each other**; Belline treats it as "nobody joined" and also enforces its own server-side timers. |
| `properties.enable_recording` | Recording; Belline never sets it. |
| `properties.enable_closed_captions` | Captions are shown in-call; delivered through Daily transcription, there is no Tavus caption event. — https://docs.tavus.io/sections/conversational-video-interface/conversation/customizations/closed-captions |
| `properties.languages` | Array of codes; `language` is deprecated. |
| `properties.apply_greenscreen` | Resolves to false on Phoenix-4.5 faces. |
| `properties.recording_storage` | Replaces the deprecated S3 fields. |

Response: `conversation_id`, `conversation_name`, `conversation_url`
(a Daily room such as `https://tavus.daily.co/c123456`), `status`
(`active`/`ended`), `callback_url`, `created_at`, `meeting_token` (only with
`require_auth`). Errors: 400 with `error` or `message` (e.g. "User has reached
maximum concurrent conversations"), 401 "Invalid access token".

## End and delete

- **End:** `POST /v2/conversations/{conversation_id}/end`, no body. "For normal
  call cleanup when a user leaves or a session is finished." Produces
  `system.shutdown` with reason `end_conversation_endpoint_hit`.
  — https://docs.tavus.io/api-reference/conversations/end-conversation
- **Delete:** `DELETE /v2/conversations/{conversation_id}?hard=true` hard-deletes
  "the conversation and associated assets" (not itemised). The changelog frames
  it as the GDPR tool. — https://docs.tavus.io/api-reference/conversations/delete-conversation ·
  https://docs.tavus.io/sections/changelog/changelog
- **Get:** `GET /v2/conversations/{id}?verbose=true` returns the same events as
  the webhooks.

## Webhooks (`callback_url`)

— https://docs.tavus.io/sections/webhooks-and-callbacks

Envelope: `{ properties, conversation_id, webhook_url, event_type,
message_type ("system"|"application"), timestamp }`.

- `system.pal_joined` (`properties.face_id`), plus the legacy duplicate
  `system.replica_joined` with an identical payload. Deduplicate.
- `system.shutdown` (`properties.shutdown_reason`): `max_call_duration reached`,
  `participant_left_timeout reached`, `participant_absent_timeout reached`,
  `bot_could_not_join_meeting_it_was_probably_ended`,
  `daily_room_has_been_deleted`, `exception_encountered_during_conversation_startup`,
  `end_conversation_endpoint_hit`, `internal error occurred at step x`.
- `application.transcription_ready` (`properties.transcript[]`: `role`,
  `content`, `timestamp`, `seconds_from_start`, `duration`, `inference_id`).
- `application.recording_ready`, `application.recording_copy_failed`,
  `application.perception_analysis`, `application.post_call_action_executed`.

**Signatures: not documented** for conversation webhooks — no header, HMAC,
secret, retry policy or IP list. (HMAC exists only for tool calls delivered to
your API: `X-Tavus-Signature`, HMAC-SHA256 of the raw body —
https://docs.tavus.io/sections/conversational-video-interface/pal/llm-tool-delivery.)
Belline therefore authenticates the webhook itself: each conversation's
`callback_url` carries a per-session HMAC token in its query string, and the
event's `conversation_id` must match the session the token names.

## Custom LLM

— https://docs.tavus.io/sections/conversational-video-interface/pal/llm

- `layers.llm`: `model`, `base_url` ("Do not include route extensions"),
  `api_key`, `speculative_inference` (default true), `headers`, `extra_body`,
  `default_query`, `tools` (legacy; replaced by the tools registry —
  https://docs.tavus.io/sections/conversational-video-interface/pal/tools).
- Must be "Streamable (i.e. via SSE)" and use "the `/chat/completions` endpoint".
- "Performance and intelligence are best when prompts are limited to 5,000
  tokens"; degradation at 15–20k.
- With perception off, "your LLM will not receive any special messages".
- Pipeline modes: a custom LLM "Adds latency due to external processing".
  — https://docs.tavus.io/sections/conversational-video-interface/quickstart/pipeline-modes

**Not documented:** the exact request Tavus sends — how `api_key` is
transmitted (Bearer is conventional for OpenAI-compatible clients; the Create
PAL `headers` example shows `Authorization: Bearer …`), the body fields, and
whether `conversation_id` appears anywhere. There is **no per-conversation
override** of `layers.llm` on Create Conversation. The docs' recommendation for
varying behaviour — including the "LLM backend" — per session is to create a
PAL per session and delete it afterwards.
— https://docs.tavus.io/sections/onboarding-guide/pal-strategies

**Re-read 17 September 2026 for per-conversation headers or metadata:** none.
`layers.llm.headers`, `extra_body` and `default_query` exist but are PAL-level
and static; Create Conversation has no LLM override, header or metadata field
(its body fields are listed above). So a conversation can only be told apart
by what it carries in `conversational_context`.
— https://docs.tavus.io/sections/conversational-video-interface/pal/llm ·
https://docs.tavus.io/api-reference/conversations/create-conversation

**Consequence for Belline — shared PAL per venue and face (default since
17 September 2026, `VIDEO_TAVUS_PAL_MODE=shared`).** The docs describe both
approaches: "keep persistent PALs in Tavus … and reuse them" passing per-session
data through conversational parameters, or create a PAL per session and delete
it afterwards (https://docs.tavus.io/sections/onboarding-guide/pal-strategies).
Belline now reuses one PAL per venue and face:

- the PAL's `layers.llm.api_key` is a static key HMAC-derived from
  `VIDEO_LLM_SECRET`, the venue id and the face id (`tokens.ts venuePalKey`);
- each conversation's `conversational_context` carries
  `belline-session: <signed session token>`;
- the model route reads the token **only from `system` messages**, and accepts
  it only when the key, the token and the live session all name the same venue
  (and the key the session's face). A forged token, a token in the visitor's
  words, and another venue's valid token through this venue's PAL are all 401
  (`check:video` 4c);
- the PAL is kept in `DATA_DIR/video.json` with a hash of the body it was made
  from; a changed face, language, voice, template or secret makes a new one,
  and the old one is deleted only after the longest possible call on it;
- it is made at boot for allowlisted venues and when staff allow a venue, never
  on a page load.

**Still undocumented, so guarded:** where `conversational_context` lands in the
custom LLM request. If a request arrives with a venue key but no token in any
system message, that venue falls back to a PAL per call until restart
(`shared-pal.ts`) and the log says so. `VIDEO_TAVUS_PAL_MODE=per_session`
restores the old behaviour everywhere.

**Leaner create:** `enable_closed_captions` is no longer sent (it turns on
Daily's transcription; the panel's captions come from Tavus's
`conversation.utterance` events) and `apply_greenscreen` is sent only when
`true` (default `false`).

## Create PAL

`POST /v2/pals` — https://docs.tavus.io/api-reference/pals/create-pal

`pal_name`, `system_prompt`, `pipeline_mode` (`full`|`echo`),
`default_face_id` (required), `languages`, `disclosure_type`
(`always`|`auto`|`off`), `verbal_disclosure`, `visual_disclosure`, `layers`
{ `perception`, `stt`, `conversational_flow`, `llm`, `tts`, `conferencing` }.
`context` is deprecated in favour of `system_prompt`. Patch PAL uses JSON
Patch. Delete: `DELETE /v2/pals/{pal_id}`.

## Interactions (Daily app messages)

— https://docs.tavus.io/sections/conversational-video-interface/interactions-protocols/overview
(schemas in the OpenAPI `components.schemas`)

Send with `call.sendAppMessage(obj, '*')`; receive on Daily's `app-message`.
Every Tavus event has `message_type: "conversation"`, `event_type`,
`conversation_id`, `timestamp`, `seq`.

Received:
- `conversation.utterance` — `properties{ role ("pal"|"user"), speech, interrupted, … }`;
  PAL turns also arrive with `role: "replica"`.
- `conversation.utterance.streaming` — accumulated `speech`, `final`, `is_interrupted`.
- `conversation.started_speaking` / `conversation.stopped_speaking` —
  `properties{ role, interrupted?, duration? }` (legacy
  `conversation.replica.*` / `conversation.user.*` still sent).
- `conversation.tool_call`, `conversation.joined` / `conversation.left`,
  `system.pal_joined` (also broadcast in-call —
  https://docs.tavus.io/sections/onboarding-guide/latency-optimization).

Sent:
- `conversation.respond` — `properties{ text }`, treated as the user's words.
- `conversation.echo`, `conversation.interrupt`,
  `conversation.overwrite_llm_context`, `conversation.append_llm_context`,
  `conversation.sensitivity`, `conversation.tool_result`
  (https://docs.tavus.io/sections/event-schemas/conversation-tool-result).

## Perception and camera

`layers.perception.perception_model`: `raven-1` (default), `raven-0` (legacy),
`off` ("disables all perception"). `emotion_recognition`: `full|limited|auto`
(`auto` = `limited` under `policy: eu`).
— https://docs.tavus.io/sections/conversational-video-interface/pal/perception

A camera requirement is **not documented**; `application.perception_unavailable`
fires when "the participant's camera was off", which implies calls work without
one. Belline sets `perception_model: "off"` and joins with the camera off.

## Background (green screen)

- `properties.apply_greenscreen`: "If true, the background will be replaced
  with a greenscreen (RGB values: [0, 255, 155])."
  — https://docs.tavus.io/api-reference/conversations/create-conversation
- "Background customization is not currently available with Phoenix-4.5
  faces"; the page suggests customising the green "on the frontend using
  WebGL". No other background option is documented.
  — https://docs.tavus.io/sections/conversational-video-interface/conversation/customizations/background-customizations
- Belline sends `apply_greenscreen: true` only for a curated Phoenix-4 face with
  a background chosen, and the panel checks the frame's corners for the green
  before keying (a stream without it is shown as it is).

## Faces for the picker

- `GET /v2/faces` query `face_type` (`system` = stock), `face_ids` (comma
  separated), `limit`, `page`, `verbose`, `model_name`; response `data[]` with
  `face_id`, `face_name`, `default_voice_id`, `thumbnail_video_url`, `status`,
  `face_type`, `model_name` (`phoenix-4.5`, `phoenix-4`, `phoenix-3`), and
  `total_count`. — https://docs.tavus.io/api-reference/faces/list-faces ·
  https://docs.tavus.io/api-reference/faces/get-face
- Stock faces have a different id per Phoenix model, e.g. Ruby - Office:
  Phoenix-4 `rcc28da86847`, Phoenix-4.5 `rf90eb925bd8`.
  — https://docs.tavus.io/sections/faces/stock-face-model-map
- `thumbnail_image_url` is not in the documented schema; Belline uses it only
  when present.

## Voices

See [voice.md](voice.md): TTS layer precedence (`external_voice_id` >
`voice_id` > face `default_voice_id`), public ElevenLabs/Cartesia voices need
no key, Tavus Voices are Tavus-managed.
— https://docs.tavus.io/sections/conversational-video-interface/pal/tts ·
https://docs.tavus.io/sections/conversational-video-interface/voices

## Stock faces

"100+ stock faces", `GET /v2/faces?face_type=system`.
— https://docs.tavus.io/sections/faces/stock-faces ·
https://docs.tavus.io/sections/faces/stock-face-model-map

Documented examples: Anna – Casual `rc9cff32ceba`, Luna `rb32069a3012`,
Lucas – Studio `r3f4182ef554`; Phoenix-4.5: Brooke `rc8992fe8e8e`,
Charlie `rbb3ca3630f7`. Rights to a likeness are the customer's responsibility
under Tavus's terms (https://docs.tavus.io/sections/faces/overview). Belline
uses a stock face only; the prototype default is **`rf90eb925bd8`**, chosen by
the founder in the Tavus dashboard.

## Custom UI

— https://docs.tavus.io/sections/integrations/embedding-cvi

iframe ("fastest … for demos"), `@tavus/cvi-ui` (CLI that copies components
and installs `@daily-co/daily-react`, `@daily-co/daily-js`, `jotai`), or
**Daily JS with `createCallObject`** "for … a fully custom in-call UI". Belline
takes the last: one dependency, `@daily-co/daily-js`, lazily loaded.
Mobile web works in iOS Safari and Android Chrome without a native SDK.
— https://docs.tavus.io/sections/conversational-video-interface/mobile

## Privacy, retention, EU

- Recordings only when enabled; storage in your own bucket via
  `recording_storage` (federated identity). A failed copy is kept ~30 days.
  — https://docs.tavus.io/sections/conversational-video-interface/quickstart/conversation-recordings
- Transcript retention period: **not documented**.
- Zero Data Retention: "account-level and programmatic support" (changelog,
  26 June 2026); how to switch it on is **not documented**.
- `policy: "eu"` only flips `auto` PAL fields (disclosure on, emotion
  recognition limited). It does **not** promise EU processing or residency, and
  Tavus "does not geolocate the caller".
  — https://docs.tavus.io/sections/onboarding-guide/eu-ai-act
- FAQ claims SOC 2, GDPR, HIPAA/BAA compliance; a DPA is **not documented**.
  — https://docs.tavus.io/sections/conversational-video-interface/faq

## What costs money

- Live conversations "can count toward billing and concurrency as soon as they
  are created".
  — https://docs.tavus.io/sections/conversational-video-interface/quickstart/build-first-app
- Billed on "active session runtime, not just the amount of time spent actively
  speaking" — idle rooms accrue, so timeouts matter (FAQ).
- `test_mode: true` costs nothing and does not count toward concurrency.
- Faces beyond the plan cost extra. Prices are not in the docs and are not
  hard-coded in Belline.
- Rate limits: **not documented**. Concurrency: only the 400 error text.

### Settled: the account was out of minutes (18 September 2026)

The account was topped up, and one call was run on staging and left alone:

```
[video] vs_1NXG0aNxQhrZ ended after 306s of 300s — time_limit (tavus: client_duration, by timer)
```

**306 seconds, ended by our own ceiling**, not Tavus's. So the 85–88 second
endings below were the month's CVI minutes running out — the one explanation
the section had left open and could not test. Nothing in the code was wrong and
nothing needs changing: `VIDEO_MAX_CALL_SECONDS` is delivered in full, and
`deliveredCeiling` goes back to promising 300 s as soon as the short endings
fall out of its window.

Worth keeping: **a Tavus account out of minutes looks exactly like a plan cap.**
Same `system.shutdown`, same `max_call_duration`, no error, and no endpoint to
ask. `delivery.ts` was the only thing that noticed, and it is still the only
thing that would notice next time.

### What limited a conversation before that top-up (read 18 September 2026)

A founder's call on staging ended at 88 seconds of the 300 we ask for, with
`system.shutdown` and a `shutdown_reason` we map to `max_call_duration`. Other
recent calls ended at 85. Neither of our own ceilings applied. What the docs
say, and what they do not:

- **`max_call_duration` is a request, capped silently.** Default 3600s, no
  published maximum, and a higher value is "automatically capped to your plan's
  maximum" —
  https://docs.tavus.io/sections/conversational-video-interface/conversation/customizations/call-duration-and-timeout
  No error comes back when the cap bites, and the docs never say which
  `shutdown_reason` a plan cap produces.
- **Every published tier allows at least 300s.** The pricing page's "Maximum
  conversation duration" row: Basic (free) 5 min, 25 CVI minutes a month, 1
  concurrent; Starter 5 min, 100, 3; Growth uncapped, 1250, 10
  (https://www.tavus.io/pricing). **So a plan cap cannot explain 88 seconds** —
  300s is legal on the lowest tier there is. Third-party write-ups list
  different tier names and allowances, so that page has been revised recently
  and may not describe the account we were provisioned under.
- **Concurrency is a plan number too, and the same problem.** The same pricing
  row gives Basic 1 concurrent conversation, Starter 3 and Growth 10. Nothing in
  the API says which we are on, and exceeding it is a 400 or 429 whose only
  signal is the words "maximum concurrent conversations" in the message. So it
  is configured rather than discovered: `VIDEO_PROVIDER_MAX_CONCURRENT` (default
  10, the Growth figure) is read off the dashboard by hand, every venue ceiling
  is clamped to it, and the deployment as a whole is held to it. A refusal that
  still comes back from Tavus is therefore evidence that the number is wrong,
  not that we are busy: `lib/video/sessions.ts` returns `provider_busy` rather
  than `busy`, and `lib/video/delivery.ts` raises a `video_provider_at_capacity`
  ticket — beside the `video_calls_cut_short` one, and for the same reason. No
  API will tell us, so the only way to know is to watch what happens.
- **No API reports the plan, the tier or the minutes left.** Every path in
  https://docs.tavus.io/openapi.yaml is lipsync, replacements, videos, faces,
  voices, memory-stores or conversations. `GET /v2/conversations` returns rows
  and a `total_count` and nothing about quota. There is no billing, usage,
  account or limits endpoint, so **a pre-flight quota check cannot be built**
  and the Tavus dashboard is the only place the answer exists.
- **Left unexplained, and therefore watched rather than guessed at:** the
  month's CVI minutes running out mid-call (undocumented behaviour, undocumented
  reason string), and the `participant_absent_timeout` contradiction noted above
  if Tavus implements it as inactivity-while-present. `lib/video/delivery.ts`
  records every ending with the provider's own words and the real duration,
  opens a `video_calls_cut_short` ticket once it is a pattern, and stops the
  pages promising a length we are not delivering.
