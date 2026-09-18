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

/**
 * Said when the greeting had nothing after its hello.
 *
 * English only, and only ever reached by a venue whose whole greeting was an
 * introduction. The pick-up in front of it comes from the copy table in the
 * venue's own language (`video.handover.pickup`), and every greeting this
 * fallback could replace was already an English default.
 */
export const CONTINUATION_FALLBACK = "How can I help?";

/**
 * How long the live face may be in the room saying nothing before she says
 * something unprompted.
 *
 * Measured on staging on 18 September: from the tap, the clip speaks at 0.3s
 * and stops at 5.9s, the room is joined at 8.5s and her first live word lands
 * at 9.2s. So the handover itself already has a gap of about three seconds in
 * it, and this must be longer than that or it would talk over her arrival.
 * After that the silence is the visitor's, and the only ones who break it are
 * the ones who knew they were allowed to.
 */
export const QUIET_NUDGE_MS = 12_000;

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
 * The greeting, minus the hello the clip has already said, plus the moment she
 * arrives.
 *
 * Only ever called when the clip really played. What remains of the greeting is
 * the part that was never in the clip and could not have been: the venue's own
 * words, the account the support session can see, the research behind a
 * personalised demo.
 *
 * **Why there is a pick-up in front of it.** The clip ends on "give me a moment
 * to come online, and then I'm listening", and then the room takes about three
 * seconds to exist. Without a pick-up the next thing the visitor hears is the
 * middle of a sentence from a face that has just changed — two recordings, not
 * one person. `pickup` is one short line that belongs to the pause it fills:
 * she is here now, carry on. It never says hello and never says her name,
 * because the clip has done both, and it comes from the copy table so a German
 * venue does not arrive in English (`video.handover.pickup`).
 *
 * If the greeting was nothing but a hello, there is nothing to carry over and
 * she hands the turn back instead — but she is never silent, which is the whole
 * point of this function.
 */
export function greetingAfterClip(greeting: string, pickup = ""): string {
  const rest = greeting.replace(SELF_INTRODUCTION, "").trim() || CONTINUATION_FALLBACK;
  const lead = pickup.trim();
  return lead ? `${lead} ${rest}` : rest;
}
