# Video receptionist (Tavus) — prototype

A third way to reach a venue's receptionist from a website, beside Chat and
Voice: a real-time talking face. Tavus supplies the face, the ears and the
mouth; **Belline stays the receptionist** — the prompt, knowledge, tools,
bookings, leads, handover, call record, usage and tenancy are the same ones
the bell and the telephone use.

- Plan and decisions: [`plan.md`](plan.md)
- What the Tavus docs say, with links: [`tavus-notes.md`](tavus-notes.md)
- Privacy points to settle before customers: [`privacy-review.md`](privacy-review.md)

Off everywhere by default. Hidden in production until approved.

## How it works

**The greeting bubble.** When video is on for a venue, a round bubble opens on
page load at the top of the launcher stack (`public/embed-video.js`, loaded
by `embed.js` / `site.js` only when the widget config says `video: true`).
It plays the venue's short greeting clip **muted, looping, inline**, loaded
after first paint over a poster, captioned *"Hi, I'm Belle, the AI concierge.
Tap to talk."*, with an "AI concierge" label. Reduced motion or Data Saver: the
poster, no video. No clip: a lettered placeholder (plus "MOCK — not a live
avatar" in mock mode). **Nothing live exists yet**: no session, no microphone,
no Daily. A tap on the bubble or "Talk to Belle" **unmutes that same clip and
plays it from the top as Belle's opening words** — out of the tap itself, which
is the only gesture a phone will give sound to — and opens the round call view
(`/embed/<key>/video?autostart=1`) underneath, which asks for the microphone
and creates the Tavus session while she is still talking. The live face fades
in over her last word, and the live session does not say hello a second time.
All of that is [The greeting clip](#the-greeting-clip); without a clip it is
what it always was — a silent wait and a live greeting. The resting bubble is the call circle's own
size on every fresh load (about 320px, 240px on a phone), with "Talk to Belle"
and round chat and WhatsApp icons under it (no voice icon: on the web, voice
is the face). Only the × shrinks it to a small face, for the tab's session
(sessionStorage); ending a call does not. Closing during a call posts an end
to the frame, then removes it; the frame's unload beacon is the backstop. On a
phone, scrolling or tapping outside during a call tucks the same frame into a
small draggable face in a corner (CSS only, so the call never reloads); a tap
grows it back.

```
visitor ─ embed.js / site.js ─ embed-video.js bubble (muted clip, no session)
   tap ─► iframe /embed/<key>/video?autostart=1 ─ VideoPanel
   microphone ─► POST /api/video/<key>/session ─► Tavus: PAL + conversation
   panel joins the Daily room (daily-js, loaded on Start) ◄── room URL + meeting token
   Tavus ─► POST /api/video/llm/chat/completions (SSE) ─► Belline's receptionist
   Tavus ─► POST /api/video/webhook/tavus?t=… (joined, shutdown, transcript)
   End / close / unload ─► POST /api/video/<key>/session/end (beacon) ─► Tavus end + PAL delete
```

**Architecture: Belline as Tavus's LLM.** Tavus's custom LLM layer calls an
OpenAI-compatible `/chat/completions` endpoint with SSE
([docs](https://docs.tavus.io/sections/conversational-video-interface/pal/llm)).
The docs do not document a conversation id in that request, and a
conversation cannot override the PAL's LLM settings, but they recommend a PAL
per session to vary the LLM backend
([docs](https://docs.tavus.io/sections/onboarding-guide/pal-strategies)). By
default each venue and face has one reusable PAL whose `layers.llm.api_key` is
a key derived for that venue and face, and each conversation carries an HMAC
session token in `conversational_context`; the route takes the token only from
a system message and refuses unless key, token and session name the same
venue. `VIDEO_TAVUS_PAL_MODE=per_session` makes a short-lived PAL per call
instead, its `api_key` the token, deleted when the call ends. Inside the route: authority rules →
`AgentSession` (channel `video`) → per-clause honesty guards → spoken-language
layer → SSE. Time to first token is recorded per turn.

## Files

| Path | What |
|---|---|
| `src/lib/video/types.ts` | `VideoAvatarProvider` contract, capability flags |
| `src/lib/video/tavus.ts` | Tavus implementation (PAL, conversation, end, webhook mapping) |
| `src/lib/video/mock.ts` | Mock provider; refused in production / next to a real DB |
| `src/lib/video/provider.ts` | Picks the provider from `VIDEO_AVATAR_PROVIDER` |
| `src/lib/video/config.ts` | Env vars (names only ever leave it) |
| `src/lib/video/tokens.ts` | `llm` / `webhook` / `client` tokens |
| `src/lib/video/control.ts` | Kill switch and venue list in `DATA_DIR/video.json` |
| `src/lib/video/availability.ts` | Flag, config, kill switch, list, widget, live, plan, daily ceiling |
| `src/lib/video/sessions.ts` | Single-flight create, timers, idempotent end, handover, metering |
| `src/lib/video/engine.ts` | The model route: auth, authority, turn, guards, SSE |
| `src/lib/video/stub-agent.ts` | Scripted receptionist for the mock under stubs |
| `src/lib/video/metrics.ts` | Timings to the event table and an in-memory list |
| `src/lib/video/client/machine.ts` | Panel state machine, Tavus event mapping (pure) |
| `src/lib/video/client/calls.ts` | Daily call (lazy `daily-js`) and mock call adapters |
| `public/embed-video.js` | The greeting bubble and the call frame it opens (no SDK, no session) |
| `scripts/video-greeting-clip.ts` | Owner-run: generates the greeting clip with Tavus (`npm run video:clip`) |
| `src/lib/video/greeting-clip.ts` | The clip's script, the handover lead, and the greeting it leaves for the live session |
| `src/lib/video/client/greeting.ts` | Playing the clip from the tap, and reporting honestly whether it was heard |
| `public/video/greeting-*.mp4`, `.jpg` | The clip and its poster, committed and served from our own origin |
| `src/app/embed/[key]/video/` | The round call view page and `VideoPanel.tsx` |
| `src/app/api/video/…` | session start/end/handover, event, mock relay, webhook, LLM |
| `src/app/(internal)/sales/video/`, `src/app/api/sales/video/` | Staff console |
| `public/embed.js`, `public/site.js`, `public/site.css` | Launcher hooks |
| `src/lib/agent/prompt.ts`, `runtime.ts`, `tools.ts` | `"video"` channel |
| `src/lib/flags.ts` | `video.avatar` |
| `scripts/check-video.ts`, `playwright.video.config.ts`, `tests-video/` | Tests |

**Dependency added:** `@daily-co/daily-js@0.92.2` (exact), imported only
inside `createTavusCall`.

**Migration:** none. `Call.video` is an optional field on the JSON store;
`video.json` is created on first write.

## Environment

All placeholders are in `.env.example`.

| Variable | Required | Meaning |
|---|---|---|
| `FLAG_VIDEO_AVATAR=on` | yes | Explicit switch (the flag also needs the three below unless mock) |
| `TAVUS_API_KEY` | tavus | PAL Maker → API Key. Server only |
| `TAVUS_FACE_ID` | tavus | Stock face, Tavus `face_id` (formerly `replica_id`). Prototype: **`rf90eb925bd8`** |
| `VIDEO_LLM_SECRET` | tavus | 40+ random chars; signs session tokens |
| `TAVUS_PAL_ID` | optional | PAL (formerly persona) whose `tts`/`stt`/`conversational_flow` each session copies; required in shared mode |
| `VIDEO_AVATAR_PROVIDER` | optional | `tavus` (default) or `mock` |
| `VIDEO_AVATAR_VENUES` | optional | Comma-separated venue ids allowed by env (the console can add/remove) |
| `VIDEO_PUBLIC_ORIGIN` | optional | Where Tavus reaches the app; defaults to `PUBLIC_ORIGIN`; must be https |
| `VIDEO_MAX_CALL_SECONDS` | optional | Default 300 (30–1800) |
| `VIDEO_WARN_BEFORE_SECONDS` | optional | Default 30 |
| `VIDEO_JOIN_TIMEOUT_SECONDS` | optional | Default 60; also Tavus `participant_absent_timeout` |
| `VIDEO_MAX_SESSIONS_PER_DAY` | optional | Website sessions a day per customer venue, default 20 |
| `VIDEO_MAX_SESSIONS_PER_DAY_BELLINE` | optional | Website sessions a day on Belline's own venue (`loc_belline`, the homepage bubble), default 300 |
| `VIDEO_DEMO_MAX_SESSIONS_PER_DAY` | optional | Personalised demo-link sessions a day, all links together, default 200. Never counted against a venue's website ceiling; each link also has `VIDEO_DEMO_SESSIONS_PER_DAY` (3) |
| `VIDEO_SUPPORT_MAX_SESSIONS_PER_DAY` | optional | Owners talking to Belle on video from the dashboard's Ask Belle, default 100 (1–5000). Run on Belline's own venue (`loc_belline`) and paid from Belline's support budget: counted apart from its website and demo sessions, never against the customer's allowance. A session starts only when the owner presses Start. |
| `VIDEO_MAX_CONCURRENT_PER_VENUE` | optional | Default 2 |
| `VIDEO_TAVUS_PAL_MODE` | optional | `shared` (default: one PAL per venue and face, made and kept by Belline, pre-warmed) or `per_session` (a PAL per call; the rollback) |
| `VIDEO_FAST_MODEL` | optional | Video small talk on this model first, any tool turn on the venue's model. Default `claude-haiku-4-5`; `off` disables |
| `VIDEO_TAVUS_TTS_ENGINE`, `VIDEO_TAVUS_EXTERNAL_VOICE_ID` | optional | Voice option (b): a public ElevenLabs/Cartesia voice on the face ([voice.md](voice.md)) |
| `FLAG_VOICE_UNIFY`, `CARTESIA_API_KEY`, `VOICE_UNIFY_VOICE_ID`, `VOICE_UNIFY_VENUES`, `CARTESIA_MODEL_ID` | optional | Voice option (a): the phone and voice button speak the video voice on Cartesia ([voice.md](voice.md)) |
| `VIDEO_TAVUS_SPECULATIVE` | optional | `on` enables Tavus `speculative_inference` (off: a half-heard sentence must not run a booking) |
| `VIDEO_TAVUS_TEST_MODE` | optional | `on`: free, unjoinable conversations — credential check only |
| `VIDEO_TAVUS_DELETE_AFTER_END` | optional | `on`: hard-delete each conversation at Tavus when it ends |
| `VIDEO_GREETING_CLIP_URL` | optional | Belle's greeting clip (https, or a path on the app). **Unset: the one we ship**, `/video/greeting-rf90eb925bd8.mp4`. Per venue: `greetingClipUrl` in `video.json` |
| `VIDEO_GREETING_POSTER_URL` | optional | Its poster image (shown first, and instead of the clip under reduced motion / Data Saver). Unset: `/video/greeting-rf90eb925bd8.jpg` |

Missing credentials disable video quietly: no button, and the panel page and
session route answer with a readable refusal plus Chat and Voice.

## Tavus dashboard — exact steps

1. **Account.** Sign in to the PAL Maker at https://maker.tavus.io/dev
   ([auth docs](https://docs.tavus.io/api-reference/authentication)).
2. **API key.** PAL Maker → **API Key** → **Create New Key**, name it
   `belline-staging`, optionally restrict to Railway's egress IPs → copy it into
   Railway staging as **`TAVUS_API_KEY`**.
3. **Stock face.** Faces → Stock. The founder chose **`rf90eb925bd8`**. Put it in
   **`TAVUS_FACE_ID`**. (Any `r…` stock id works; never a personal replica.)
4. **Template PAL (recommended, for the voice).** PALs → Create:
   - name `belline-template`, pipeline mode **full**, default face `rf90eb925bd8`;
   - pick the **voice** (TTS) and turn-taking you like; leave perception **off**;
   - **LLM:** custom — model `belline-receptionist`, base URL
     `https://<staging app host>/api/video/llm` (no `/chat/completions`), API key
     any placeholder (per-session PALs replace it).
   Copy the PAL id (`p…`) into **`TAVUS_PAL_ID`**. Belline copies its `tts`,
   `stt` and `conversational_flow` into each per-session PAL and sets its own
   `llm` (api_key = the session token) and `perception: off`.
5. **Webhook.** Nothing to set in the dashboard: each conversation carries its own
   `callback_url` = `https://<app host>/api/video/webhook/tavus?t=<session token>`.
6. **Secret.** Generate 48 random characters for **`VIDEO_LLM_SECRET`**.
7. **Shared PALs** need nothing in the dashboard: Belline makes one PAL per
   venue and face (`belline-venue-<venue id>`) at boot and when a venue is
   allowed, with its own derived key. Leave them; replaced ones are deleted
   automatically after the longest possible call.
8. **Greeting clip — already done for `rf90eb925bd8`.** The clip and its poster
   are committed in `public/video/` and are the default, so there is nothing to
   set. Only a deployment on a *different* face needs a new pair: from a machine
   with the key,
   `node --import tsx --env-file=.env scripts/video-greeting-clip.ts --agent Belle --business Belline --yes --download public/video --script "<GREETING_CLIP_SCRIPT>"`.
   It calls `POST /v2/videos` with `replica_id` = the face, polls `GET /v2/videos/{id}`
   until `ready`, and saves the mp4 and a thumbnail. Then re-encode small and point
   `VIDEO_GREETING_CLIP_URL` / `VIDEO_GREETING_POSTER_URL` at the result. See
   [The greeting clip](#the-greeting-clip) for the script, the poster and the sizes.
9. **Optional credential check:** `VIDEO_TAVUS_TEST_MODE=on` for one start — Tavus
   creates a free conversation you cannot join; turn it off again.

## Faster start, faster replies, one voice, a branded background (17 September 2026)

- **Start:** a venue's shared PAL is reused, so a start is one `POST
  /v2/conversations` instead of GET template + POST PAL + POST conversation
  (and a DELETE at the end). Recorded as `session_create_ms` with `detail`
  `shared_warm` / `shared_cold` / `per_session`. Security and the fallback:
  [tavus-notes.md](tavus-notes.md#custom-llm).
- **Replies:** Haiku 4.5 answers first; the moment it reaches for a tool the
  venue's model runs that turn (`src/lib/video/model-policy.ts`). A venue
  already on Haiku (Belline's own seed venue) is unchanged.
- **Voice:** [voice.md](voice.md).
- **Face and background:** Your business → Agent → *Video face and
  background*. Backgrounds need a Phoenix-4 face (Tavus cannot green-screen
  Phoenix-4.5; the default `rf90eb925bd8` is Phoenix-4.5, its Phoenix-4 twin is
  `rcc28da86847`). The panel keys the green in WebGL and falls back to the
  plain stream when it cannot. Regenerate the pictures with
  `node --import tsx scripts/build-video-backgrounds.ts`.

## The greeting clip

**The problem.** A live session takes several seconds to exist: a conversation
at Tavus, a Daily room, a replica joining it. Measured on staging, 18 September
2026, from the tap to Belle's first word: **8.9 s at 1280, 9.4 s at 390.** All
of it silent. The founder called it the worst part of the experience, and he
was right — nothing on the screen was broken, there was simply nobody there.

**The fix.** A 5.6-second clip of the same face (`rf90eb925bd8`), pre-rendered
once with Tavus's video generation API, served from `public/video/`, and played
**out of the visitor's own tap** while the live session connects underneath.
Tap-to-first-word becomes the time it takes a buffered video element to unmute:
**about 30 ms at both widths.**

### What she says, and why it is that

> Hi, I'm Belle. I'm an AI, not a person. Give me a moment to come online, and
> then I'm listening.

One file plays on three surfaces — a venue's website bubble, the dashboard's
Ask Belle, and a prospect's personalised demo page — so every word has to be
true on all three. That rules out more than it looks. **No business name:** on
a customer's site Belle works for them, on the demo page she is Belline's.
**No role noun:** "concierge" on the website, "assistant" in the dashboard,
"receptionist" on the demo page — "an AI" is the only one true everywhere, and
the honest one. **No promise:** the live Belle differs by surface and by venue,
so the clip promises only the thing it can keep, which is that she is coming.
The words live in `src/lib/video/greeting-clip.ts` as `GREETING_CLIP_SCRIPT`
and are pinned in `check:video`.

### One greeting, not two

The clip says hello, so the live session must not. When — and only when — the
browser reports the clip really played, the session POST carries `greeted:
true`, and `greetingAfterClip` drops the greeting's leading self-introduction
and keeps everything after it:

| Greeting | Becomes |
|---|---|
| `Hi, I'm Belle, the AI concierge for Azure Spa. How may I help you today?` | `How may I help you today?` |
| `Hi, I'm Belle, Belline's AI assistant. I can see your account — …` | `I can see your account — …` |
| `Hi Sam, I'm Belle, Belline's AI receptionist. I had a look at …` | `I had a look at …` |

Dropping only the hello is what lets a demo link keep every word of the
research it was written from, and a venue keep its own opening line. `greeted`
is a boolean and nothing else: **the browser can shorten the opening, never
write it.**

### The handover

`call.join()` is the moment the live Belle starts talking, because Tavus speaks
`custom_greeting` once somebody is in the room. So the join is what we hold.
It fires `HANDOVER_LEAD_MS` (1.2 s) before the clip's last frame, which spends
the room's connect time under her closing words instead of in the silence after
them. The live face is revealed on `liveFaceOn = faceVisible && !greetingSpeaking`
— both halves matter — and the two cross-fade over 400 ms. Same face, same
chair, so it reads as one person rather than a cut. The clip's poster is its own
final frame, which is also the frame it holds while waiting, so there is nothing
to flash.

### Mobile Safari, and why the bubble is different

A browser grants sound only to the handler the tap is still inside. On the
website bubble the tap happens in the **venue's page**, and the call frame is
cross-origin, so the frame cannot borrow that gesture — this is the old "Tap to
hear Belle" second tap. So the bubble plays the clip itself
(`public/embed-video.js` `speakGreeting`), puts its length in the frame's URL
(`&greeting=<ms>`, needed before the frame's first render), and posts
`greeting_ended` / `greeting_failed` afterwards. The panel's own surfaces — Ask
Belle and the demo page — have their tap inside the frame and play it
themselves. The element is `playsInline` and starts life `muted` + `autoplay`,
so it is decoded and buffered long before anybody taps.

### Falling back

Every one of these leaves `greeted` false, the greeting whole, and the call
exactly as it was before clips existed:

- no clip configured, or the file 404s;
- the clip is the provider's stock face preview rather than one of ours
  (`videoBubbleConfig.greets` is false — that file is silent, and unmuting it
  would greet the visitor with nothing *and* cost them the live hello);
- `play()` is refused, or takes longer than `PLAY_TIMEOUT_MS` (400 ms);
- reduced motion or Data Saver: the clip is hidden, and she does not speak from
  a face nobody can see;
- the page around the bubble says `greeting_failed` within `HOST_CONFIRM_MS`
  (250 ms), which the frame waits out before believing the URL.

### Files

| Path | What |
|---|---|
| `src/lib/video/greeting-clip.ts` | The script, the lead time, and `greetingAfterClip` |
| `src/lib/video/client/greeting.ts` | Playing it from the tap, and knowing honestly whether it was heard |
| `public/video/greeting-rf90eb925bd8.mp4` | 640×360, 5.6 s, 106 KB, faststart, AAC mono |
| `public/video/greeting-rf90eb925bd8.jpg` | Its final frame, 17 KB |
| `tests-video/greeting-clip.spec.ts` | The join, in a browser, at both widths |

## Go-live checklist

- [x] **Greeting clip** — generated, re-encoded to 106 KB, committed, and the
      default (18 September 2026). Still to do by hand: watch the handover on a
      real iPhone and a mid-range Android, listening for a double hello and
      looking for a seam ([The greeting clip](#the-greeting-clip)).
- [ ] Shared PAL mode verified on staging (the model route logs no
      "carried no session token" line; `session_create_ms` shows `shared_warm`).
- [ ] Voice probe run and the voice decision taken ([voice.md](voice.md)).
- [ ] A Phoenix-4 face chosen if the branded background is wanted, and watched
      on an iPhone and a mid-range Android (keyed, or cleanly the plain stream).
- [ ] The owner test script below, end to end.

## Local testing (mock, no keys)

```powershell
$env:DATABASE_URL = $null
node --import tsx scripts/check-video.ts                       # 29 cases
npx playwright test --config playwright.video.config.ts        # panel e2e, mock
```

The Playwright config starts the stubbed server on port 3127 with
`FLAG_STUBS=on`, `FLAG_VIDEO_AVATAR=on`, `VIDEO_AVATAR_PROVIDER=mock` and
`VIDEO_AVATAR_VENUES=loc_belline`. Set `VIDEO_SHOTS_DIR` to save screenshots.
The mock panel says **"MOCK — not a live avatar"** and lets you type what you
would say; replies go through the real model route and tools (a scripted
receptionist stands in for the model).

### This harness builds first, and must stay that way

Unlike the other Playwright configs, `playwright.video.config.ts` runs
`next build` and serves it with `--prod`. That costs a build per run; it buys a
suite that tests what a customer actually gets. Do not switch it back to dev to
save the minutes.

The reason is a latent fragility worth knowing about on its own:
`src/app/embed/[key]/video/page.tsx` re-derives `framedBy` from the `Origin` /
`Referer` header **on every render**, and refuses the page when that origin is
not on the venue's allowlist. On the initial framing navigation the Referer is
the embedding site, so it passes. But a *re-render* of the same page carries
the page's own Referer — this app's origin, not the embedding site's — so the
check refuses a page it had already allowed, and a live call is replaced by
"This page can only be opened from the website it belongs to".

In dev, Next's HMR does exactly that: an RSC re-render arrives with `rsc: 1`
and `Referer: <this app>/embed/…`, and the call dies mid-test. In a built app
nothing re-fetches this route — no router link, no `router.refresh()` — so it
cannot happen in production today.

**If any embed surface ever gains a router refresh, a client-side link, or
anything else that re-renders it, this becomes a real bug.** The fix then is a
proof-of-grant token: the granted render mints a short-lived signed token bound
to the embed key and the verified framing origin, the client puts it in the URL
(`history.replaceState`), and a re-render accepts that token instead of
re-reading the Referer. A refused render mints nothing, so a refused page
cannot refresh its way into a granted one.

Do **not** "fix" it by trusting the `o` query parameter, or by skipping the
check for same-origin requests: both let a site that was refused reload itself
into an allowed one, which is the whole thing the allowlist prevents.
`src/app/embed/[key]/chat/page.tsx` checks the same way and has the same
property.

## Staging (Railway)

The main session deploys. For reference, from a directory linked to the
project: `railway up --service belline --environment staging --ci`.

Set on the `belline` service, staging environment: `FLAG_VIDEO_AVATAR=on`,
`TAVUS_API_KEY`, `TAVUS_FACE_ID=rf90eb925bd8`, `TAVUS_PAL_ID` (if made),
`VIDEO_LLM_SECRET`, `VIDEO_AVATAR_VENUES=loc_belline`, and check that
`PUBLIC_ORIGIN` (or `VIDEO_PUBLIC_ORIGIN`) is the staging https host Tavus can
reach. Do **not** set `VIDEO_AVATAR_PROVIDER=mock` on Railway — it is refused
in production mode anyway.

## Switching it on and off

- **Flag:** `FLAG_VIDEO_AVATAR=on` / `off` (needs a restart).
- **Venue list:** `VIDEO_AVATAR_VENUES`, or **Sales console → Video → Allow
  video / Remove** (instant, stored in `DATA_DIR/video.json`; a console
  removal beats the env list).
- **Kill switch:** **Sales console → Video → Turn video off everywhere now**.
  Instant for new sessions; live calls hear a short goodbye and end. The
  widget's public config is cached up to 60 s, so the button can linger that
  long — pressing it is refused.
- **Production:** leave `FLAG_VIDEO_AVATAR` unset until approved.

## Usage and metering

A video call is a `Call` with `channel: "embed"` and `video: {…}`, so it is
billed as **web-voice minutes** by the existing `billableVoiceMinutes` (plans,
prices and allowances unchanged). Calls on Belline's own or demo venues are
`isDemo` and never billed. Video has its own daily ceiling and does not use up
the bell's. Tavus's own cost is not priced on Belline's rate card (the docs
publish no rates); it is visible in Tavus's dashboard.

Because it is web voice, everything that limits the bell limits video too:
the plan must include the voice button, and `serviceState` applies the trial's
minutes (counted across accounts that share the business's website, phone or
card), a trial staff have suspended, and the owner's usage policy. The trial
clock itself starts at Go live, as for every channel.

**The abuse gate.** Before Go live only a signed-in owner can open the panel,
so a session then is the owner's own preview: paid Tavus time at their
request. `/api/video/<key>/session` holds it to `paidWorkRefusal`, as the test
console is held — email confirmed, trial not suspended. A visitor on a live
venue's website is not owner work and is not asked; the plan, the caps above
and video's own daily and concurrent ceilings bound it instead.

## Timings and events

Server: `session_create_started`, `session_created` (ms), `session_create_failed`,
`llm_first_token` (ms), `booking_or_lead`, `handover_requested`, `ended` (duration).
Panel: `video_selected`, `mic_prompted`, `mic_denied`, `ready` (ms), `first_frame`
(ms), `first_response` (ms), `reconnecting`, `fallback_chat`, `fallback_voice`,
`client_error`. Written to the event table as `video.*` where Postgres is
configured, and shown as medians in the sales console.

## Known limitations

- **Unverified against a live Tavus account:** how Tavus sends `api_key`
  (Bearer assumed; `x-api-key`/`api-key` also accepted), and the body it sends.
  First item of the owner test script.
- English only on video. German venues get `policy: "eu"` but the video prompt
  and greeting are English.
- No typed input in a live Tavus call; the mock panel types instead of speaking.
- No booking form beside the video: the widget has none to reuse, so the face
  collects and reads back details conversationally.
- Captions come from Tavus utterance events; Daily `transcription-message` is
  not wired.
- Switching to chat does not carry the video transcript into the chat thread
  (it is in the call record in the dashboard).
- Sessions live in one process; a restart ends them (as for voice calls).
- Speculative inference is off, which costs some latency.
- Perception and camera are not built (by design for the prototype).
- The greeting clip is a pre-rendered video, not the live avatar; the live face
  appears only after it has finished ([The greeting clip](#the-greeting-clip)).
  Her *greeting* is audible from the tap, in the host page, so it does not need
  the second tap. The live face's own voice still can: "Tap to hear Belle"
  remains for the conversation after the greeting, because that audio plays in
  the frame and the tap happened outside it.
- The clip is English, and one file for every venue and language, so a German
  venue hears an English hello before a live greeting that is also English
  (video is English-only anyway, above).
- The clip is fixed at the length it was rendered, so a session that connects
  faster than 5.6 s still waits for her to finish. Hearing her is better than
  watching her, but it is a floor on the total, not only on the silence.
- The widget config is cached up to 60 s, so turning video off can leave a
  bubble visible for a minute; a tap then gets a readable refusal, not a session.

## Owner test script (staging, 20 minutes)

1. **Wiring.** Sales console → Video: flag on, provider `tavus`, no missing
   config, `loc_belline` listed. (If the model route logs 401s, Tavus is not
   sending the token as Bearer — tell engineering.)
2. **Bubble on load.** Open belline.ai staging in a fresh private window: the
   round bubble greets above the buttons with the muted clip (or poster) and
   the caption. Nothing to hear yet. In Tavus's dashboard, **no new
   conversation** has appeared from loading the page; reload a few times: still
   none. Check it lines up with WhatsApp / Write / Speak and nothing overlaps.
3. **Dismiss.** Press ×: gone, and a Video button takes its place; open another
   page on the site: no bubble. The Video button brings it back.
4. **Start.** Tap the bubble → the round call view → allow the mic. Time to a
   live face and the greeting ("Hi, I'm Belle, the AI concierge for Belline…").
   Console shows *Room created*, *First frame*, *First words*. Press × mid-call
   once: the Tavus conversation ends within seconds.
5. **Visual realism and lip-sync.** Watch the mouth on long sentences, numbers
   and names. Note any drift or frozen frames.
6. **Latency.** Ask five short questions; count seconds from when you stop
   speaking to the first word. Compare with the console's *Model: first words*.
7. **Interruptions.** Talk over Belle mid-sentence twice. She should stop and
   answer the new thing without repeating herself.
8. **FAQ accuracy.** Ask the price, the trial, what Belline does, and one thing
   not in its knowledge — she must say she doesn't know and offer a person.
9. **Honesty.** Ask "Are you a real person?" — she must say she is an AI.
10. **Booking/lead behaviour.** Say you run a salon, give a name and email. She
   should read details back and confirm before saving; check Sales → Enquiries
   for the lead.
11. **Talk to a person.** Press the button: Belle asks for details; the call
   appears for follow-up.
12. **Limits.** Stay on until the warning banner, then the automatic end.
13. **Mobile.** iPhone Safari and Android Chrome: the bubble (~128px) clear of the
    buttons and the home bar; tap it (note whether sound needed "Tap to hear Belle"), mute, rotate to landscape, lock the phone for 10 s,
    end. No horizontal scrolling; buttons clear of the browser bars.
14. **Kill switch.** During a call press *Turn video off everywhere now*: the call
    ends politely within a turn and the button disappears within a minute.
15. **Tavus dashboard.** No leftover `belline-vs_*` PALs; conversations ended.
