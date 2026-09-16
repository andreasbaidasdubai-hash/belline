/**
 * The spoken-language layer, in German.
 *
 * The same job as spoken.ts — text read aloud is not speech — with one
 * difference that changes the approach. In English the voice's own model says
 * "85" well enough to leave digits alone. The German voices run on the fast
 * ElevenLabs models, whose text normaliser is not available to us, and a digit
 * left to them is a coin toss between "fünfundachtzig" and "acht fünf". So
 * here every number that matters is written out as words before it goes: the
 * words are what the caller hears, and they are testable.
 *
 * Like the English layer it is deterministic and never rewrites meaning. The
 * figures in, the figures out; only pronounceable.
 */

const ONES = [
  "null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun",
  "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn",
];
const TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];

/**
 * A whole number as German words, 0 to 999 999.
 *
 * `one` is what 1 becomes on its own: "eins" when counting, "ein" in front of a
 * noun ("ein Euro", "ein Uhr"). Inside a compound it is always "ein" —
 * "einundzwanzig", "einhundert".
 */
export function germanNumber(n: number, one: "eins" | "ein" | "eine" = "eins"): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n === 1) return one;
  if (n < 20) return ONES[n];
  if (n < 100) {
    const unit = n % 10;
    const ten = TENS[Math.floor(n / 10)];
    return unit === 0 ? ten : `${unit === 1 ? "ein" : ONES[unit]}und${ten}`;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    return `${hundreds === 1 ? "ein" : ONES[hundreds]}hundert${rest ? germanNumber(rest) : ""}`;
  }
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  return `${thousands === 1 ? "ein" : germanNumber(thousands)}tausend${rest ? germanNumber(rest) : ""}`;
}

/**
 * Ordinal stems: "erst", "zweit", "dritt", "siebzehnt", "zwanzigst". The ending
 * depends on the words around it, so it is added by the caller.
 */
function ordinalStem(n: number): string {
  if (n === 1) return "erst";
  if (n === 3) return "dritt";
  if (n === 7) return "siebt";
  if (n === 8) return "acht";
  if (n < 20) return `${germanNumber(n)}t`;
  return `${germanNumber(n)}st`;
}

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];
const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

/**
 * Digits for somebody writing them down. "Zwo" rather than "zwei" is not a
 * regionalism: it is what German speakers say on the telephone precisely so
 * that two is never heard as three.
 */
const DIGITS = ["null", "eins", "zwo", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"];

/** The German spelling alphabet's letter names, so "K" is not heard as "C". */
const LETTERS: Record<string, string> = {
  A: "A", B: "Be", C: "Ze", D: "De", E: "E", F: "Ef", G: "Ge", H: "Ha", I: "I", J: "Jott",
  K: "Ka", L: "El", M: "Em", N: "En", O: "O", P: "Pe", Q: "Ku", R: "Er", S: "Es", T: "Te",
  U: "U", V: "Vau", W: "We", X: "Ix", Y: "Ypsilon", Z: "Zett",
};

// Letters, for boundaries: `\b` knows nothing about ä, ö, ü or ß.
const L = String.raw`A-Za-zÄÖÜäöüß`;

// ---------------------------------------------------------------------------
// Pronunciation
// ---------------------------------------------------------------------------

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bDr\.(?=\s)/g, "Doktor"],
  [/\bProf\.(?=\s)/g, "Professor"],
  [/\bStr\.(?=\s|$|,)/g, "Straße"],
  [/\bz\.\s?B\./g, "zum Beispiel"],
  [/\bZ\.\s?B\./g, "Zum Beispiel"],
  [/\bca\.(?=\s)/g, "circa"],
  [/\binkl\.(?=\s)/g, "inklusive"],
  [/\bbzw\.(?=\s)/g, "beziehungsweise"],
  [/\busw\./g, "und so weiter"],
  [/\bNr\.(?=\s?\d)/g, "Nummer"],
  [/\bTel\.(?=\s)/g, "Telefon"],
  // The abbreviation's full stop is a sentence's too when nothing follows it.
  [/\bMin\.(?=\s*$|\s+[A-ZÄÖÜ])/g, "Minuten."],
  [/\bMin\b\.?/g, "Minuten"],
  [/\bStd\.(?=\s*$|\s+[A-ZÄÖÜ])/g, "Stunden."],
  [/\bStd\b\.?/g, "Stunden"],
  [/&/g, " und "],
];

const CURRENCY: [string, { unit: string; one: "ein" | "eine" }][] = [
  ["€", { unit: "Euro", one: "ein" }],
  ["EUR", { unit: "Euro", one: "ein" }],
  ["Euro", { unit: "Euro", one: "ein" }],
  ["CHF", { unit: "Franken", one: "ein" }],
  ["SFr.", { unit: "Franken", one: "ein" }],
  ["Fr.", { unit: "Franken", one: "ein" }],
  ["Franken", { unit: "Franken", one: "ein" }],
  ["£", { unit: "Pfund", one: "ein" }],
  ["GBP", { unit: "Pfund", one: "ein" }],
  ["$", { unit: "Dollar", one: "ein" }],
  ["USD", { unit: "Dollar", one: "ein" }],
  ["AED", { unit: "Dirham", one: "ein" }],
];
const UNIT_OF = new Map(CURRENCY);
const SYMBOLS = CURRENCY.map(([s]) => s.replace(/[.$]/g, "\\$&")).join("|");
// 69 · 69,50 · 69.50 · 1.200 · 1'200 · 45.– · 45.-
const AMOUNT = String.raw`(\d{1,3}(?:[.'’]\d{3})+|\d+)(?:[.,](\d{1,2}|[–-]{1,2})(?!\d))?`;

function amount(whole: string, decimal: string | undefined, symbol: string): string {
  const { unit, one } = UNIT_OF.get(symbol) ?? { unit: symbol, one: "ein" as const };
  const value = Number(whole.replace(/[.'’]/g, ""));
  const cents = decimal && /^\d+$/.test(decimal) ? Number(decimal.padEnd(2, "0")) : 0;
  const said = `${germanNumber(value, one)} ${unit}`;
  // "neunundsechzig Euro fünfzig" — nobody says "und fünfzig Cent" on the phone.
  return cents ? `${said} ${germanNumber(cents)}` : said;
}

/** "€69,50", "69,50 €", "CHF 45.–", "45 Franken" → "neunundsechzig Euro fünfzig". */
function speakMoney(text: string): string {
  return text
    .replace(new RegExp(String.raw`(${SYMBOLS})\s?${AMOUNT}`, "g"), (_, symbol, whole, decimal) => amount(whole, decimal, symbol))
    .replace(new RegExp(String.raw`(?<![\d.,'’])${AMOUNT}\s?(${SYMBOLS})(?![${L}])`, "g"), (_, whole, decimal, symbol) =>
      amount(whole, decimal, symbol),
    );
}

function clock(hour: number, minute: number): string {
  // "ein Uhr", never "eins Uhr"; "vierzehn Uhr dreißig", never "vierzehn Uhr und dreißig".
  const h = `${germanNumber(hour, "ein")} Uhr`;
  return minute === 0 ? h : `${h} ${germanNumber(minute)}`;
}

/**
 * "14:30" → "vierzehn Uhr dreißig", "9 Uhr" → "neun Uhr".
 *
 * The twenty-four hour clock, read the way German timetables and receptionists
 * read it. "Halb drei" is how people talk, but it is ambiguous between the
 * afternoon and the small hours and is easy to get subtly wrong; a caller who
 * hears "vierzehn Uhr dreißig" cannot misunderstand it.
 */
function speakClockTimes(text: string): string {
  return (
    text
      // 7:30 PM, 7 P.M. — English meridiems the model occasionally carries over.
      // Capitals only: in German "9 am Montag" is "9 on Monday".
      .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(A|P)(?:M\b|\.M\.)/g, (whole, h: string, m: string | undefined, ap: string) => {
        let hour = Number(h);
        const minute = Number(m ?? 0);
        if (hour > 12 || minute > 59) return whole;
        if (/p/i.test(ap) && hour < 12) hour += 12;
        if (/a/i.test(ap) && hour === 12) hour = 0;
        return clock(hour, minute);
      })
      // 14:30, 14:30 Uhr, 14.30 Uhr — a dot only with "Uhr", or it is a price.
      .replace(/\b(\d{1,2})(?::(\d{2})(?:\s*Uhr\b)?|\.(\d{2})\s*Uhr\b)/g, (whole, h: string, colon?: string, dot?: string) => {
        const hour = Number(h);
        const minute = Number(colon ?? dot);
        if (hour > 24 || minute > 59) return whole;
        return clock(hour % 24, minute);
      })
      // 14 Uhr
      .replace(/\b(\d{1,2})\s*Uhr\b/g, (whole, h: string) => (Number(h) > 24 ? whole : clock(Number(h) % 24, 0)))
  );
}

/**
 * The ending an ordinal takes from the words in front of it: "am siebzehnten",
 * "der siebzehnte", and on its own, as in "Donnerstag, siebzehnter September".
 */
function ordinalFor(day: number, before: string): { prefix: string; word: string } {
  const stem = ordinalStem(day);
  if (/(?:^|\s)am\s+(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),?\s*$/i.test(before)) {
    return { prefix: "dem ", word: `${stem}en` };
  }
  if (/(?:^|\s)(am|vom|zum|im|dem|den|ab dem|bis zum)\s*$/i.test(before)) return { prefix: "", word: `${stem}en` };
  if (/(?:^|\s)(der|die|das)\s*$/i.test(before)) return { prefix: "", word: `${stem}e` };
  return { prefix: "", word: `${stem}er` };
}

/** "17. September", "17.09.", "17.9.2026" → "siebzehnter September" with the right ending. */
function speakDates(text: string): string {
  const monthWord = MONTHS.join("|");
  let out = text.replace(
    new RegExp(String.raw`\b(\d{1,2})\.\s*(${monthWord})(?:\s+(\d{4}))?(?![${L}])`, "g"),
    (whole, d: string, month: string, year: string | undefined, offset: number, all: string) => {
      const day = Number(d);
      if (day < 1 || day > 31) return whole;
      const { prefix, word } = ordinalFor(day, all.slice(0, offset));
      return `${prefix}${word} ${month}${year ? ` ${germanNumber(Number(year))}` : ""}`;
    },
  );
  out = out.replace(
    /\b(\d{1,2})\.(\d{1,2})\.(\d{4})?(?![\d])/g,
    (whole, d: string, m: string, year: string | undefined, offset: number, all: string) => {
      const day = Number(d);
      const month = Number(m);
      if (day < 1 || day > 31 || month < 1 || month > 12) return whole;
      const { prefix, word } = ordinalFor(day, all.slice(0, offset));
      // "am 3.10." at the end of a sentence: the date's last dot was its full stop too.
      const rest = all.slice(offset + whole.length);
      const stop = !year && /^(\s*$|\s+[A-ZÄÖÜ])/.test(rest) ? "." : "";
      return `${prefix}${word} ${MONTHS[month - 1]}${year ? ` ${germanNumber(Number(year))}` : ""}${stop}`;
    },
  );
  return out;
}

/**
 * "030 1234567" → digit words, in threes, with a beat between groups. Slashes
 * and dashes are how German numbers are written ("030 / 123 45-67") and are
 * read as the same beat.
 */
function speakPhoneNumbers(text: string): string {
  return text.replace(/(?<![\d.,])(\+?\d[\d\s/-]{7,}\d)(?![\d])(?![.,]\d)/g, (number) => {
    const plus = number.trim().startsWith("+") ? "plus " : "";
    const digits = number.replace(/\D/g, "");
    if (digits.length < 7) return number;
    const groups: string[] = [];
    for (let i = 0; i < digits.length; i += 3) {
      // A last digit on its own is folded into the group before it: "vier
      // fünf sechs sieben", not a lone "sieben" after a pause.
      const size = digits.length - i === 4 ? 4 : 3;
      groups.push(digits.slice(i, i + size).split("").map((c) => DIGITS[Number(c)]).join(" "));
      i += size - 3;
    }
    return plus + groups.join(", ");
  });
}

/** "R7K2" → "Er, sieben, Ka, zwo": a letter at a time, by its German name. */
function spell(token: string): string {
  return token
    .split("")
    .map((c) => (/\d/.test(c) ? DIGITS[Number(c)] : LETTERS[c] ?? c))
    .join(", ");
}

function speakReferences(text: string): string {
  return (
    text
      // After a word that says it is one, any four to eight capitals and digits.
      .replace(/\b(Referenz(?:nummer)?|Buchungsnummer|Buchungscode)(:?\s+)([A-Z0-9]{4,8})\b/g, (_, word, gap, token) => `${word}${gap}${spell(token)}`)
      // Anywhere else, only a token with a letter and a digit, so "2026" and "GmbH" are left alone.
      .replace(/\b(?=[A-Z0-9]{4,8}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z]*[0-9])[A-Z0-9]+\b/g, spell)
  );
}

/** Nouns a lone "1" is counted in front of, by the article they take. */
const ONE_BEFORE: [RegExp, string][] = [
  [new RegExp(String.raw`^\s+(Person|Stunde|Minute|Woche|Nacht|Behandlung|Sitzung)(?![${L}])`), "eine"],
  [new RegExp(String.raw`^\s+(Tag|Monat|Tisch|Termin|Gast|Platz|Jahr|Zimmer)(?![${L}])`), "ein"],
];

/**
 * Party sizes, durations, counts: whatever numbers are left, as words. Four
 * digits at most — a postcode said as "zehntausendeinhundertfünfzehn" is worse
 * than the digits the voice would read.
 */
function speakCounts(text: string): string {
  return text.replace(/(?<![\d.,:'’])\b(\d{1,4})\b(?![.,:'’]?\d)/g, (whole, n: string, offset: number, all: string) => {
    const value = Number(n);
    if (value === 1) {
      const after = all.slice(offset + whole.length);
      for (const [re, word] of ONE_BEFORE) if (re.test(after)) return word;
    }
    return germanNumber(value);
  });
}

function pauseForMeaning(text: string): string {
  return text
    .replace(/(^|[.!?]\s+)(Das wäre|Also)\s+/g, "$1$2, ")
    .replace(/\b(Gebucht|Erledigt|Perfekt|Wunderbar)\.\s+/g, "$1... ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Does this fragment carry something the caller is writing down? */
export function carriesDetailDe(text: string): boolean {
  return (
    /\b\d{1,2}[:.]\d{2}\b/.test(text) ||
    /\b\d{1,2}\s*Uhr\b/.test(text) ||
    new RegExp(String.raw`(${SYMBOLS})\s?\d|\d\s?(${SYMBOLS})`).test(text) ||
    /\b(?=[A-Z0-9]{4,8}\b)(?=[A-Z]*[0-9])[A-Z0-9]+\b/.test(text) ||
    /\b\d[\d\s/-]{7,}\d\b/.test(text) ||
    /\bUhr\b/.test(text) ||
    new RegExp(`(${WEEKDAYS.join("|")})`).test(text)
  );
}

/** Written German to spoken German. Called by `toSpoken` for German venues. */
export function toSpokenGerman(text: string): string {
  let out = text.replace(/[*_`#]/g, "");
  for (const [pattern, replacement] of ABBREVIATIONS) out = out.replace(pattern, replacement);
  out = speakMoney(out);
  out = speakClockTimes(out);
  out = speakDates(out);
  out = speakPhoneNumbers(out);
  out = speakReferences(out);
  out = speakCounts(out);
  return pauseForMeaning(out);
}

export { WEEKDAYS as GERMAN_WEEKDAYS, MONTHS as GERMAN_MONTHS };
