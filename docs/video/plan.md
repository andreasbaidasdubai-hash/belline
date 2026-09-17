# Video receptionist — plan

Branch `feat/video-avatar`. A third way in beside Chat and Voice: a real-time
talking face (Tavus CVI on a Daily room) that is **Belline's own receptionist**
underneath. Evidence for every Tavus claim is in `tavus-notes.md`.

## Shape

```
visitor ─ embed.js / site.js ─ iframe /embed/<key>/video ─ VideoPanel (React)
                                                    │  lazy import("@daily-co/daily-js")
                                                    ▼
 POST /api/video/<key>/session ──► VideoAvatarProvider.createSession ──► Tavus
                                   (tavus.ts | mock.ts)                    │
 Tavus ── POST /api/video/llm/chat/completions (SSE) ◄────────────────────┘
          └─ video/engine.ts: authority rules → AgentSession (prompt, tools,
             booking engine, take_message) → honesty guards → toSpoken → SSE
 Tavus ── POST /api/video/webhook/tavus?t=… ─► end session, transcript, usage
```

Belline stays the source of truth: prompt, knowledge, tools, bookings, leads,
handover, call record, usage and tenancy. Tavus renders the face, hears and
speaks.

## Decisions

1. **Belline as Tavus's LLM.** The docs support an OpenAI-compatible SSE
   endpoint but do not document a conversation id in the request or a
   per-conversation LLM override. Their documented way to vary the LLM backend
   per session is a PAL per session. So `VIDEO_TAVUS_PAL_MODE=per_session`
   (default) creates a short-lived PAL whose `layers.llm.api_key` is a signed
   token naming one venue and one session, and deletes it at the end. That ties
   every LLM request to one conversation using documented fields only. A
   `shared` mode (one PAL from `TAVUS_PAL_ID`, token in `conversational_context`)
   is kept for latency comparison and refuses any request without a valid token
   in a `system` message. The adapter fallback (Tavus-hosted LLM calling our
   tools) is not needed.
2. **Tokens.** HMAC over `sessionId.locationId.expires` with `VIDEO_LLM_SECRET`
   (falls back to `SESSION_SECRET` outside production). The LLM endpoint, the
   webhook and the browser's end/handover calls each check the token, and the
   session it names must be live and belong to that venue.
3. **Channel.** A video call is a `Call` with `channel: "embed"` and a new
   optional `video` field. It meters as web-voice minutes through the existing
   `billableVoiceMinutes`, so no new unit, price or allowance. It has its own
   daily ceiling and is excluded from the voice bell's.
4. **Prompt.** `AgentChannel` gains `"video"`: its own medium block (spoken,
   short, one question at a time, confirm details, no "please hold", never claim
   to be human, visible AI label), the voice control tools (`end_call`,
   `take_message`; `transfer_call` already refuses without a live line), and the
   same `AI_DISCLOSURE`, booking rules, house rules and FAQs. The greeting is
   "Hi, I'm {agent}, the AI concierge for {business}. How may I help you today?"
   via `custom_greeting`, and the model is told it was already said.
5. **Guards.** The voice path's order: `assessAuthority` before the model, then
   the turn, then per-sentence `checkTimes` / request-only claim repair, then
   `toSpoken`. Tavus `speculative_inference` is **off** by default because a
   speculative request could run a writing tool on a half-heard sentence.
6. **Gating.** Offered only when the `video.avatar` flag is on (explicit; needs
   Tavus credentials unless the mock is selected), the venue is on the
   allowlist (`VIDEO_AVATAR_VENUES`, or added in the sales console), the staff
   kill switch is not thrown, the widget is on and live, and the plan includes
   web voice. The kill switch and allowlist live in `DATA_DIR/video.json`.
7. **Mock.** `VIDEO_AVATAR_PROVIDER=mock` runs the same contract with no
   network: a placeholder face labelled "MOCK — not a live avatar", typed or
   scripted turns sent through the real LLM route. It refuses to run in
   production or next to a non-local database (the `stubsRefusal` rule).
8. **Privacy.** No recording, perception `off`, camera never requested,
   `policy: "eu"` for venues answered in German, minimal context (venue name
   and agent name only), no keys, tokens or booking details in logs.

## Work, in order

1. Docs: `tavus-notes.md`, this plan.
2. `src/lib/video/`: `types`, `config`, `provider`, `tavus`, `mock`, `control`
   (kill switch, allowlist), `tokens`, `sessions` (single-flight create, timers,
   cleanup, metrics), `engine` (LLM turn + SSE), `availability`.
3. Agent: `"video"` channel in `prompt.ts`, `runtime.ts` (greeting option),
   `tools.ts` (spoken control tools).
4. Routes: session start / end / handover / event, Tavus webhook, LLM
   `chat/completions`, mock relay, sales-console video switch.
5. UI: `/embed/[key]/video` page and `VideoPanel` (states, mic explanation,
   mute, end, chat and voice fallbacks, talk to a person, captions, warning
   before the limit, mobile full screen, reduced motion). Hooks: `embed.js`
   third button when the venue config says `video: true`; `site.js` video
   button for Belline's own venue; `site.css` styles on tokens.
6. Flag `video.avatar`; `.env.example` placeholders; privacy pages (EN + DE,
   hash refreshed, legal-date checks moved to 17 September 2026).
7. Tests: `check:video` (flag, gating, mock create, failure, double click,
   end cleanup, duration, tenant isolation incl. LLM route, key never in
   bundles or JSON, webhook auth, SSE format, chat and voice untouched) and a
   Playwright spec in mock mode for the panel at 1280 and 390×844.
8. Gate, typecheck, `next build`, manual QA screenshots, `README.md`,
   `privacy-review.md`.

## Revision (founder, same day): the greeting bubble

The entry point became a round bubble that opens on page load with a muted,
looping greeting clip (or poster or placeholder) and a caption, and becomes the
round call view on a tap. A live session still starts only on the tap. The
clip is generated once by an owner-run script against Tavus's video
generation API; `VIDEO_GREETING_CLIP_URL` / `VIDEO_GREETING_POSTER_URL` (or
a venue setting) point at it.

## Out of scope for the prototype

Per-venue faces and PALs beyond one default (the settings shape exists),
languages other than English on video, perception, recording, a warm handover
with the transcript attached to the chat thread.
