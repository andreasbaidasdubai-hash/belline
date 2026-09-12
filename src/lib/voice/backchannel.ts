/**
 * "Mm-hmm" is not an interruption.
 *
 * People make noise while they listen. They say "yeah", "right", "mm-hmm" —
 * not to take the floor but to tell you they are still there, and a speaker
 * who stopped dead every time would be unbearable to talk to. These sounds
 * are called backchannels, and handling them is most of the difference
 * between an agent that feels like a person and one that feels like a
 * walkie-talkie.
 *
 * Belline could not tell the difference: any speech-shaped noise while it was
 * talking killed the turn. A caller who said "okay" halfway through hearing
 * three times got silence back, and then had to ask again.
 *
 * The judgement is deliberately made on the *whole* phrase rather than on the
 * words in it. Matching word by word would let "I see you Thursday" through as
 * a backchannel because "i", "see" and "you" are all on the list, and the cost
 * of a false positive here is ignoring somebody who was genuinely talking.
 */

/**
 * Things a listener says to mean "go on".
 *
 * Every entry is a complete utterance. Anything longer or different is
 * somebody taking their turn, which is a different thing entirely.
 */
const BACKCHANNELS = new Set([
  "yeah", "yeah yeah", "ye", "yep", "yup", "ya", "yes", "yes yes",
  "ok", "okay", "ok ok", "okay okay", "oh ok", "oh okay", "kay",
  "mm", "mmm", "mhm", "mhmm", "mmhmm", "mm hmm", "hm", "hmm", "hmmm",
  "uh huh", "uhhuh", "ah", "aha", "ah ok", "ah okay", "oh", "oh right",
  "right", "right right", "alright", "all right", "sure", "of course",
  "i see", "i see", "got it", "gotcha", "understood", "indeed",
  "cool", "great", "perfect", "lovely", "nice", "brilliant", "excellent",
  "wonderful", "sounds good", "fair enough", "no problem",
  "thanks", "thank you", "cheers",
]);

/** The longest a backchannel ever is. Past this, somebody is talking. */
const MAX_WORDS = 3;

/**
 * Is this the noise of somebody listening, rather than somebody speaking?
 *
 * Note what this does *not* decide: whether to act on it. "Yes" is a
 * backchannel mid-sentence and an answer straight after a question, and only
 * the caller of this function knows which of those just happened.
 */
export function isBackchannel(text: string): boolean {
  const normal = text
    .toLowerCase()
    // Hyphens and apostrophes are how "mm-hmm" and "uh-huh" get written down;
    // they are one sound, not two words.
    .replace(/[-']/g, " ")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normal) return false;
  if (normal.split(" ").length > MAX_WORDS) return false;
  return BACKCHANNELS.has(normal);
}

/**
 * Did the agent just ask something?
 *
 * The one case where a short "yes" is emphatically not a backchannel. If
 * Belline has put a question to the caller in this turn, anything they say
 * back is an answer and must be treated as one — suppressing it would leave
 * both sides waiting for the other.
 */
export function invitesAnswer(spokenSoFar: string): boolean {
  return spokenSoFar.includes("?");
}
