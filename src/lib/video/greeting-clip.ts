/**
 * The greeting clip: Belle's first words, pre-rendered, so she starts talking
 * on the tap instead of after the connection.
 *
 * A live session takes several seconds to exist — a PAL, a conversation, a
 * Daily room, a replica joining it. Until now the visitor spent those seconds
 * looking at a silent face. The clip fills them with the one part of the
 * opening that is the same on every call: hello, who she is, and that she is
 * an AI. It is generated once against the same face the live call uses
 * (`scripts/video-greeting-clip.ts`), served from our own origin, and played
 * from the visitor's own tap so mobile Safari lets it make a sound.
 *
 * **One greeting, not two.** If the clip says hello and then the live session
 * says hello, the visitor has met Belle twice. So when the clip has actually
 * been heard, the live session's greeting drops its own hello and keeps
 * everything after it — see `greetingAfterClip`. That is the whole handover
 * contract, and it is deliberately one-directional: the clip never carries
 * anything a venue, a demo link or a support session might have put in its own
 * greeting, because those are different on every call and the clip is one
 * file.
 *
 * **The fallback is the absence of all this.** Nothing here runs unless the
 * clip has really played. No clip configured, a file that 404s, a browser that
 * refuses the sound, reduced motion, Data Saver — every one of those leaves
 * `greeted` false, the full greeting intact and the behaviour exactly what it
 * was.
 */

/**
 * What the clip says, word for word.
 *
 * It plays as the opening of a conversation on three different surfaces — a
 * venue's website bubble, the dashboard's Ask Belle, and a prospect's
 * personalised demo page — so every word has to be true on all three. That
 * rules out more than it looks:
 *
 *   - **No business name.** On a customer's website Belle works for them, on
 *     the demo page she is Belline's, in the dashboard she is the owner's
 *     support. One file cannot name all three, so it names none.
 *   - **No role noun.** "Concierge" on the website, "assistant" in the
 *     dashboard, "receptionist" on the demo page. "An AI" is the only one of
 *     those that is true everywhere, and it is the honest one anyway.
 *   - **No promise.** The live Belle that follows differs by surface and by
 *     venue; anything the clip offered she might have to take back. It
 *     promises only the thing it can keep, which is that she is coming.
 *
 * Kept short on purpose: the visitor waits for the clip to finish before the
 * live face takes over, so every word is also a word of delay.
 */
export const GREETING_CLIP_SCRIPT = "Hi, I'm Belle. I'm an AI, not a person. Give me a moment to come online, and then I'm listening.";

/** Roughly 2.5 spoken words a second, as `video-demo/context.ts` counts them. */
export const GREETING_CLIP_SECONDS = Math.round(GREETING_CLIP_SCRIPT.split(/\s+/).length / 2.5);

/**
 * How long before the clip ends the live call joins the room.
 *
 * Tavus speaks `custom_greeting` once a participant is in the room, so the
 * join is the trigger we hold. Joining exactly at the clip's last frame would
 * leave a beat of silence while the room connects and the replica starts; the
 * lead spends that beat under the clip's final words instead. Bounded small:
 * anything the replica says this early would land on top of the clip.
 */
export const HANDOVER_LEAD_MS = 1200;

/** Said when the greeting had nothing after its hello. */
export const CONTINUATION_FALLBACK = "How can I help?";

/**
 * A leading self-introduction: the sentence the clip has already said.
 *
 * Every greeting in the system opens the same way, because they were all
 * written to be somebody's first words — `videoGreeting`'s default, Belline's
 * own `BELLINE_VIDEO_GREETING`, `SUPPORT_VIDEO_GREETING`, and the personalised
 * `buildOpening` on a demo link. Matching that shape rather than any one
 * string is what lets a venue's own greeting and a prospect's personalised
 * opening keep working: only the hello is dropped, never the substance after
 * it.
 */
const SELF_INTRODUCTION =
  /^\s*(?:hi|hello|hey|good (?:morning|afternoon|evening))\b[^.!?]*[.!?]?\s*(?:I'?m|my name is)\b[^.!?]*[.!?]\s*/i;

/**
 * The greeting, minus the hello the clip has already said.
 *
 * Only ever called when the clip really played. What remains is the part that
 * was never in the clip and could not have been: the venue's own words, the
 * account the support session can see, the research behind a personalised
 * demo. If the greeting was nothing but a hello, there is nothing to carry
 * over and Belle simply hands the turn back.
 */
export function greetingAfterClip(greeting: string): string {
  const rest = greeting.replace(SELF_INTRODUCTION, "").trim();
  return rest || CONTINUATION_FALLBACK;
}
