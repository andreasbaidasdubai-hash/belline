# Video receptionist — privacy points for the owner to review

Before video is switched on for anybody outside Belline. Each point says what
Belline does in code today, what Tavus's documentation does and does not
promise (sources in `tavus-notes.md`), and what needs a decision or a contract.
This is not legal advice.

## 1. What leaves Belline, and to whom

| Data | Sent to | Why |
|---|---|---|
| The visitor's voice, live | Tavus, over a Daily room | Speech-to-text, turn-taking, and the face's lip-sync |
| Belline's replies (text) | Tavus | Spoken by the face |
| The greeting, the agent's and business's names | Tavus | `custom_greeting`, `conversational_context`, the per-session PAL's prompt |
| The visitor's words as text | Back to Belline's model route | Belline answers; the transcript is stored in the call record like any call |
| Session id, venue-scoped token | Tavus (as the PAL's `api_key` and in the `callback_url`) | Ties Tavus's requests to one conversation |

**Never sent:** camera video (never requested; perception `off`), recordings
(`enable_recording: false`), the visitor's phone number or email unless they
say it aloud, booking details beyond what is spoken, Belline's Anthropic key,
the Tavus key (server-side only).

**Also in the browser:** `@daily-co/daily-js` connects to Daily's servers for
the room. Daily's SDK bundles error reporting (`@sentry/browser` is a
dependency). **Review:** whether Daily's client telemetry sends anything about
the visitor, and whether it can be disabled.

## 2. Retention at Tavus — decide and configure

- **Transcripts:** Tavus stores a conversation transcript and returns it in
  `application.transcription_ready` and verbose GET. Its retention period is
  **not documented**. Belline does not rely on Tavus's copy (it keeps its own).
  **Action:** ask Tavus for the retention period in writing, or set
  `VIDEO_TAVUS_DELETE_AFTER_END=on`, which hard-deletes each conversation
  (`DELETE /v2/conversations/{id}?hard=true`) as soon as it ends. Off by
  default, because Tavus's copy is what their support would look at if a call
  misbehaved during the prototype.
- **Zero Data Retention:** the changelog (26 June 2026) says account-level and
  programmatic ZDR exist, but not how to turn it on. **Action:** ask Tavus
  support to enable it on the account, and whether it covers transcripts and
  per-session PALs.
- **Recordings:** off, and never enabled by Belline. If ever turned on, they
  must go to Belline's own bucket via `recording_storage`, and the privacy page
  must change first.
- **Per-session PALs:** created and deleted per call. A PAL left behind by a
  crash contains only the business and agent names and a token that expires
  about 20 minutes after the call. **Action (optional):** a periodic sweep of
  `belline-vs_*` PALs older than a day.

## 3. EU and location

- `policy: "eu"` is sent for venues answered in German. The docs say it only
  switches Tavus's `auto` settings (disclosure, limited emotion recognition);
  **it does not promise EU processing or data residency**, and Tavus "does not
  geolocate the caller".
- **Action:** confirm where Tavus and Daily process audio and transcripts, and
  whether an EU region exists, before offering video to EU venues. English
  only is offered on video today.

## 4. Contracts

- The Tavus FAQ claims SOC 2, GDPR and HIPAA/BAA compliance. **A DPA is not in
  the docs.** **Action:** sign Tavus's DPA (and confirm Daily is listed as its
  subprocessor) before video runs for any venue other than Belline's own.
- Clinics: do not enable video for a clinic until the health-data opinion that
  gates clinics generally covers Tavus too. The clinic medical rule is in the
  video prompt, but the audio still reaches Tavus.

## 5. Disclosure and likeness

- Belline discloses itself three ways: the greeting ("Hi, I'm Belle, the AI
  concierge for …"), a permanent "AI concierge" label on the panel, and the
  prompt's rule to say it is an AI when asked. Tavus's own spoken disclosure is
  set to `off` to avoid a second, differently worded one. **Review** that this
  is enough for the EU AI Act transparency duty in the markets where video is
  offered.
- The face is a Tavus **stock** face (`rf90eb925bd8`). No real person is
  cloned. Tavus's terms put likeness rights on the customer; stock faces are
  Tavus's to license. **Review** the stock-face licence for commercial use on
  customers' websites.
- No biometric identification, emotion inference or face analysis: perception
  is `off`, so Tavus's `emotion_recognition` never runs.

## 6. Logs

Belline logs session ids, reasons and Tavus's short error messages. It does
not log keys, tokens, room URLs, meeting tokens, audio, or what was said
(the transcript lives in the call record, under the venue's normal access
rules). Timings are stored as numbers with a reason code.

## 7. The published privacy pages

`public/privacy.html` and `privacy.de.html` (17 September 2026) name Tavus and
Daily, say no business can offer video yet, that the camera is never used, the
call is not recorded, and that Tavus holds a transcript Belline can have
deleted. **Review** the wording once the retention answer in §2 is known, and
update both pages (then `npm run translations:hash`) before video goes live
for customers.
