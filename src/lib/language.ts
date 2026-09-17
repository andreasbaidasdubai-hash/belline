import type { Location, VenueLanguage, VenueLanguages } from "./types";
import { flag } from "./flags";
import { copy, copyComplete, type CopyKey } from "./customer-copy";
import { guardsCover } from "./agent/guard-phrases";
import {
  LANGUAGE_REGISTRY,
  MAX_ALSO_LANGUAGES,
  LANGUAGE_CHANNELS,
  isLanguageCode,
  languageEntry,
  type LanguageChannel,
  type LanguageCode,
  type LanguageVariant,
} from "../config/languages";
import { MARKETS, type Market } from "./markets";

/**
 * Which language a business's customers are answered in.
 *
 * One answer, read by everything a customer meets: the recogniser, the voice,
 * the prompt, the spoken-number layer, the guards and every line the system
 * says or writes by itself. A second place deciding for itself is how a German
 * caller ends up hearing an English voicemail after a German greeting.
 *
 * A business has a main language and up to two more (`Location.languages`).
 * A language counts only while three things agree: the registry lists it as
 * live (config/languages.ts), its flag is on for the deployment, and it is
 * fully built — every customer line and every guard. Anything else is
 * answered in English, whatever was saved, so switching a flag off is a
 * complete rollback, not a request.
 *
 * The owner's dashboard stays English either way. This is about the people
 * who ring, write and book, not the people who run the business.
 */

type Env = Record<string, string | undefined>;

export type { LanguageChannel, LanguageCode };

/** Where the conversation is happening, for a per-channel main language. */
export interface LanguageContext {
  channel?: LanguageChannel;
  /** The language this conversation has settled on, when it has. Used only if the business allows it. */
  current?: VenueLanguage | null;
  env?: Env;
}

/**
 * Whether a language can be used on this deployment at all: live, flag on,
 * every customer line written and every guard able to read it.
 */
export function languageUsable(code: VenueLanguage, env: Env = process.env): boolean {
  const entry = languageEntry(code);
  if (entry.status !== "live") return false;
  if (entry.flag && !flag(entry.flag, env)) return false;
  return copyComplete(code) && guardsCover(code);
}

/** The languages an owner may choose from right now, English first. */
export function selectableLanguages(env: Env = process.env): (typeof LANGUAGE_REGISTRY)[number][] {
  return LANGUAGE_REGISTRY.filter((l) => languageUsable(l.code, env));
}

/** Whether owners may choose anything other than English on this deployment. */
export function languageChoiceOpen(env: Env = process.env): boolean {
  return selectableLanguages(env).length > 1;
}

/** A value from a form or a request, or null when it is not a live language in the registry. */
export function parseLanguage(raw: unknown): VenueLanguage | null {
  return isLanguageCode(raw) && languageEntry(raw).status === "live" ? raw : null;
}

/**
 * The language a business in a country starts with.
 *
 * From the market, the only country field a venue has. The countries registry
 * being built separately replaces this function; nothing else reads a market
 * to decide a language.
 */
export function defaultLanguageFor(location: CountryHints): VenueLanguage {
  return DEFAULT_LANGUAGE_BY_MARKET[marketOfVenue(location)] ?? "en";
}

/** What a venue says about its country: a market, or its money and its clock. */
export interface CountryHints {
  market?: Market;
  subscription?: { market?: Market };
  currency?: string;
  timezone?: string;
}

const DEFAULT_LANGUAGE_BY_MARKET: Partial<Record<Market, VenueLanguage>> = { DE: "de", AT: "de", CH: "de" };

function marketOfVenue(location: CountryHints): Market {
  if (location.market) return location.market;
  if (location.subscription?.market) return location.subscription.market;
  const codes = Object.keys(MARKETS) as Market[];
  return (
    codes.find((m) => MARKETS[m].currency === location.currency && MARKETS[m].timezone === location.timezone) ??
    codes.find((m) => MARKETS[m].currency === location.currency) ??
    "AE"
  );
}

/** Which of the owner-settable channels a conversation is on. */
export function languageChannelOf(channel: "browser" | "embed" | "phone" | "whatsapp" | "webchat"): LanguageChannel {
  switch (channel) {
    case "phone":
      return "phone";
    case "whatsapp":
      return "whatsapp";
    case "webchat":
      return "web_chat";
    default:
      // The bell on a website and the owner's own test console are both a call through a browser.
      return "web_voice";
  }
}

/** A business's settings as saved, with the old single `language` read as its main language. */
export function savedLanguages(location: Pick<Location, "language" | "languages">): VenueLanguages {
  if (location.languages) return location.languages;
  return { main: location.language ?? "en", also: [], pick: "auto" };
}

/** The plain English setting every business had before languages. */
export function isPlainEnglish(settings: VenueLanguages): boolean {
  return (
    settings.main === "en" &&
    settings.also.length === 0 &&
    settings.pick === "auto" &&
    !Object.keys(settings.channels ?? {}).length &&
    !Object.keys(settings.formality ?? {}).length
  );
}

export interface EffectiveLanguages {
  main: VenueLanguage;
  /** Usable, distinct, never the main one, at most MAX_ALSO_LANGUAGES. */
  also: VenueLanguage[];
  pick: "auto" | "ask";
}

/**
 * What a business answers in on this channel, right now: the saved settings
 * with every language that cannot be used taken out. A main language that
 * cannot be used becomes English.
 */
export function languagesFor(location: Pick<Location, "language" | "languages">, ctx: LanguageContext = {}): EffectiveLanguages {
  const env = ctx.env ?? process.env;
  const saved = savedLanguages(location);
  const wanted = (ctx.channel && saved.channels?.[ctx.channel]) || saved.main;
  const main = isLanguageCode(wanted) && languageUsable(wanted, env) ? wanted : "en";
  const also = [...new Set([saved.main, ...saved.also])]
    .filter((l) => isLanguageCode(l) && l !== main && languageUsable(l, env))
    .slice(0, MAX_ALSO_LANGUAGES);
  // A channel override adds its language; the business's own main stays reachable as one of the others.
  return { main, also, pick: saved.pick === "ask" ? "ask" : "auto" };
}

/** Main first, then the others. */
export function allowedLanguages(location: Pick<Location, "language" | "languages">, ctx: LanguageContext = {}): VenueLanguage[] {
  const { main, also } = languagesFor(location, ctx);
  return [main, ...also];
}

/**
 * The single source: what this customer is answered in. The conversation's
 * own language when it has one the business allows, otherwise the main one.
 */
export function answersIn(location: Pick<Location, "language" | "languages">, ctx: LanguageContext = {}): VenueLanguage {
  const allowed = allowedLanguages(location, ctx);
  return ctx.current && allowed.includes(ctx.current) ? ctx.current : allowed[0];
}

/** The form of address for a language at this business: its own choice, or the registry's default. */
export function formalityOf(location: Pick<Location, "language" | "languages">, code: VenueLanguage): string | null {
  const entry = languageEntry(code);
  if (!entry.formality) return null;
  const chosen = savedLanguages(location).formality?.[code];
  return chosen && entry.formality.options.includes(chosen) ? chosen : entry.formality.default;
}

// ---------------------------------------------------------------------------
// Validation, for the settings screen's save
// ---------------------------------------------------------------------------

export type LanguagesCheck = { ok: true; value: VenueLanguages } | { ok: false; error: string; field: string };

/**
 * An owner's settings, or why not. Only languages selectable on this
 * deployment; at most MAX_ALSO_LANGUAGES more, never the main one.
 * `selectable` is injectable so the limits can be tested before a third
 * language exists.
 */
export function checkLanguages(raw: unknown, selectable: readonly VenueLanguage[] = selectableLanguages().map((l) => l.code)): LanguagesCheck {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Choose a main language.", field: "main" };
  const body = raw as Record<string, unknown>;
  const allowed = new Set<string>(selectable);
  const name = (code: unknown) => (isLanguageCode(code) ? languageEntry(code).name : String(code));

  if (!isLanguageCode(body.main) || !allowed.has(body.main)) {
    return { ok: false, error: `${name(body.main)} is not available as a main language.`, field: "main" };
  }
  const main = body.main;

  const alsoRaw = body.also ?? [];
  if (!Array.isArray(alsoRaw)) return { ok: false, error: "Choose the other languages from the list.", field: "also" };
  if (alsoRaw.length > MAX_ALSO_LANGUAGES) {
    return { ok: false, error: `Belle can speak at most ${MAX_ALSO_LANGUAGES} languages besides the main one.`, field: "also" };
  }
  const also: VenueLanguage[] = [];
  for (const code of alsoRaw) {
    if (!isLanguageCode(code) || !allowed.has(code)) return { ok: false, error: `${name(code)} is not available yet.`, field: "also" };
    if (code === main) return { ok: false, error: `${name(code)} is already the main language.`, field: "also" };
    if (also.includes(code)) return { ok: false, error: `${name(code)} is listed twice.`, field: "also" };
    also.push(code);
  }

  const pick = body.pick ?? "auto";
  if (pick !== "auto" && pick !== "ask") return { ok: false, error: "Choose how Belle picks the language.", field: "pick" };

  const channels: Partial<Record<LanguageChannel, VenueLanguage>> = {};
  if (body.channels !== undefined) {
    if (!body.channels || typeof body.channels !== "object") return { ok: false, error: "Choose a language per channel.", field: "channels" };
    for (const [channel, code] of Object.entries(body.channels as Record<string, unknown>)) {
      if (!(LANGUAGE_CHANNELS as readonly string[]).includes(channel)) return { ok: false, error: `Unknown channel ${channel}.`, field: "channels" };
      if (code === null || code === undefined || code === "") continue;
      if (!isLanguageCode(code) || !allowed.has(code)) return { ok: false, error: `${name(code)} is not available yet.`, field: `channels.${channel}` };
      channels[channel as LanguageChannel] = code;
    }
  }

  const formality: Partial<Record<VenueLanguage, string>> = {};
  if (body.formality !== undefined) {
    if (!body.formality || typeof body.formality !== "object") return { ok: false, error: "Choose a form of address.", field: "formality" };
    for (const [code, form] of Object.entries(body.formality as Record<string, unknown>)) {
      const options = isLanguageCode(code) ? languageEntry(code).formality?.options : undefined;
      if (!options || typeof form !== "string" || !options.includes(form)) {
        return { ok: false, error: `Choose a form of address from the list for ${name(code)}.`, field: `formality.${code}` };
      }
      if (form !== languageEntry(code as VenueLanguage).formality!.default) formality[code as VenueLanguage] = form;
    }
  }

  return {
    ok: true,
    value: {
      main,
      also,
      pick,
      ...(Object.keys(channels).length ? { channels } : {}),
      ...(Object.keys(formality).length ? { formality } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Variants, spelling and system lines
// ---------------------------------------------------------------------------

/** Where a language is spoken, from what a venue already says about itself: its clock and its money. */
export function variantOf(location: Pick<Location, "timezone" | "currency">, code: VenueLanguage): LanguageVariant {
  const variants = languageEntry(code).variants;
  return (
    variants.find(
      (v) => v.timezones?.includes(location.timezone) || v.currencies?.includes(location.currency),
    ) ?? variants[0]
  );
}

export type GermanVariant = "de-DE" | "de-AT" | "de-CH";

/** Germany, Austria or Switzerland. Kept for the German code that asks by name. */
export function germanVariant(location: Pick<Location, "timezone" | "currency">): GermanVariant {
  return variantOf(location, "de").tag as GermanVariant;
}

type Venue = Pick<Location, "language" | "languages" | "timezone" | "currency">;

/** The BCP 47 tag customers are answered in: "en", or the language's variant ("de-CH"). */
export function localeOf(location: Venue, ctx: LanguageContext = {}): string {
  const code = answersIn(location, ctx);
  return code === "en" ? "en" : variantOf(location, code).tag;
}

/**
 * Swiss Standard German has no ß: "Strasse", "grüssen". A written reply to a
 * Swiss customer that uses it reads as sent from Germany, so written text for a
 * de-CH venue is put through this — deterministically, after the model, since a
 * prompt asking for it is a request and this is a guarantee.
 */
export function swissSpelling(text: string): string {
  return text.replace(/ß/g, "ss").replace(/ẞ/g, "SS");
}

/** Written text as a venue's customer should read it: the variant's spelling, else unchanged. */
export function inHouseSpelling(location: Venue, text: string, ctx: LanguageContext = {}): string {
  const code = answersIn(location, ctx);
  return code !== "en" && variantOf(location, code).noEszett ? swissSpelling(text) : text;
}

/**
 * A system line for this venue's customers, in their language and spelling.
 * The way customer-facing code reaches customer-copy.ts.
 */
export function lineFor(location: Venue, key: CopyKey, vars: Record<string, string | number> = {}, ctx: LanguageContext = {}): string {
  return inHouseSpelling(location, copy(answersIn(location, ctx), key, vars), ctx);
}

/** Right to left, for a language written that way. */
export function directionOf(code: VenueLanguage): "ltr" | "rtl" {
  return languageEntry(code).dir;
}

/**
 * "Also speaks Deutsch", in the main language, for the chat box and the
 * website widget. Null for a business that speaks one language.
 */
export function languageNotice(location: Venue, ctx: LanguageContext = {}): string | null {
  const { main, also } = languagesFor(location, ctx);
  if (!also.length) return null;
  return inHouseSpelling(
    location,
    copy(main, "notice.also_speaks", { languages: also.map((l) => languageEntry(l).nativeName).join(" · ") }),
    { ...ctx, current: main },
  );
}

// ---------------------------------------------------------------------------
// Following a written conversation
// ---------------------------------------------------------------------------

/**
 * Which of `candidates` a message is written in, or null when it cannot tell.
 *
 * For chat and WhatsApp, which switch the moment a customer writes in another
 * chosen language: the model follows by itself (see the prompt), and this is
 * how the system's own lines and the guards' repairs follow too. Deliberately
 * plain — a script, then counting each language's common short words — and
 * silent when unsure, so "ok" or "19:00" never moves a conversation.
 */
export function detectLanguage(text: string, candidates: readonly VenueLanguage[]): VenueLanguage | null {
  if (candidates.length < 2 || !text.trim()) return null;
  for (const code of candidates) {
    const entry = languageEntry(code);
    if (entry.script === "Arabic" && /[؀-ۿ]/.test(text)) return code;
  }
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (!words.length) return null;
  let best: VenueLanguage | null = null;
  let bestScore = 0;
  let second = 0;
  for (const code of candidates) {
    const markers = new Set<string>(languageEntry(code).markers);
    let score = words.filter((w) => markers.has(w)).length;
    // Letters only one of the languages uses settle a short message.
    if (code === "de" && /[äöüß]/i.test(text)) score += 2;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = code;
    } else if (score > second) {
      second = score;
    }
  }
  return bestScore >= 1 && bestScore > second ? best : null;
}

/** The registry code for a recogniser's language tag ("de-CH" → "de"), when it is one of `candidates`. */
export function languageOfTag(tag: string | undefined, candidates: readonly VenueLanguage[]): VenueLanguage | null {
  if (!tag) return null;
  const base = tag.toLowerCase().split("-")[0];
  return candidates.find((c) => c === base) ?? null;
}
