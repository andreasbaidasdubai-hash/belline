import type { Location, VenueLanguage } from "./types";
import { flag } from "./flags";
import { copy, type CopyKey } from "./customer-copy";

/**
 * Which language a venue's customers are answered in.
 *
 * One answer, read by everything a customer meets: the recogniser, the voice,
 * the prompt, the spoken-number layer, the guards and every line the system
 * says or writes by itself. A second place deciding for itself is how a German
 * caller ends up hearing an English voicemail after a German greeting.
 *
 * German is off unless two things agree: the owner chose it for the venue, and
 * the `language.de` flag is on for the deployment. With the flag off every
 * venue is answered in English whatever it has saved — so turning the flag off
 * is a complete rollback, not a request.
 *
 * The owner's dashboard stays English either way. This is about the people
 * who ring, write and book, not the people who run the business.
 */

type Env = Record<string, string | undefined>;

export { LANGUAGES } from "./customer-copy";

/** Whether owners may choose a language other than English on this deployment. */
export function languageChoiceOpen(env: Env = process.env): boolean {
  return flag("language.de", env);
}

/** A value from a form or a request, or null when it is not a language we answer in. */
export function parseLanguage(raw: unknown): VenueLanguage | null {
  return raw === "en" || raw === "de" ? raw : null;
}

/** The single source: what this venue's customers are answered in, right now. */
export function answersIn(location: Pick<Location, "language">, env: Env = process.env): VenueLanguage {
  return location.language === "de" && flag("language.de", env) ? "de" : "en";
}

/**
 * Where the German is spoken, from what a venue already says about itself.
 *
 * There is no country field, so the clock and the money decide: a Zurich
 * timezone or Swiss francs is Switzerland, Vienna is Austria, anything else
 * Germany. Used for the recogniser's Swiss German model and Swiss spelling;
 * nothing else about a reply changes by country.
 */
export type GermanVariant = "de-DE" | "de-AT" | "de-CH";

export function germanVariant(location: Pick<Location, "timezone" | "currency">): GermanVariant {
  if (location.timezone === "Europe/Zurich" || location.timezone === "Europe/Vaduz" || location.currency === "CHF") {
    return "de-CH";
  }
  if (location.timezone === "Europe/Vienna") return "de-AT";
  return "de-DE";
}

/** The BCP 47 tag customers are answered in: "en", or the German variant. */
export function localeOf(
  location: Pick<Location, "language" | "timezone" | "currency">,
  env: Env = process.env,
): "en" | GermanVariant {
  return answersIn(location, env) === "de" ? germanVariant(location) : "en";
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

/** Written text as a venue's customer should read it: Swiss spelling in Switzerland, else unchanged. */
export function inHouseSpelling(
  location: Pick<Location, "language" | "timezone" | "currency">,
  text: string,
  env: Env = process.env,
): string {
  return localeOf(location, env) === "de-CH" ? swissSpelling(text) : text;
}

/**
 * A system line for this venue's customers, in their language and spelling.
 * The way customer-facing code reaches customer-copy.ts.
 */
export function lineFor(
  location: Pick<Location, "language" | "timezone" | "currency">,
  key: CopyKey,
  vars: Record<string, string | number> = {},
  env: Env = process.env,
): string {
  return inHouseSpelling(location, copy(answersIn(location, env), key, vars), env);
}
