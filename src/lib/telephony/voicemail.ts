import type { Call, Location, VenueLanguage } from "../types";
import { id, listCalls, saveCall } from "../store";
import { isE164 } from "../phone";
import { answersIn } from "../language";
import { copy } from "../customer-copy";

/**
 * A voicemail for callers who reach a venue that has not gone live.
 *
 * An owner sets up call forwarding during setup, before pressing Go live. From
 * then on the calls they miss arrive at Belline, and until Go live Belline
 * does not answer real customers — so a caller used to hear "nobody is able to
 * take your call" and a customer was lost. Now they are asked to leave their
 * name and number, and the owner finds the message in "Needs you".
 *
 * TwiML only. No agent, no media stream, no speech-to-text vendor, no model:
 * Twilio plays the greeting, records up to a minute, and calls us back. Twilio's
 * own transcription is not switched on either (it is billed per minute and the
 * owner listens to the message anyway). Nothing is billed to the venue as
 * minutes; what Twilio charges us for the line and the recording is not
 * metered, the same as every other call that is refused before a stream opens.
 *
 * The recording is personal data the caller chose to leave. Only Twilio's
 * handles are stored (RecordingSid and RecordingUrl); the audio stays with
 * Twilio and is played to the owner through an authenticated route.
 */

/** The longest message Twilio records. A name and a number take fifteen seconds. */
export const VOICEMAIL_MAX_SECONDS = 60;

/** What the caller hears. The business's name and nothing about setup, trials or Belline. */
export function voicemailGreeting(businessName: string, language: VenueLanguage = "en"): string {
  return copy(language, "voicemail.greeting", { name: businessName });
}

/** Said once the message is in. */
export const VOICEMAIL_THANKS = copy("en", "voicemail.thanks");

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/**
 * The voice Twilio reads a line in, before any stream is open.
 *
 * English keeps Polly.Joanna with no language attribute, exactly as it always
 * was. German is Polly.Vicki (neural, de-DE): Twilio lists German voices under
 * de-DE only, and neither Polly's Austrian nor its Swiss voice is on Twilio's
 * list, so Vienna and Zurich hear the German one too.
 */
export const SAY_VOICE: Record<VenueLanguage, { voice: string; language?: string }> = {
  en: { voice: "Polly.Joanna" },
  de: { voice: "Polly.Vicki-Neural", language: "de-DE" },
};

/** A `<Say>` element in the venue's language. `text` is escaped here. */
export function sayTwiml(language: VenueLanguage, text: string): string {
  const { voice, language: tag } = SAY_VOICE[language];
  return `<Say voice="${voice}"${tag ? ` language="${tag}"` : ""}>${escapeXml(text)}</Say>`;
}

/**
 * The TwiML for a real call to a venue that is not live.
 *
 * Both callbacks go to /api/twilio/voicemail, relative so Twilio resolves them
 * against the public URL it is already calling. `action` arrives when the
 * caller finishes (with their number); the status callback arrives when the
 * recording is ready (without it). Either may come first, and both are
 * idempotent by RecordingSid. With no action URL Twilio would request this
 * webhook again and replay the greeting. An empty recording goes to the
 * `<Hangup/>` after it.
 */
export function voicemailTwiml(location: Pick<Location, "id" | "name" | "language">): string {
  const loc = encodeURIComponent(location.id);
  const language = answersIn(location);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayTwiml(language, voicemailGreeting(location.name, language))}
  <Record maxLength="${VOICEMAIL_MAX_SECONDS}" finishOnKey="#" timeout="5" playBeep="true" action="/api/twilio/voicemail?loc=${loc}&amp;via=action" method="POST" recordingStatusCallback="/api/twilio/voicemail?loc=${loc}&amp;via=status" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed" />
  <Hangup/>
</Response>`;
}

/** Twilio's recordings live under its own API host, and nothing else is fetched on an owner's behalf. */
export function twilioRecordingUrl(raw: string | undefined): string | null {
  try {
    const url = new URL(String(raw ?? ""));
    if (url.protocol !== "https:" || url.hostname !== "api.twilio.com") return null;
    if (!/^\/2010-04-01\/Accounts\/AC[0-9a-zA-Z]+\/Recordings\/RE[0-9a-zA-Z]+$/.test(url.pathname.replace(/\.(mp3|wav)$/, ""))) return null;
    return `${url.origin}${url.pathname.replace(/\.(mp3|wav)$/, "")}`;
  } catch {
    return null;
  }
}

export type VoicemailResult =
  | { ok: true; call: Call; created: boolean }
  | { ok: false; reason: "no_recording" | "bad_recording_url" };

/**
 * Record a voicemail callback as one call on the venue, and so one item in
 * "Needs you". Idempotent by RecordingSid: a retried or second callback fills
 * in what the first did not have (the caller's number arrives only with the
 * action request) and never adds a row.
 */
export function recordVoicemail(location: Location, params: Record<string, string>, now: Date = new Date()): VoicemailResult {
  const recordingSid = (params.RecordingSid ?? "").trim();
  if (!/^RE[0-9a-zA-Z]{8,}$/.test(recordingSid)) return { ok: false, reason: "no_recording" };
  const recordingUrl = twilioRecordingUrl(params.RecordingUrl);
  if (!recordingUrl) return { ok: false, reason: "bad_recording_url" };

  const seconds = Math.max(0, Math.min(VOICEMAIL_MAX_SECONDS + 5, Math.round(Number(params.RecordingDuration) || 0)));
  const from = isE164((params.From ?? "").trim()) ? params.From.trim() : "";

  const existing = listCalls(location.id, { includeTests: true }).find((c) => c.voicemail?.recordingSid === recordingSid);
  if (existing) {
    const merged: Call = {
      ...existing,
      from: existing.from && existing.from !== "unknown" ? existing.from : from || existing.from,
      voicemail: { ...existing.voicemail!, recordingUrl, durationSeconds: seconds || existing.voicemail!.durationSeconds },
    };
    const changed = JSON.stringify(merged) !== JSON.stringify(existing);
    return { ok: true, call: changed ? saveCall(merged) : existing, created: false };
  }

  const endedAt = now.toISOString();
  const call: Call = {
    id: id("call"),
    locationId: location.id,
    channel: "phone",
    from: from || "unknown",
    startedAt: new Date(now.getTime() - seconds * 1000).toISOString(),
    endedAt,
    status: "completed",
    outcome: "message_taken",
    transcript: [],
    toolCalls: [],
    latenciesMs: [],
    summary: `Voicemail left before going live (${seconds} seconds).`,
    ...(params.CallSid ? { callSid: params.CallSid.trim() } : {}),
    voicemail: { recordingSid, recordingUrl, durationSeconds: seconds, beforeLive: true },
  };
  return { ok: true, call: saveCall(call), created: true };
}
