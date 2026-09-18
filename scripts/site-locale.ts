/**
 * Countries and languages on the website.
 *
 * Four landing pages: the English one for the UAE at `/`, and one German
 * source (public/landing.de.html) rendered three times, for Germany, Austria
 * and Switzerland at /de-de, /de-at and /de-ch, each with its own market's
 * planned prices. Each German legal page (privacy.de.html, terms.de.html) is
 * rendered the same way, as a convenience translation beside the English
 * page that governs.
 *
 * This file owns what differs between those renders — the country and
 * language picker in the header, the language and canonical tags, the
 * hreflang alternates, the links between the pages and the Swiss spelling —
 * so scripts/build-site.ts only says which page goes where, and check-billing
 * and check-translations can render exactly what ships without building.
 *
 * The picker ships as a <details> element, so it opens and every country is a
 * link with no JavaScript at all; site.js upgrades it to a button with
 * aria-expanded that closes on Escape and on a click outside. Only languages
 * that exist are links. The rest are named, greyed and not links.
 */

import { applyIntegrations } from "./site-integrations";
import { GERMAN_PAGES, applyPricingDe, type DachMarket } from "./site-pricing-de";
import { applySiteFlags, swissSpelling } from "../src/lib/site-flags";
import { trialSentenceDe } from "../src/lib/billing/speak-de";
import { flag } from "../src/lib/flags";

type Env = Record<string, string | undefined>;

export const ORIGIN = "https://belline.ai";

/** Where each landing page is, in the order the picker lists them. */
export type SiteCountry = "AE" | DachMarket;

interface CountryPage {
  code: SiteCountry;
  /** The page's own language tag, for <html lang> and hreflang. */
  lang: "en" | "de-DE" | "de-AT" | "de-CH";
  ogLocale: string;
  /** The landing page's path, without a trailing slash except the root. */
  path: string;
  currency: string;
  name: { en: string; de: string };
}

export const COUNTRY_PAGES: readonly CountryPage[] = [
  { code: "AE", lang: "en", ogLocale: "en_AE", path: "/", currency: "AED", name: { en: "United Arab Emirates", de: "Vereinigte Arabische Emirate" } },
  { code: "DE", lang: "de-DE", ogLocale: "de_DE", path: "/de-de", currency: "EUR", name: { en: "Germany", de: "Deutschland" } },
  { code: "AT", lang: "de-AT", ogLocale: "de_AT", path: "/de-at", currency: "EUR", name: { en: "Austria", de: "Österreich" } },
  { code: "CH", lang: "de-CH", ogLocale: "de_CH", path: "/de-ch", currency: "CHF", name: { en: "Switzerland", de: "Schweiz" } },
];

const pageOf = (code: SiteCountry) => COUNTRY_PAGES.find((p) => p.code === code)!;

/**
 * The country pages this build actually publishes.
 *
 * The three DACH pages are German, and a German page published in Germany owes
 * a reader an Impressum naming a real company (§5 DDG). So `language.de`
 * decides whether they are built at all (scripts/build-site.ts), and the
 * picker, the alternates and the sitemap must offer exactly what was built —
 * a picker that links /de-de on a build without /de-de sends people to a 404,
 * and an hreflang that names a missing page tells search engines it exists.
 */
export function publishedCountries(): readonly CountryPage[] {
  return flag("language.de") ? COUNTRY_PAGES : COUNTRY_PAGES.filter((p) => p.code === "AE");
}

/** The legal pages, by English source: the English path and the German slug under each country. */
export const LEGAL_PAGES = {
  "privacy.html": { english: "/privacy", german: "datenschutz", source: "privacy.de.html" },
  "terms.html": { english: "/terms", german: "nutzungsbedingungen", source: "terms.de.html" },
} as const;

export type LegalPage = keyof typeof LEGAL_PAGES;

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const GLOBE = `<svg class="locale-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></svg>`;
const CHEVRON = `<svg class="locale-chev" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5"/></svg>`;

/**
 * The languages a country's page exists in, and the ones it does not yet.
 * A language is a link only when there is a page in it for that country.
 */
function languagesFor(code: SiteCountry): { label: string; lang: string; href?: string; dir?: string }[] {
  const page = pageOf(code);
  if (code === "AE") {
    return [
      { label: "English", lang: "en", href: page.path },
      { label: "العربية", lang: "ar", dir: "rtl" },
    ];
  }
  return [
    { label: "Deutsch", lang: "de", href: page.path },
    { label: "English", lang: "en" },
  ];
}

const START = "<!-- locale:start";
const END = "<!-- locale:end -->";
const MARKER_NOTE = "<!-- locale:start — generated by scripts/site-locale.ts: the country and language picker. Do not edit by hand. -->";

/** The picker for the page of `current`, in that page's language. */
export function renderLocalePicker(current: SiteCountry): string {
  const de = current !== "AE";
  const words = de
    ? { what: "Land und Sprache", country: "Land", language: "Sprache", later: "später" }
    : { what: "Country and language", country: "Country", language: "Language", later: "later" };
  const here = pageOf(current);
  const currentLanguage = languagesFor(current)[0].label;

  const countries = publishedCountries().map((p) => {
    const mark = p.code === current ? ' aria-current="page"' : "";
    const hreflang = p.lang === "en" ? "en" : p.lang;
    return `            <li><a href="${p.path}" hreflang="${hreflang}"${mark}><span class="locale-code" aria-hidden="true">${p.code}</span><span class="locale-name">${esc(p.name[de ? "de" : "en"])}</span><span class="locale-money">${p.currency}</span></a></li>`;
  }).join("\n");

  const languages = languagesFor(current)
    .map((l) =>
      l.href
        ? `            <li><a href="${l.href}" lang="${l.lang}" aria-current="page"><span class="locale-name">${l.label}</span></a></li>`
        : `            <li><span class="locale-off"><span class="locale-name" lang="${l.lang}"${l.dir ? ` dir="${l.dir}"` : ""}>${l.label}</span><em>${words.later}</em></span></li>`,
    )
    .join("\n");

  return `${MARKER_NOTE}
      <details class="locale" data-locale="${current}">
        <summary class="locale-btn">${GLOBE}<span class="vh">${words.what}: </span><span class="locale-now">${here.code} · ${currentLanguage}</span>${CHEVRON}</summary>
        <div class="locale-panel" id="locale-panel">
          <div>
            <p class="locale-h" id="locale-h-country">${words.country}</p>
            <ul class="locale-list" aria-labelledby="locale-h-country">
${countries}
            </ul>
          </div>
          <div>
            <p class="locale-h" id="locale-h-language">${words.language}</p>
            <ul class="locale-list" aria-labelledby="locale-h-language">
${languages}
            </ul>
          </div>
        </div>
      </details>
${END}`;
}

/** Replace the picker between its markers. Throws when they are gone. */
export function applyLocalePicker(html: string, current: SiteCountry): string {
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < 0 || to < from) throw new Error("A landing page has lost its locale:start / locale:end markers.");
  return `${html.slice(0, from)}${renderLocalePicker(current)}${html.slice(to + END.length)}`;
}

/** The hreflang alternates for one group of pages, as <link> lines. */
function alternates(links: { lang: string; href: string }[], xDefault: string): string {
  return [...links.map((l) => `<link rel="alternate" hreflang="${l.lang}" href="${l.href}">`), `<link rel="alternate" hreflang="x-default" href="${xDefault}">`].join("\n");
}

/** Every landing page names every other, and itself. */
export function landingAlternates(): string {
  return alternates(
    publishedCountries().map((p) => ({ lang: p.lang, href: `${ORIGIN}${p.path === "/" ? "/" : p.path}` })),
    `${ORIGIN}/`,
  );
}

/** A legal page's English original and its three convenience translations. */
export function legalAlternates(page: LegalPage): string {
  const legal = LEGAL_PAGES[page];
  return alternates(
    [
      { lang: "en", href: `${ORIGIN}${legal.english}` },
      ...publishedCountries().filter((p) => p.code !== "AE").map((p) => ({ lang: p.lang, href: `${ORIGIN}${p.path}/${legal.german}` })),
    ],
    `${ORIGIN}${legal.english}`,
  );
}

/** Put the alternates straight after the canonical link, replacing any already there. */
export function applyAlternates(html: string, links: string): string {
  const cleaned = html.replace(/<link rel="alternate" hreflang="[^"]*" href="[^"]*">\r?\n/g, "");
  const canonical = /(<link rel="canonical" href="[^"]*">)(\r?\n)/;
  if (!canonical.test(cleaned)) throw new Error("A page has no canonical link to put its hreflang alternates beside.");
  return cleaned.replace(canonical, (_m, link: string, nl: string) => `${link}${nl}${links.replace(/\n/g, nl)}${nl}`);
}

/**
 * The German source, as one country's page: its paths, language tag, locale
 * and waitlist country. The source is written for Germany (/de-de, de-DE), so
 * Germany is a no-op here apart from the spelling.
 */
function localise(html: string, market: DachMarket): string {
  const page = GERMAN_PAGES[market];
  const info = pageOf(market);
  let out = html
    .replace(/(["'(\s])\/de-de(?=["'/#?)\s])/g, `$1/${page.slug}`)
    .replace(/https:\/\/belline\.ai\/de-de(?=["/#?])/g, `${ORIGIN}/${page.slug}`)
    .replace(/<html lang="de-DE">/, `<html lang="${info.lang}">`)
    .replace(/<meta property="og:locale" content="de_DE">/, `<meta property="og:locale" content="${info.ogLocale}">`);
  // The waitlist's country, preselected for this page.
  out = out.replace(/(<select name="country"[^>]*>)([\s\S]*?)(<\/select>)/, (_m, open: string, options: string, close: string) => {
    const moved = options.replace(/ selected/g, "").replace(new RegExp(`(<option value="${market}")`), "$1 selected");
    return `${open}${moved}${close}`;
  });
  out = out.replace(/(<input type="hidden" name="page" value=")[^"]*(")/, `$1/${page.slug}$2`);
  return market === "CH" ? swissSpelling(out) : out;
}

/** One country's German landing page, complete: pricing, strip, picker, links, alternates and flag copy. */
export function renderGermanLanding(source: string, market: DachMarket, env: Env): string {
  let html = applyPricingDe(source, market);
  html = applyIntegrations(html, env, "de");
  // Localised before the picker and the alternates go in: both name all
  // three German pages, and must not be rewritten to this one.
  html = localise(html, market);
  html = applyLocalePicker(html, market);
  html = applyAlternates(html, landingAlternates());
  return applySiteFlags("landing.de.html", html, env, market === "CH" ? swissSpelling : undefined);
}

/** The English landing page's share of the same: its picker and its alternates. */
export function localiseEnglishLanding(html: string): string {
  return applyAlternates(applyLocalePicker(html, "AE"), landingAlternates());
}

/** One country's German legal page: the generated trial sentence, links, alternates and flag copy. */
export function renderGermanLegal(page: LegalPage, source: string, market: DachMarket, env: Env): string {
  let html = source;
  if (page === "terms.html") {
    const slot = /(<p class="gen" data-gen="trial-sentence">)[^<]*(<\/p>)/;
    if (!slot.test(html)) throw new Error("terms.de.html has lost its generated trial sentence.");
    html = html.replace(slot, (_m, open: string, close: string) => `${open}${esc(trialSentenceDe())}${close}`);
  }
  html = localise(html, market);
  html = applyAlternates(html, legalAlternates(page));
  return applySiteFlags(LEGAL_PAGES[page].source, html, env, market === "CH" ? swissSpelling : undefined);
}
