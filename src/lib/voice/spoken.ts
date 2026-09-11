/**
 * The spoken-language layer.
 *
 * Between deciding what to say and saying it, there is a step most voice
 * products skip: the model writes *text*, and text read aloud is not speech.
 * "£47.50" is four words, not six characters. "Dr Reid" is "Doctor Reid".
 * "R7K2" is a booking reference and must be read a character at a time or the
 * caller will never get it down. A caller writing a number on the back of an
 * envelope needs it slower than the sentence around it.
 *
 * This runs on every fragment on its way to the voice, and it is deliberately
 * deterministic rather than a second model pass: it costs no latency, it
 * cannot hallucinate a different price, and it is testable. The model is
 * asked to write like a person; this handles the mechanical part that a model
 * gets wrong intermittently, which is the worst way to get something wrong.
 *
 * What it does NOT do is rewrite meaning. If the agent said a thing, this
 * says the same thing — only pronounceable.
 */

export interface SpokenFragment {
  /** What the voice should say. */
  text: string;
  /**
   * Delivery rate for this fragment specifically.
   *
   * A caller taking down a time, a price or a reference needs it slower than
   * the conversation around it — this is how a real receptionist talks, and
   * it is the single change that most stops a voice sounding like a machine
   * reading a row from a table.
   */
  speed: number;
}

/** Conversational pace. Roughly 180 wpm on the conversational model. */
const PACE_TALK = 1.06;
/** Times, prices, references, phone numbers. Roughly 150 wpm. */
const PACE_CAREFUL = 0.92;

// ---------------------------------------------------------------------------
// Pronunciation
// ---------------------------------------------------------------------------

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bDr\.?(?=\s)/g, "Doctor"],
  [/\bMr\.?(?=\s)/g, "Mister"],
  [/\bMrs\.?(?=\s)/g, "Missus"],
  [/\bMs\.?(?=\s)/g, "Miz"],
  [/\bSt\.?(?=\s[A-Z])/g, "Saint"],
  [/\bRd\.?\b/g, "Road"],
  [/\bAve\.?\b/g, "Avenue"],
  [/\bmins?\b/g, "minutes"],
  [/\bhrs?\b/g, "hours"],
  [/\bappt\.?\b/gi, "appointment"],
  [/\bA&E\b/g, "A and E"],
  [/\be\.g\.?/gi, "for example"],
  [/\bi\.e\.?/gi, "that is"],
  [/\betc\.?/gi, "and so on"],
  [/&/g, " and "],
];

const CURRENCY: Record<string, [string, string]> = {
  "£": ["pound", "pounds"],
  $: ["dollar", "dollars"],
  "€": ["euro", "euros"],
};

/** "£47.50" → "47 pounds 50". Said the way a person says it. */
function speakMoney(text: string): string {
  return text.replace(/([£$€])\s?(\d+)(?:\.(\d{1,2}))?/g, (_, symbol, whole, decimal) => {
    const [one, many] = CURRENCY[symbol as string] ?? ["", ""];
    const unit = whole === "1" ? one : many;
    if (!decimal || decimal === "00") return `${whole} ${unit}`;
    // "47 pounds 50" — nobody says "47 pounds and 50 pence" on the phone.
    return `${whole} ${unit} ${decimal.padEnd(2, "0")}`;
  });
}

const HOUR_WORDS = [
  "twelve", "one", "two", "three", "four", "five",
  "six", "seven", "eight", "nine", "ten", "eleven",
];

/**
 * "16:15" → "quarter past four".
 *
 * The agent is told to write times the way people say them, and mostly does.
 * This is the backstop for when it doesn't: a receptionist never says
 * "sixteen fifteen", and a caller hearing it has to do the arithmetic while
 * the sentence carries on without them.
 */
function speakClockTimes(text: string): string {
  return text.replace(/\b(\d{1,2}):(\d{2})\b/g, (whole, h: string, m: string) => {
    const hour = Number(h);
    const minute = Number(m);
    if (hour > 23 || minute > 59) return whole;

    const word = HOUR_WORDS[hour % 12];
    if (minute === 0) return `${word} o'clock`;
    if (minute === 15) return `quarter past ${word}`;
    if (minute === 30) return `half past ${word}`;
    if (minute === 45) return `quarter to ${HOUR_WORDS[(hour + 1) % 12]}`;
    // Everything else reads naturally as the hour then the minutes.
    return `${word} ${minute < 10 ? `oh ${minute}` : minute}`;
  });
}

/**
 * A booking reference, read out one character at a time.
 *
 * "R7K2" spoken as a word is unusable; the caller asks for it again every
 * time. Letters are spaced so the engine says each one, and digits with it.
 */
function speakReferences(text: string): string {
  // Short mixed-case-and-digit tokens are references; ordinary words are not.
  return text.replace(/\b(?=[A-Z0-9]{4,8}\b)(?=[A-Z]*[0-9])[A-Z0-9]+\b/g, (token) =>
    token.split("").join(" "),
  );
}

/**
 * "07700900123" → digits, in threes, so a caller can write it down.
 *
 * Digit by digit, but grouped: eleven digits in an unbroken run is as
 * unusable spoken as it is written, and the comma between groups is the beat
 * a person leaves while the other one catches up.
 */
function speakPhoneNumbers(text: string): string {
  // `(?!\.\d)` not `(?![\d.])`: the point is to skip decimals, and rejecting
  // a plain full stop rejected every number that ends a sentence — which is
  // most of them, since a phone number is usually the last thing said.
  return text.replace(/(?<![\d.])(\+?\d[\d\s]{7,}\d)(?!\d)(?!\.\d)/g, (number) => {
    const plus = number.trim().startsWith("+") ? "plus " : "";
    const digits = number.replace(/\D/g, "");
    const groups: string[] = [];
    for (let i = 0; i < digits.length; i += 3) {
      groups.push(digits.slice(i, i + 3).split("").join(" "));
    }
    return plus + groups.join(", ");
  });
}

/**
 * Pauses that follow meaning rather than punctuation.
 *
 * A comma is worth a beat; a confirmed detail is worth a longer one, because
 * the caller is writing it down. Expressed as ellipses and commas, which the
 * engine reads as timing — no markup, so nothing can leak into the audio as
 * literal characters if the model changes.
 */
function pauseForMeaning(text: string): string {
  return (
    text
      // Before the detail that matters: "That's ... Thursday at four fifteen".
      .replace(/\b(That's|That is|So that's|You're booked for|I've got you)\s+/gi, "$1, ")
      // After a confirmation, before moving on.
      .replace(/\b(All booked|Done|Perfect|Lovely)\.\s+/gi, "$1... ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

// ---------------------------------------------------------------------------

/** Does this fragment carry something the caller is writing down? */
function carriesDetail(text: string): boolean {
  return (
    // A time, a price, a reference, a date, or a phone number.
    /\b\d{1,2}[:.]\d{2}\b/.test(text) ||
    /[£$€]\s?\d/.test(text) ||
    /\b(?=[A-Z0-9]{4,8}\b)(?=[A-Z]*[0-9])[A-Z0-9]+\b/.test(text) ||
    /\b\d[\d\s]{7,}\d\b/.test(text) ||
    /\b(quarter past|half past|quarter to|o'clock|thirty|fifteen|forty five)\b/i.test(text) ||
    /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(text)
  );
}

/**
 * Turn a written fragment into a spoken one.
 *
 * Called on every fragment between the model and the voice.
 */
export function toSpoken(text: string): SpokenFragment {
  let out = text;

  // Markdown and symbols the model should not have produced but sometimes
  // does. Read aloud they become "asterisk", which is unrecoverable.
  out = out.replace(/[*_`#]/g, "");

  out = speakMoney(out);
  out = speakClockTimes(out);
  out = speakPhoneNumbers(out);
  out = speakReferences(out);

  for (const [pattern, replacement] of ABBREVIATIONS) out = out.replace(pattern, replacement);

  out = pauseForMeaning(out);

  return {
    text: out,
    speed: carriesDetail(text) ? PACE_CAREFUL : PACE_TALK,
  };
}

export const PACE = { talk: PACE_TALK, careful: PACE_CAREFUL };
