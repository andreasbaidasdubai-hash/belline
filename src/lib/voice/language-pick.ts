import type { Location, VenueLanguage } from "../types";
import { languageEntry } from "../../config/languages";
import { detectLanguage, languageOfTag, lineFor, variantOf, type EffectiveLanguages, type LanguageContext } from "../language";
import { isBackchannel } from "./backchannel";

/**
 * Which language a call is in.
 *
 * A business answers in a main language and up to two more. On a call that
 * has to be decided out loud, and the recogniser and the voice both have to
 * follow the decision. This is the decision, kept pure so it can be tested
 * without a line: the session feeds it each finished utterance and does what
 * it says.
 *
 *   auto  The greeting is in the main language. The first real utterance —
 *         not "mhm" — settles the call: in another chosen language if that is
 *         what the caller spoke, otherwise the main one.
 *   ask   The greeting offers every chosen language, each in its own words.
 *         The first real utterance settles it the same way, and naming a
 *         language ("Deutsch, bitte") counts as choosing it.
 *
 * Settled once, then locked: a call that changed language on every sentence
 * the recogniser misheard would be worse than one that never changed.
 *
 * Hearing the language. Where nova-3's multilingual mode covers every chosen
 * language, one stream listens in `multi` and reports per utterance which
 * language it heard. Deepgram has no streaming language detection, so where a
 * chosen language is outside that mode the recogniser listens in the main
 * language only, and the words themselves are the only evidence: a caller in
 * the other language is answered in the main one, and the prompt has the agent
 * say which languages it speaks. Every language live today (English, German)
 * is inside the multilingual mode.
 */

/** What the recogniser is asked to listen for. `en` is sent as nothing, so an English call asks what it always did. */
export function sttLanguageFor(location: Pick<Location, "timezone" | "currency">, languages: Pick<EffectiveLanguages, "main" | "also">): string {
  const all = [languages.main, ...languages.also];
  if (all.length > 1 && all.every((code) => languageEntry(code).stt?.multi)) return "multi";
  const main = languageEntry(languages.main);
  return variantOf(location, languages.main).sttCode ?? main.stt?.code ?? "en";
}

/** A language the caller asked for by name, in a short utterance. */
export function languageNamed(text: string, allowed: readonly VenueLanguage[]): VenueLanguage | null {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (!words.length || words.length > 5) return null;
  for (const code of allowed) {
    const entry = languageEntry(code);
    const names = new Set([entry.name.toLowerCase(), entry.nativeName.toLowerCase(), ...(entry.aliases ?? [])]);
    if (words.some((w) => names.has(w))) return code;
  }
  return null;
}

export interface Heard {
  language: VenueLanguage;
  /** The call moved to another language on this utterance. */
  changed: boolean;
  /** The language is settled from here. */
  locked: boolean;
}

export class LanguagePick {
  readonly main: VenueLanguage;
  readonly allowed: readonly VenueLanguage[];
  readonly mode: "auto" | "ask";
  private currentLanguage: VenueLanguage;
  private settled: boolean;

  constructor(languages: EffectiveLanguages) {
    this.main = languages.main;
    this.allowed = [languages.main, ...languages.also];
    this.mode = languages.pick;
    this.currentLanguage = languages.main;
    // One language: nothing to decide.
    this.settled = this.allowed.length < 2;
  }

  get current(): VenueLanguage {
    return this.currentLanguage;
  }

  get locked(): boolean {
    return this.settled;
  }

  /** Whether the greeting offers the languages. Only in ask mode, and only where there is a choice. */
  get asks(): boolean {
    return this.mode === "ask" && this.allowed.length > 1;
  }

  /**
   * A finished utterance. `heard` is the recogniser's language tags for it,
   * when listening in several.
   */
  hear(text: string, heard?: readonly string[]): Heard {
    if (this.settled || !text.trim()) return { language: this.currentLanguage, changed: false, locked: this.settled };

    const named = languageNamed(text, this.allowed);
    // "Mhm" and "okay" say nothing about which language somebody speaks.
    if (!named && isBackchannel(text, this.allowed)) return { language: this.currentLanguage, changed: false, locked: false };

    const language =
      named ?? languageOfTag(heard?.[0], this.allowed) ?? detectLanguage(text, this.allowed) ?? this.currentLanguage;
    const changed = language !== this.currentLanguage;
    this.currentLanguage = language;
    this.settled = true;
    return { language, changed, locked: true };
  }
}

/**
 * What an ask-mode call opens with: the greeting in the main language, then
 * one line in each other language, in that language, so every caller hears the
 * offer in words they know. Each part is spoken in its own language's voice.
 */
export function askGreetingParts(
  location: Pick<Location, "language" | "languages" | "timezone" | "currency">,
  greeting: string,
  pick: Pick<LanguagePick, "main" | "allowed">,
  ctx: LanguageContext = {},
): { language: VenueLanguage; text: string }[] {
  return [
    { language: pick.main, text: greeting },
    ...pick.allowed.slice(1).map((language) => ({ language, text: lineFor(location, "voice.also_speak", {}, { ...ctx, current: language }) })),
  ];
}
