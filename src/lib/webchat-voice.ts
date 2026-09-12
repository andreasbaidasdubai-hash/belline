import { transcribeClip } from "./providers/stt";

/**
 * A voice note, typed on the visitor's behalf.
 *
 * Half the people who open the chat do so because they cannot talk out loud;
 * the other half would rather not type on a phone. WhatsApp settled how the
 * second half is served: hold the microphone, say it, let go. So the web chat
 * takes the same thing — a short recording — and turns it into the message
 * they would have typed. Belline answers in writing, as she does everything
 * else in this channel; the visitor chose the quiet channel, and a reply that
 * plays out loud would break that choice.
 *
 * The recording is never kept. It is transcribed and discarded in the same
 * request, and what the thread stores is the transcript marked as spoken —
 * the inbox can see it was a voice note, nobody can play it back, and there
 * is no audio to lose.
 */

/** Long enough for an address and a preferred time; short enough to stay a note. */
export const VOICE_NOTE_MAX_SECONDS = 60;

/**
 * Opus at the bitrates browsers record at is under 40 KB a second, so a minute
 * is around 2 MB. Three is the ceiling, and anything bigger is not a voice
 * note from our widget.
 */
export const VOICE_NOTE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * What browsers actually produce. Chrome and Firefox record Opus in WebM or
 * Ogg; Safari records AAC in MP4. The codec suffix ("audio/webm;codecs=opus")
 * is kept when passing the type on, and ignored when deciding whether to.
 */
const ACCEPTED_MIME = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-m4a", "audio/aac"];

export function acceptsVoiceMime(mime: string | null | undefined): boolean {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return ACCEPTED_MIME.includes(base);
}

export type Transcriber = (audio: Buffer, mime: string) => Promise<string>;

export type VoiceNoteResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too-big" | "unsupported" | "empty" | "failed" };

/**
 * The words in a recording, or the one-word reason there are none.
 *
 * "empty" is not a failure: the visitor held the button and said nothing, or
 * the microphone caught the room and not them. The page tells them so and
 * nothing is stored. "failed" is the vendor or the network, and is also not
 * stored — a thread must not contain a message the customer never said.
 */
export async function voiceNoteToText(
  note: { bytes: Buffer; mime: string },
  transcribe: Transcriber = transcribeClip,
): Promise<VoiceNoteResult> {
  if (note.bytes.length === 0 || note.bytes.length > VOICE_NOTE_MAX_BYTES) {
    return { ok: false, reason: "too-big" };
  }
  if (!acceptsVoiceMime(note.mime)) return { ok: false, reason: "unsupported" };

  let text: string;
  try {
    text = await transcribe(note.bytes, note.mime);
  } catch {
    return { ok: false, reason: "failed" };
  }

  // The same ceiling as a typed message, so a voice note cannot be a way
  // round it.
  text = text.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!text) return { ok: false, reason: "empty" };
  return { ok: true, text };
}
