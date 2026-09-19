/**
 * The privacy notice a cold-email recipient is owed, and where it lives.
 *
 * A prospect never asked to be in our list. We found them in a public
 * business listing and on their own website, and the moment we write to
 * dr.sara@ we are processing a named person's data without having spoken to
 * her. Articles 13 and 14 GDPR say that the first message is when she has to
 * be told, in plain terms, who is processing, what, why, for how long and how
 * to make it stop; Article 21 gives her an absolute right to object to direct
 * marketing, which we must honour without argument. An unsubscribe link
 * satisfies none of that on its own — it stops the next email, it does not
 * tell her what we hold.
 *
 * So there is a page, and this module is the one place that knows where it is
 * and whether it may be published at all. Two consumers, as with
 * `identity.ts`: `scripts/build-site.ts` publishes the page, and the outreach
 * engine puts its URL in every footer and refuses to send without it.
 *
 * Nothing here is legal advice. The page it points at states an Art. 6(1)(f)
 * basis and says plainly where that basis is arguable; see `docs` and the
 * cautions in `sales/sending/countries.ts` for the same honesty applied to
 * the sending decision itself.
 */

import type { Env, LegalIdentity } from "./identity";
import { legalEnvKey, missingIdentityFields } from "./identity";

/**
 * Where the notice is published on belline.ai.
 *
 * `vercel.json` has `cleanUrls`, so `outreach-privacy.html` is served at
 * `/outreach-privacy`. The German original is rendered once per DACH country
 * beside the other German legal pages (scripts/site-locale.ts).
 */
export const OUTREACH_PRIVACY_PATH = "/outreach-privacy";
export const OUTREACH_PRIVACY_SLUG_DE = "datenschutz-kontaktaufnahme";

/** The source files, so the build and the checks name them once. */
export const OUTREACH_PRIVACY_SOURCE = "outreach-privacy.html";
export const OUTREACH_PRIVACY_SOURCE_DE = "outreach-privacy.de.html";

/** Which DACH page a German-language recipient is sent to, by country. */
const GERMAN_PATHS: Record<string, string> = {
  DE: `/de-de/${OUTREACH_PRIVACY_SLUG_DE}`,
  AT: `/de-at/${OUTREACH_PRIVACY_SLUG_DE}`,
  CH: `/de-ch/${OUTREACH_PRIVACY_SLUG_DE}`,
};

const DEFAULT_ORIGIN = "https://belline.ai";

/**
 * The origin the notice is served from.
 *
 * Defaults to belline.ai, which is where the build puts it. A sending domain
 * that grows its own one-page site can host a copy and point the footers at
 * it with `OUTREACH_PRIVACY_ORIGIN` — the link in a cold email then stays on
 * the domain the mail came from, which is both less jarring for the reader
 * and one fewer cross-domain hop for a spam filter to dislike. The page's
 * content does not change: the controller is the same company either way.
 */
export function outreachPrivacyOrigin(env: Env = process.env): string {
  const origin = env.OUTREACH_PRIVACY_ORIGIN?.trim() || env.SITE_ORIGIN?.trim() || DEFAULT_ORIGIN;
  return origin.replace(/\/+$/, "");
}

export interface PrivacyUrlInput {
  /** The language the message is written in — the footer's language. */
  language: string;
  /** The recipient's country, which picks between /de-de, /de-at and /de-ch. */
  countryCode?: string | null;
  env?: Env;
}

/**
 * The notice's URL, in the recipient's own language where we have one.
 *
 * German for DE, AT and CH, exactly as the unsubscribe wording already is. A
 * German recipient handed an English privacy notice has, in practice, not
 * been informed — and "informed in a language the data subject understands"
 * is the part of Art. 12(1) that an Abmahnung is built on.
 */
export function outreachPrivacyUrl(input: PrivacyUrlInput): string {
  const origin = outreachPrivacyOrigin(input.env);
  const german = input.language.toLowerCase().startsWith("de");
  if (!german) return `${origin}${OUTREACH_PRIVACY_PATH}`;
  const code = (input.countryCode ?? "").trim().toUpperCase();
  return `${origin}${GERMAN_PATHS[code] ?? GERMAN_PATHS.DE}`;
}

/**
 * The identity fields the notice cannot be honest without.
 *
 * The same five that let us write into Germany at all
 * (`sales/sending/countries.ts` DACH_IDENTITY), and for the same reason: a
 * notice under Art. 13/14 whose controller is "Belline" and whose address is
 * "reachable at hello@belline.ai" names nobody. check-mail-privacy pins the
 * two lists together so they cannot drift apart.
 */
export const NOTICE_IDENTITY: readonly (keyof LegalIdentity)[] = [
  "entity",
  "address",
  "managingDirector",
  "registration",
  "email",
];

/**
 * Words that mean somebody typed something to make a screen go green.
 *
 * `identity.ts` says in as many words: "Do not fill one of them with a
 * plausible-looking placeholder." This is that sentence with teeth. A
 * publishable privacy notice naming "Example Ltd, 123 Main Street" is worse
 * than no page: it is a document that looks like compliance and is a
 * falsehood, served from our own domain, over our own signature.
 *
 * Matched case-insensitively. The short ones are whole-word only, so a real
 * company called "Attestor" is not rejected for containing "test".
 */
const PLACEHOLDER_PHRASES: readonly string[] = [
  "placeholder",
  "your company",
  "company name",
  "your name",
  "your address",
  "coming soon",
  "to be confirmed",
  "to be decided",
  "in formation",
  "in gründung",
  "in gruendung",
  "fill in",
  "fill me",
  "change me",
  "not yet",
  "123 main",
  "1 example",
  "musterstr",
  "musterstadt",
  "musterfirma",
  "max mustermann",
  "lorem ipsum",
  "john doe",
  "jane doe",
  "acme",
];

const PLACEHOLDER_WORDS: readonly string[] = [
  "tbd",
  "tba",
  "todo",
  "example",
  "examples",
  "beispiel",
  "muster",
  "dummy",
  "sample",
  "foo",
  // Not "bar", "baz" or "na": they are a Hebrew surname particle, a Turkish
  // spice market and half the street names in Prague. A check that rejects
  // "Naomi Bar-On" is a check the founder will work around.
  "xxx",
  "xxxx",
  "none",
  "null",
  "unknown",
  "pending",
  "n/a",
  "test",
  "testing",
];

/** A registration or VAT number that is plainly not one: 0000, 123456, 11111. */
function looksLikeFakeNumber(value: string): boolean {
  const digits = value.replace(/\D+/g, "");
  if (digits.length < 4) return false;
  if (/^(\d)\1*$/.test(digits)) return true;
  return "0123456789".includes(digits) || "9876543210".includes(digits);
}

/** True when this one value reads as a stand-in rather than a fact. */
export function looksLikePlaceholder(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (!text) return false;
  if (PLACEHOLDER_PHRASES.some((p) => text.includes(p))) return true;
  const words = text.split(/[^a-z0-9/]+/).filter(Boolean);
  if (words.some((w) => PLACEHOLDER_WORDS.includes(w))) return true;
  return looksLikeFakeNumber(text);
}

/** Which of the notice's fields have been filled with something fictional. */
export function placeholderIdentityFields(identity: LegalIdentity): (keyof LegalIdentity)[] {
  return NOTICE_IDENTITY.filter((field) => looksLikePlaceholder(identity[field] ?? ""));
}

export interface NoticeReadiness {
  /** True when the page may be published: every field filled, none invented. */
  ready: boolean;
  /** Fields still empty. Honest, and the ordinary state before the company exists. */
  missing: (keyof LegalIdentity)[];
  /** Fields filled with something fictional. Never acceptable. */
  placeholders: (keyof LegalIdentity)[];
}

/**
 * Whether the notice can be published, and if not, which of the two problems
 * it is — because they are not the same problem.
 *
 * Empty is the truth today: there is no company, so there is no controller to
 * name, and the build simply does not publish the page (nor can the engine
 * send, which is the same gate seen from the other side). Invented is a lie,
 * and the build refuses outright rather than skipping quietly.
 */
export function noticeReadiness(identity: LegalIdentity): NoticeReadiness {
  const missing = missingIdentityFields(identity, NOTICE_IDENTITY);
  const placeholders = placeholderIdentityFields(identity);
  return { ready: missing.length === 0 && placeholders.length === 0, missing, placeholders };
}

/** The refusal, as something the founder can act on. */
export function describePlaceholders(fields: readonly (keyof LegalIdentity)[]): string {
  return fields.map((f) => `${f} (${legalEnvKey(f)})`).join(", ");
}
