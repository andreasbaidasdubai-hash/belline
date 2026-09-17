import type { LanguageCode } from "../../config/languages";
import type { CopyKey } from "../customer-copy";

/**
 * The guards' words, per language, as data.
 *
 * Three guards read what customers and the agent say, and each is only as good
 * as its phrases in the language being spoken:
 *
 *   honesty.ts    the agent offering a time nothing returned, or claiming a
 *                 booking it did not make ("ich hätte 18 Uhr", "gebucht")
 *   authority.ts  a caller describing an emergency or asking for clinical
 *                 advice, answered with fixed words before the model is asked
 *   backchannel   "ja, genau" over the agent is listening, not interrupting
 *
 * English is the guards' own language and lives in those files. Every other
 * language is an entry here, and language.ts refuses to let an owner choose a
 * language this file does not cover (`guardsCover`). A language without guards
 * would be a way round every one of them.
 *
 * A business answering in several languages is guarded in all of them at once:
 * a reply can mix two, and a caller can switch mid-sentence.
 */

export interface HonestyPhrases {
  /** Regex source: words that frame a time as one the venue can give. */
  offerCore: string;
  /** The looser idioms, read only where Belline can never give a time. */
  offerExtra: string;
  /**
   * Regex source: a negation anywhere in the clause unmakes an offer. Read
   * across the clause, not only before the offer word, for languages that put
   * the negation after the verb ("ich kann Sie um 18 Uhr leider nicht eintragen").
   */
  negation: string;
  /** Regex source: words that make a sentence about opening hours. */
  hours: string;
  /** Regex source: words that tell somebody they hold a booking. */
  claim: string;
  /** Regex source: what undoes a claim from inside it ("ist noch nicht gebucht"). */
  unmade: string;
  /** Regex source: what makes a claim word future or conditional, read before it. */
  hedge: string;
  /** Words after a comma that start a new clause ("aber"). */
  clauseJoiners: readonly string[];
  /** A word that makes a bare number a clock time ("17 Uhr"). */
  hourWord?: string;
  /** How a repair writes a clock time: "{time} Uhr". */
  timeFormat: string;
}

export interface AuthorityPhrases {
  /** Letters folded before comparing, so recogniser and keyboard spellings agree: [["ä", "ae"]]. */
  fold: readonly (readonly [string, string])[];
  /** Per rule id, the phrase groups — every group must match one phrase. Written folded. */
  requires: Record<string, readonly (readonly string[])[]>;
  /** Per rule id, the lines said back. */
  says: Record<string, { say: CopyKey; sayIfNoTransfer?: CopyKey }>;
}

// ---------------------------------------------------------------------------
// German
// ---------------------------------------------------------------------------

/*
 * German is not a way round the honesty guard. The words are the same moves in
 * German clothes: "ich hätte", "wie wäre es mit", "da ist noch frei", "ich kann
 * Sie um … eintragen". "Wir haben bis 18 Uhr geöffnet" is how German states
 * opening hours, so "wir haben" only counts when the sentence is not about
 * being open.
 *
 * "Bestätigt" is a participle and a present tense at once — "Sie sind
 * bestätigt" claims a booking, "das Team bestätigt Ihnen den Termin" promises
 * one — so the participles only count with the auxiliary that makes them a
 * fact ("ist", "sind", "habe … eingetragen"), or alone as the whole reply
 * ("Gebucht!").
 */
const DE_PARTICIPLES = String.raw`bestätigt|gebucht|reserviert|eingetragen|vorgemerkt`;
const L = String.raw`\p{L}\p{N}_`;

const GERMAN_HONESTY: HonestyPhrases = {
  offerCore: String.raw`ich habe|ich hätte|(?:wir haben|haben wir)(?![^.!?]*(?:geöffnet|offen|geschlossen|Ruhetag|Öffnungszeit))|wir hätten|hätte ich|hätten wir|habe ich|es gibt|gibt es|frei|verfügbar|wie wäre es mit|wie wäre|was halten Sie von|passt (?:Ihnen|es Ihnen|das)|würde (?:Ihnen )?(?:das )?passen|(?:kann|könnte) (?:ich )?(?:Ihnen|Sie)|anbieten|einschieben|dazwischenschieben|eintragen|einplanen|reinnehmen|dazunehmen|vormerken`,
  offerExtra: String.raw`frühestens|spätestens|frühester|spätester|frühestmöglich|kommen Sie (?:gern |gerne )?(?:um|vorbei)|sehen uns um|reservieren`,
  negation: String.raw`nicht|kein|keine|keinen|keinem|keiner|nie|niemals|ob|nichts|leider nicht|unmöglich`,
  hours: String.raw`geöffnet|öffnen|öffnet|offen|Öffnungszeit(?:en)?|schließen|schließt|geschlossen|schliessen|schliesst|Ruhetag|bis|letzte (?:Bestellung|Buchung|Annahme|Behandlung)|Annahmeschluss|Küchenschluss`,
  claim: String.raw`(?:ist|sind|wurde|wurden|habe|haben|hat)(?![${L}])[^.!?]{0,60}?(?<![${L}])(?:${DE_PARTICIPLES})|^\s*(?:${DE_PARTICIPLES})|fest eingeplant|bis dann|bis (?:morgen|bald|später|nachher|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)|wir sehen uns|wir freuen uns auf (?:Sie|Ihren Besuch|Ihr Kommen)|alles erledigt|ist erledigt|ist fix|steht fest`,
  unmade: String.raw`nicht|nichts|kein|keine|keinen|sobald|wenn|falls|sofern|bevor|erst|wird|werden`,
  hedge: String.raw`wird|werden|würde|sobald|wenn|falls|sofern|nicht|nichts|noch|kein|keine|bevor|erst|muss|müsste|soll|sollte|kann|könnte`,
  clauseJoiners: ["aber", "also", "doch", "jedoch", "allerdings"],
  hourWord: "Uhr",
  timeFormat: "{time} Uhr",
};

/*
 * The authority rules as German callers put them: not a translation of the
 * English phrases but of the situations — "ich kriege keine Luft", "die
 * Blutung hört nicht auf", "ist das normal?". Written folded (lower case, ä as
 * ae, ß as ss) because the recogniser and a person typing on a phone do not
 * agree about umlauts. 112 reaches the emergency services in Germany, Austria
 * and Switzerland alike.
 */
const GERMAN_AUTHORITY: AuthorityPhrases = {
  fold: [
    ["ä", "ae"],
    ["ö", "oe"],
    ["ü", "ue"],
    ["ß", "ss"],
  ],
  requires: {
    "medical-emergency": [
      [
        "brustschmerz", "schmerzen in der brust", "brust tut weh", "brust ist eng", "engegefuehl in der brust",
        "druck auf der brust", "keine luft", "atemnot", "kann nicht atmen", "schwer atmen", "blutet stark",
        "starke blutung", "hoert nicht auf zu bluten", "blutung hoert nicht auf", "ohnmaechtig", "bewusstlos",
        "zusammengebrochen", "umgekippt", "kollabiert", "verwaschene sprache", "gesicht haengt", "halbseitig taub",
        "allergische reaktion", "anaphyla", "hals schwillt zu", "zunge schwillt", "ueberdosis", "zu viele tabletten",
      ],
      [
        "jetzt", "gerade", "sofort", "akut", "seit", "heute", "ploetzlich", "auf einmal", "hilfe", "kann nicht",
        "ist", "bin", "habe", "hab ", "fuehle", "angefangen", "kriege", "bekomme", "hoert nicht auf", "immer noch",
      ],
    ],
    "clinical-advice": [
      [
        "ist das normal", "ist das schlimm", "ist das gefaehrlich", "muss ich mir sorgen", "sollte ich mir sorgen",
        "mache mir sorgen", "ist es entzuendet", "ist das entzuendet", "was koennte das sein", "was meinen sie was",
        "glauben sie dass", "denken sie dass", "soll ich nehmen", "kann ich nehmen", "darf ich nehmen", "soll ich ein",
        "wie viel soll ich", "wieviel soll ich", "doppelte dosis", "statt antibiotik", "diagnos",
      ],
      [
        "schmerz", "tut weh", "geschwollen", "schwellung", "blutet", "blutung", "entzuend", "infekt", "symptom",
        "knoten", "beule", "ausschlag", "fieber", "temperatur", "medikament", "tablette", "antibiotik", "schmerzmittel",
        "ibuprofen", "paracetamol", "rezept", "operation", "fuellung", "gezogen", "faeden", "naht", "wunde",
        "behandlung", "eingriff",
      ],
    ],
    "adverse-reaction": [
      ["reaktion", "verbrannt", "verbrennung", "blasen", "geschwollen", "schwellung", "ausschlag", "kopfhaut", "brennt", "juckt"],
      ["behandlung", "farbe", "faerb", "blondier", "bleach", "peeling", "laser", "waxing", "wachs", "nach dem", "nach der", "seit dem", "seit der"],
    ],
  },
  says: {
    "medical-emergency": { say: "authority.emergency" },
    "clinical-advice": { say: "authority.clinical" },
    "adverse-reaction": { say: "authority.reaction", sayIfNoTransfer: "authority.reaction_no_transfer" },
  },
};

/*
 * "Ja", "genau", "mhm", "ah ja", "ähm". Deepgram's German model writes the
 * hesitation sounds with their umlauts, so the list keeps them; a caller saying
 * "ja, genau" over a read-back of their booking is agreeing, not interrupting.
 */
const GERMAN_BACKCHANNELS = [
  "ja", "ja ja", "jaja", "jo", "jup", "jep", "jawohl", "genau", "ja genau", "genau genau",
  "mhm", "mhmm", "mm", "hm", "hmm", "aha", "ah", "ah ja", "ach so", "achso", "ach ja", "ah okay", "ah ok",
  "okay", "ok", "okay okay", "alles klar", "klar", "gut", "gut gut", "sehr gut", "super", "prima", "perfekt", "wunderbar",
  "stimmt", "richtig", "verstehe", "ich verstehe", "verstanden", "in ordnung", "passt", "passt gut", "gern", "gerne",
  "ähm", "äh", "öhm", "hmhm", "danke", "danke schön", "dankeschön", "vielen dank", "ja danke",
] as const;

// ---------------------------------------------------------------------------

export const HONESTY_PHRASES: Partial<Record<LanguageCode, HonestyPhrases>> = { de: GERMAN_HONESTY };
export const AUTHORITY_PHRASES: Partial<Record<LanguageCode, AuthorityPhrases>> = { de: GERMAN_AUTHORITY };
export const BACKCHANNEL_PHRASES: Partial<Record<LanguageCode, readonly string[]>> = { de: GERMAN_BACKCHANNELS };

/** Whether every guard can read this language. English is the guards' own. */
export function guardsCover(code: LanguageCode): boolean {
  return code === "en" || Boolean(HONESTY_PHRASES[code] && AUTHORITY_PHRASES[code] && BACKCHANNEL_PHRASES[code]);
}
