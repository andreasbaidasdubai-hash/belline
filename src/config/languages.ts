/**
 * Every language Belline knows about, as data.
 *
 * One entry per language. Adding one is an entry here, its column in
 * lib/customer-copy.ts, and its guard phrases in lib/agent/guard-phrases.ts;
 * the code that serves customers reads all three through lib/language.ts and
 * never names a language itself. `check:languages` holds the three together:
 * nothing is selectable unless its strings are complete and its guards exist.
 *
 * Tiers (the founder's international spec, 2026-09-17):
 *
 *   Wave 1, live        English.
 *   Wave 2              German, live behind `language.de`. French and Spanish
 *                       are slots being localised: not selectable, no content.
 *   Wave 3, planned     Arabic, Portuguese, Italian, Dutch, Turkish: slots only,
 *                       no voice, prompt, messages or guards.
 *
 * `status` decides what an owner can pick. Only "live" is ever offered, and a
 * live language with a flag is offered only while its flag is on. A language
 * that is not fully localised falls back to English, and the fallback is
 * logged (lib/customer-copy.ts `copy`).
 *
 * Pure data with type-only imports: the settings screen renders in the browser
 * and reads this directly.
 */

import type { FlagName } from "../lib/flags";

export type LanguageStatus = "live" | "localising" | "planned";

/** Where a language is spoken, when that changes the voice, the recogniser or the spelling. */
export interface LanguageVariant {
  /** BCP 47. The first variant of an entry is its default. */
  tag: string;
  /** A venue in one of these timezones, or charging in one of these currencies, is this variant. */
  timezones?: readonly string[];
  currencies?: readonly string[];
  /**
   * The ElevenLabs voice a venue still on the house voice speaks this variant
   * in: the env var naming a voice added to Belline's account (library voices
   * only work on an account that has added them, so no id is hard-coded).
   */
  voiceEnv?: string;
  /** Deepgram's own code for this variant, where it has one ("de-CH"). */
  sttCode?: string;
  /** Written without ß, for de-CH. */
  noEszett?: boolean;
}

/**
 * The language-specific part of the agent's prompt. The rules themselves stay
 * in English in prompt.ts; this is the register, the formats and the examples.
 *
 * Placeholders: {name} the business, {guest} what its customers are called,
 * {verb} "say" on a call and "write" in a chat. `when` limits a line to a
 * channel, a variant, a formality or clinics; "only" to a business for which
 * this is the one language.
 */
export interface PromptLine {
  text: string;
  when?: "only" | "voice" | "text" | "clinic" | `variant:${string}` | `formality:${string}`;
}

export interface PromptRegister {
  /** "German" — how the prompt names it. */
  heading: string;
  lines: readonly PromptLine[];
  /** The last line when this is a business's only language. */
  onlyLanguage: { voice: string; text: string };
}

export interface LanguageEntry {
  code: string;
  /** In English, for the owner's dashboard. */
  name: string;
  /** As its speakers write it, for customers: "Deutsch". */
  nativeName: string;
  wave: 1 | 2 | 3;
  status: LanguageStatus;
  /** Offered only while this flag is on. Null: no flag. */
  flag: FlagName | null;
  dir: "ltr" | "rtl";
  /** Default Intl locale for dates on screens. */
  locale: string;
  /** Default form of address, and the others an owner may switch to. Null where the language has none. */
  formality: { default: string; options: readonly string[] } | null;
  variants: readonly LanguageVariant[];
  /**
   * The recogniser. `multi` is whether nova-3's multilingual code-switching
   * mode (language=multi) covers it, which is what lets a call switch into it
   * without being told first.
   */
  stt: { model: "nova-3"; code: string; multi: boolean } | null;
  /** ElevenLabs `language_code` (ISO 639-1), pinned on the models that take it. */
  tts: { languageCode: string } | null;
  /** Twilio <Say>, for lines spoken before any stream is open. */
  twilio: { voice: string; language?: string } | null;
  prompt: PromptRegister | null;
  /**
   * Short, common words that mark a written message as this language, for
   * following a chat that changes language. Lower case.
   */
  markers: readonly string[];
  /** Other names a caller may use to ask for it, in the other live languages ("Englisch"). Lower case. */
  aliases?: readonly string[];
  /** A script that marks this language on its own (Arabic letters). */
  script?: "Arabic";
  /** What customers get where this language has no line of its own. Always English. */
  fallback: "en";
}

export const LANGUAGE_REGISTRY = [
  // --- Wave 1 ---------------------------------------------------------------
  {
    code: "en",
    name: "English",
    nativeName: "English",
    wave: 1,
    status: "live",
    flag: null,
    dir: "ltr",
    locale: "en-GB",
    formality: null,
    // The voice an English venue speaks in is the one it chose; the house
    // voice is ELEVENLABS_VOICE_ID. Neither variant swaps it.
    variants: [{ tag: "en-GB" }, { tag: "en-US", timezones: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"], currencies: ["USD"] }],
    stt: { model: "nova-3", code: "en", multi: true },
    // English sends no language_code, exactly as before languages existed.
    tts: null,
    twilio: { voice: "Polly.Joanna" },
    // English is the prompt's own language: it needs no register block.
    prompt: null,
    aliases: ["englisch"],
    markers: ["the", "and", "you", "is", "are", "have", "can", "please", "thanks", "hello", "hi", "what", "when", "would", "for", "my", "book", "table", "tomorrow", "today", "i", "a", "to", "do", "it"],
    fallback: "en",
  },

  // --- Wave 2 ---------------------------------------------------------------
  {
    code: "de",
    name: "German",
    nativeName: "Deutsch",
    wave: 2,
    status: "live",
    // On only once somebody has heard a real German call on staging.
    flag: "language.de",
    dir: "ltr",
    locale: "de-DE",
    formality: { default: "Sie", options: ["Sie", "du"] },
    variants: [
      { tag: "de-DE", voiceEnv: "ELEVENLABS_VOICE_ID_DE" },
      { tag: "de-AT", timezones: ["Europe/Vienna"], voiceEnv: "ELEVENLABS_VOICE_ID_DE" },
      // nova-3 has a Swiss Standard German model; Swiss German is written without ß.
      { tag: "de-CH", timezones: ["Europe/Zurich", "Europe/Vaduz"], currencies: ["CHF"], voiceEnv: "ELEVENLABS_VOICE_ID_DE", sttCode: "de-CH", noEszett: true },
    ],
    stt: { model: "nova-3", code: "de", multi: true },
    tts: { languageCode: "de" },
    // Twilio lists German voices under de-DE only; Polly's Austrian and Swiss
    // voices are not on its list, so Vienna and Zurich hear this one too.
    twilio: { voice: "Polly.Vicki-Neural", language: "de-DE" },
    prompt: {
      heading: "German",
      lines: [
        { text: `Everyone who gets in touch with {name} is answered in German. Every word you {verb} is German, even though these instructions are in English: the English examples above show the manner, not the words.`, when: "only" },
        { text: "", when: "only" },
        { text: `- Always the formal "Sie", never "du" — even if the {guest} says "du" — unless a house rule below says otherwise.`, when: "formality:Sie" },
        { text: `- Always the informal "du", never "Sie" — this business speaks to its {guest}s that way.`, when: "formality:du" },
        { text: `- Natural front-desk German: short, warm and polite without being stiff. "Gern", "Einen Moment", "Das passt", "Sehr gern". Never translated English — not "Absolut!", not "Das ist eine großartige Frage".` },
        { text: `- {name} is in Switzerland. Write "ss", never "ß" ("Strasse", "grüssen"), and prices in Franken.`, when: "variant:de-CH" },
        { text: `- Write times as digits with "Uhr": "14:30 Uhr", "9 Uhr". The voice reads them out properly. Never "halb drei", and never AM or PM.`, when: "voice" },
        { text: `- Dates as "Donnerstag, 17. September". Prices as "69 Euro" or "45 Franken".`, when: "voice" },
        { text: `- Write a booking reference as it is, "R7K2". It is spelled out letter by letter for the caller automatically.`, when: "voice" },
        { text: `- By the time your reply plays, the caller has already heard "Gerne", "Alles klar", "Genau" or "Einen Moment". Never open with those, nor with "Natürlich" or "Selbstverständlich".`, when: "voice" },
        { text: `- Times on the 24-hour clock, "14:30 Uhr", never AM or PM. Dates as "Donnerstag, 17. September". Prices as "69 €" or "CHF 45".`, when: "text" },
        { text: `- "Guten Tag – wie kann ich Ihnen helfen?" is the whole greeting.`, when: "text" },
        { text: `- If anyone asks whether you are a person, a robot or an AI, say plainly that you are the AI assistant for {name} ("Ich bin die KI-Assistenz von {name}"), then carry on helping. Never claim to be a person.` },
        { text: `- Every rule above applies unchanged in German. Answer only from what this prompt says about {name}. Never invent a price, a time, availability or a policy. Take requests and messages with the tools as described. "Gebucht", "bestätigt", "reserviert", "eingetragen" and "bis dann" tell someone they hold a booking, exactly as their English equivalents do, and follow the same rules.` },
        { text: `- Tools stay exactly as specified: tool names and fields are not translated, dates are YYYY-MM-DD and times HH:MM. Pass services and people by the ids and names in this prompt, even when the {guest} says them differently in German.` },
        { text: `- The emergency number in Germany, Austria and Switzerland is 112.`, when: "clinic" },
      ],
      onlyLanguage: {
        voice: `- This line listens for German. If a caller cannot carry on in German, say once, in simple English, that the team will call them back, take their name and number with take_message, and close politely. Do not try to hold the conversation in another language.`,
        text: `- If someone writes to you in English, answer in English for the rest of the conversation. In any other language, answer in German and offer English in one short sentence.`,
      },
    },
    aliases: ["german"],
    markers: ["der", "die", "das", "und", "ich", "sie", "ist", "nicht", "ein", "eine", "haben", "bitte", "danke", "guten", "tag", "hallo", "morgen", "heute", "für", "wir", "möchte", "gerne", "gern", "termin", "tisch", "uhr", "können", "kann", "mit", "zu", "auf", "noch", "wann"],
    fallback: "en",
  },
  {
    code: "fr",
    name: "French",
    nativeName: "Français",
    wave: 2,
    status: "localising",
    flag: null,
    dir: "ltr",
    locale: "fr-FR",
    formality: { default: "vous", options: ["vous", "tu"] },
    variants: [{ tag: "fr-FR" }, { tag: "fr-CH", timezones: ["Europe/Zurich"], currencies: ["CHF"] }],
    // nova-3 multilingual covers French; no voice, prompt or strings yet.
    stt: { model: "nova-3", code: "fr", multi: true },
    tts: null,
    twilio: null,
    prompt: null,
    markers: [],
    fallback: "en",
  },
  {
    code: "es",
    name: "Spanish",
    nativeName: "Español",
    wave: 2,
    status: "localising",
    flag: null,
    dir: "ltr",
    locale: "es-ES",
    formality: { default: "usted", options: ["usted", "tú"] },
    variants: [{ tag: "es-ES" }, { tag: "es-MX", timezones: ["America/Mexico_City"], currencies: ["MXN"] }],
    stt: { model: "nova-3", code: "es", multi: true },
    tts: null,
    twilio: null,
    prompt: null,
    markers: [],
    fallback: "en",
  },

  // --- Wave 3: slots only ---------------------------------------------------
  {
    code: "ar",
    name: "Arabic",
    nativeName: "العربية",
    wave: 3,
    status: "planned",
    flag: null,
    dir: "rtl",
    locale: "ar-AE",
    formality: null,
    /*
     * Research for when Arabic is built (checked 2026-09-17). Not wired to
     * anything: Arabic has no voice, prompt, messages or guards yet.
     *
     * Deepgram. nova-3 has a monolingual Arabic model (January 2026) with
     * codes ar, ar-AE, ar-SA, ar-QA, ar-KW (the Gulf group) and twelve more,
     * keyterm prompting across dialects, and no streaming restriction listed.
     * Arabic is NOT in nova-3's multilingual code-switching set (en, es, fr,
     * de, hi, ru, pt, ja, it, nl), and streaming language detection is not
     * supported at all, so a call cannot switch into Arabic unannounced: it
     * needs ask mode, or a second recogniser run beside the first until the
     * caller's language is known.
     *   https://developers.deepgram.com/docs/models-languages-overview
     *   https://deepgram.com/learn/nova-3-arabic-speech-to-text-production-grade-stt
     *   https://developers.deepgram.com/docs/multilingual-code-switching
     *   https://developers.deepgram.com/docs/language-detection
     *
     * ElevenLabs. eleven_flash_v2_5 and eleven_multilingual_v2 list "Arabic
     * (Saudi Arabia, UAE)"; `language_code` (ISO 639-1, "ar") enforces the
     * language on flash/turbo v2.5 and is refused by multilingual_v2.
     *   https://elevenlabs.io/docs/overview/models
     *   https://elevenlabs.io/docs/api-reference/text-to-speech/stream
     *
     * Twilio <Say>. Polly.Hala-Neural and Polly.Zayd-Neural in ar-AE (Gulf),
     * Polly.Zeina in arb, Google ar-XA voices.
     *   https://www.twilio.com/docs/voice/twiml/say/text-speech
     */
    variants: [
      { tag: "ar-AE", timezones: ["Asia/Dubai", "Asia/Muscat"], sttCode: "ar-AE" },
      { tag: "ar-SA", timezones: ["Asia/Riyadh"], sttCode: "ar-SA" },
    ],
    stt: null,
    tts: null,
    twilio: null,
    prompt: null,
    markers: [],
    script: "Arabic",
    fallback: "en",
  },
  { code: "pt", name: "Portuguese", nativeName: "Português", wave: 3, status: "planned", flag: null, dir: "ltr", locale: "pt-PT", formality: null, variants: [{ tag: "pt-PT" }, { tag: "pt-BR", timezones: ["America/Sao_Paulo"], currencies: ["BRL"] }], stt: null, tts: null, twilio: null, prompt: null, markers: [], fallback: "en" },
  { code: "it", name: "Italian", nativeName: "Italiano", wave: 3, status: "planned", flag: null, dir: "ltr", locale: "it-IT", formality: null, variants: [{ tag: "it-IT" }], stt: null, tts: null, twilio: null, prompt: null, markers: [], fallback: "en" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", wave: 3, status: "planned", flag: null, dir: "ltr", locale: "nl-NL", formality: null, variants: [{ tag: "nl-NL" }], stt: null, tts: null, twilio: null, prompt: null, markers: [], fallback: "en" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe", wave: 3, status: "planned", flag: null, dir: "ltr", locale: "tr-TR", formality: null, variants: [{ tag: "tr-TR" }], stt: null, tts: null, twilio: null, prompt: null, markers: [], fallback: "en" },
] as const satisfies readonly LanguageEntry[];

export type LanguageCode = (typeof LANGUAGE_REGISTRY)[number]["code"];

export const LANGUAGE_CODES = LANGUAGE_REGISTRY.map((l) => l.code) as readonly LanguageCode[];

/** The entry for a code. Every code has one. */
export function languageEntry(code: LanguageCode): LanguageEntry {
  return LANGUAGE_REGISTRY.find((l) => l.code === code)!;
}

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && (LANGUAGE_CODES as readonly string[]).includes(value);
}

/**
 * The most languages a business answers in besides its main one. More would
 * mean more recognisers to pay for and more guard sets to trust on one call.
 */
export const MAX_ALSO_LANGUAGES = 2;

/** The channels a business may give a language of their own. */
export const LANGUAGE_CHANNELS = ["phone", "web_voice", "web_chat", "whatsapp"] as const;
export type LanguageChannel = (typeof LANGUAGE_CHANNELS)[number];

export const LANGUAGE_CHANNEL_LABELS: Record<LanguageChannel, string> = {
  phone: "Phone calls",
  web_voice: "Website voice button",
  web_chat: "Website chat",
  whatsapp: "WhatsApp",
};
