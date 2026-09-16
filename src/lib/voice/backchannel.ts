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

/**
 * The same, as German callers make them.
 *
 * "Ja", "genau", "mhm", "okay", "ah ja", "ähm". Deepgram's German model writes
 * the hesitation sounds with their umlauts, so the list keeps them; a caller
 * saying "ja, genau" over a read-back of their booking is agreeing, not
 * interrupting. English's own list still applies — "okay" and "mhm" cross the
 * border unchanged, and a German caller says "sorry" and "perfect" too.
 */
const BACKCHANNELS_DE = new Set([
  "ja", "ja ja", "jaja", "jo", "jup", "jep", "jawohl", "genau", "ja genau", "genau genau",
  "mhm", "mhmm", "mm", "hm", "hmm", "aha", "ah", "ah ja", "ach so", "achso", "ach ja", "ah okay", "ah ok",
  "okay", "ok", "okay okay", "alles klar", "klar", "gut", "gut gut", "sehr gut", "super", "prima", "perfekt", "wunderbar",
  "stimmt", "richtig", "verstehe", "ich verstehe", "verstanden", "in ordnung", "passt", "passt gut", "gern", "gerne",
  "ähm", "äh", "öhm", "hmhm", "danke", "danke schön", "dankeschön", "vielen dank", "ja danke",
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
export function isBackchannel(text: string, language: "en" | "de" = "en"): boolean {
  if (language === "de") return isGermanBackchannel(text) || isBackchannel(text);

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

function isGermanBackchannel(text: string): boolean {
  const normal = text
    .toLowerCase()
    .replace(/[-']/g, " ")
    // Letters with their umlauts: stripping to a-z would make "ähm" into "hm"
    // by accident and "schön" into "schn".
    .replace(/[^a-zäöüß\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normal) return false;
  if (normal.split(" ").length > MAX_WORDS) return false;
  return BACKCHANNELS_DE.has(normal);
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
