/**
 * Which pages of the search-landing system exist, and what their URLs are.
 *
 * One place decides all of it, so adding a city, a trade or a whole framing is
 * a data edit and nothing here changes shape. The file split is deliberate:
 *
 *   verticals.ts   what is true about a trade
 *   cities.ts      what is true about a city
 *   pairs.ts       what is only true where the two meet
 *   channels.ts    the WhatsApp and call-answering pages, which are neither
 *   matrix.ts      which of them we publish, and where they live
 *
 * URLs
 *
 *   /{framing}                            the framing's own hub
 *   /{framing}/{trade}                    the trade hub
 *   /{framing}/in/{country}               the country hub
 *   /{framing}/in/{country}/{city}        the city hub
 *   /{framing}/{trade}/{country}/{city}   the landing page itself
 *
 * **Why the country segment.** The first three pages shipped as
 * `/ai-receptionist/{trade}/{city}`, and the September 2026 keyword research
 * (docs/seo/uae-keywords.md) argued the shape out of it before it had thirty
 * pages in it: city slugs are not globally unique — London Ontario, Newcastle,
 * Springfield — so adding a second country later would have been a URL
 * migration rather than a data edit. `{country}` is the ISO code already in
 * src/lib/markets.ts, lower-cased, which means `marketLive()` keeps deciding
 * waitlist-versus-checkout for free. The three published URLs are redirected
 * permanently: src/lib/seo-redirects.ts.
 *
 * **Why the framing segment.** The research found three phrases worth a page
 * and one word worth avoiding. "AI receptionist" names the whole product and
 * leads every title. "Call answering" is the growth phrase and earns its own
 * page, but its geo-modified form is dead in the UAE, so it never carries a
 * city. "WhatsApp chatbot" has the richest UAE long tail and earns trade-level
 * pages of its own — as *chatbot*, never *bot*, because the "bot" spelling is
 * the collapsing hobbyist end of that market. With the framing in the root
 * there was nowhere to put either but a second site.
 *
 * `{framing}` is a closed set declared here, so no renderer writes a path by
 * hand and the hreflang, sitemap and breadcrumb logic follows unchanged.
 *
 * **Publishing is opt-in.** `PUBLISHED` lists the combinations this build
 * writes. `SEO_PAGES=all` builds every combination that has pair copy.
 *
 * **Languages.** Every path here is the English one, and `seoAlternates`
 * renders the hreflang block through the same helper shape the German pages
 * use (scripts/site-locale.ts). Today there is one locale, so the block is
 * `en` plus `x-default`. Adding German is adding a locale to `SEO_LOCALES`
 * with its prefix and its translated framing slugs, and writing the copy — not
 * a refactor of the renderer, which never builds a URL by hand.
 */

import { MARKETS, type Market } from "../../src/lib/markets";
import { SEO_CITIES, seoCity, seoCountry, type SeoCity } from "./cities";
import { SEO_VERTICALS, seoVertical, type SeoVertical } from "./verticals";
import { seoPair, type PairCopy } from "./pairs";
import { CHANNEL_HUBS, CHANNEL_TRADE_PAGES, type ChannelHubCopy, type ChannelTradeCopy } from "./channels";

export const ORIGIN = "https://belline.ai";

/**
 * The three framings, and the one rule about each.
 *
 * `matrix: true` means this framing carries the trade × city landing pages.
 * Only one does. The other two are a hub and, for WhatsApp, a page per trade —
 * because `whatsapp chatbot dubai` is a confirmed UAE query and
 * `whatsapp chatbot for salons in sharjah` is an invented one.
 */
export type FramingSlug = "ai-receptionist" | "whatsapp-chatbot" | "call-answering";

export interface SeoFraming {
  slug: FramingSlug;
  /** The noun as a title uses it: "AI receptionist". */
  name: string;
  matrix: boolean;
}

export const SEO_FRAMINGS: readonly SeoFraming[] = [
  { slug: "ai-receptionist", name: "AI receptionist", matrix: true },
  { slug: "whatsapp-chatbot", name: "WhatsApp chatbot", matrix: false },
  { slug: "call-answering", name: "Call answering", matrix: false },
];

/** The framing the matrix hangs off. Every trade × city page is under it. */
export const MATRIX_FRAMING: FramingSlug = "ai-receptionist";

/** The root the matrix hangs off, for anything that still wants one string. */
export const SEO_ROOT = `/${MATRIX_FRAMING}`;

/**
 * The locales these pages exist in.
 *
 * One today. A second is `{ lang: "de-DE", prefix: "/de-de", framing: {…} }`
 * with translated slugs plus translated data — the renderer reads both from
 * here and never writes a path itself, so the alternates, the canonicals and
 * the sitemap all follow from this array.
 */
export interface SeoLocale {
  lang: string;
  /** "" for English, "/de-de" for a language that lives under a prefix. */
  prefix: string;
  /** What each framing's segment is called in this language. */
  framing: Record<FramingSlug, string>;
  xDefault?: boolean;
}

export const SEO_LOCALES: readonly SeoLocale[] = [
  {
    lang: "en",
    prefix: "",
    framing: { "ai-receptionist": "ai-receptionist", "whatsapp-chatbot": "whatsapp-chatbot", "call-answering": "call-answering" },
    xDefault: true,
  },
];

const localeOf = (lang: string) => SEO_LOCALES.find((l) => l.lang === lang) ?? SEO_LOCALES[0];

/** The country segment: the ISO code from the market table, lower-cased. */
export const countrySlug = (market: Market) => market.toLowerCase();

export const framingPath = (framing: FramingSlug = MATRIX_FRAMING, lang = "en") => {
  const locale = localeOf(lang);
  return `${locale.prefix}/${locale.framing[framing]}`;
};
export const indexPath = (lang = "en") => framingPath(MATRIX_FRAMING, lang);
export const verticalHubPath = (v: string, framing: FramingSlug = MATRIX_FRAMING, lang = "en") => `${framingPath(framing, lang)}/${v}`;
export const countryHubPath = (market: Market, lang = "en") => `${framingPath(MATRIX_FRAMING, lang)}/in/${countrySlug(market)}`;
export const cityHubPath = (city: SeoCity, lang = "en") => `${countryHubPath(city.market, lang)}/${city.slug}`;
export const comboPath = (v: string, city: SeoCity, lang = "en") =>
  `${framingPath(MATRIX_FRAMING, lang)}/${v}/${countrySlug(city.market)}/${city.slug}`;

/** Every combination the data allows, in a stable order. */
export const MATRIX: readonly { vertical: string; city: string }[] = SEO_VERTICALS.flatMap((v) =>
  SEO_CITIES.map((c) => ({ vertical: v.slug, city: c.slug })),
);

/**
 * The combinations this build publishes.
 *
 * Fifteen in the UAE — five trades across Dubai, Abu Dhabi and Sharjah — and
 * one in London, which is a market we are not open in and is here on purpose:
 * it is the shape the system has to keep getting right, a page with the same
 * substance and no way to buy. Manchester and Dublin were dropped with it;
 * three waitlist cities was two more than the honesty of the exercise needed.
 *
 * `SEO_PAGES=all` publishes every combination that has pair copy written.
 */
const PUBLISHED = [
  "restaurants/dubai",
  "restaurants/abu-dhabi",
  "restaurants/sharjah",
  "hair-salons/dubai",
  "hair-salons/abu-dhabi",
  "hair-salons/sharjah",
  "dental-clinics/dubai",
  "dental-clinics/abu-dhabi",
  "dental-clinics/sharjah",
  "aesthetic-clinics/dubai",
  "aesthetic-clinics/abu-dhabi",
  "aesthetic-clinics/sharjah",
  "real-estate/dubai",
  "real-estate/abu-dhabi",
  "real-estate/sharjah",
  "dental-clinics/london",
];

export function publishedCombos(env: Record<string, string | undefined> = process.env): { vertical: string; city: string }[] {
  const all = (env.SEO_PAGES ?? "").toLowerCase() === "all";
  return MATRIX.filter(({ vertical, city }) => {
    const key = `${vertical}/${city}`;
    if (!all && !PUBLISHED.includes(key)) return false;
    // No pair copy, no page. A combination without hand-written local
    // substance would be the template this whole system exists to avoid, so
    // "all" means every combination somebody has actually written.
    return seoPair(vertical, city) !== null;
  }).map((x) => ({ ...x }));
}

/**
 * A combination named for publication but missing its pair copy is a mistake,
 * not a quiet omission: somebody meant to publish it.
 */
export function missingPairCopy(): string[] {
  return PUBLISHED.filter((key) => {
    const [vertical, city] = key.split("/");
    return seoPair(vertical, city) === null;
  });
}

export interface ComboPage {
  kind: "combo";
  path: string;
  vertical: SeoVertical;
  city: SeoCity;
  pair: PairCopy;
}
export interface HubPage {
  kind: "vertical-hub" | "city-hub" | "country-hub" | "index";
  path: string;
  vertical?: SeoVertical;
  city?: SeoCity;
  market?: Market;
  /** The published combinations this hub links to. */
  combos: { vertical: SeoVertical; city: SeoCity; path: string }[];
}
/** `/whatsapp-chatbot` and `/call-answering`: a framing's own page. */
export interface ChannelHubPage {
  kind: "channel-hub";
  path: string;
  framing: SeoFraming;
  copy: ChannelHubCopy;
  /** The trade pages under it, for its own links. */
  trades: { vertical: SeoVertical; path: string }[];
}
/** `/whatsapp-chatbot/<trade>`. */
export interface ChannelTradePage {
  kind: "channel-trade";
  path: string;
  framing: SeoFraming;
  vertical: SeoVertical;
  copy: ChannelTradeCopy;
}
export type SeoPage = ComboPage | HubPage | ChannelHubPage | ChannelTradePage;

export const seoFraming = (slug: FramingSlug): SeoFraming => {
  const found = SEO_FRAMINGS.find((f) => f.slug === slug);
  if (!found) throw new Error(`No framing named "${slug}" (scripts/seo/matrix.ts).`);
  return found;
};

/**
 * Every page this build writes, hubs included.
 *
 * Hubs are derived rather than listed: a trade hub exists when at least one of
 * its cities is published, and it links only to the pages this same build
 * writes. That is the rule that keeps the set honest — no link on any page
 * pointing at a URL that will 404. scripts/check-seo.ts re-derives the set and
 * checks every internal link against it.
 *
 * A country hub is built only where the country has two or more published
 * cities. With one city it would be the city page with a different heading,
 * which is a doorway page with extra steps: the United Kingdom has London and
 * nothing else, so there is no `/ai-receptionist/in/gb`.
 */
export function seoPages(env: Record<string, string | undefined> = process.env): SeoPage[] {
  const combos = publishedCombos(env).map((x) => {
    const city = seoCity(x.city);
    return { vertical: seoVertical(x.vertical), city, path: comboPath(x.vertical, city) };
  });
  if (combos.length === 0) return [];

  const verticals = SEO_VERTICALS.filter((v) => combos.some((c) => c.vertical.slug === v.slug));
  const cities = SEO_CITIES.filter((c) => combos.some((x) => x.city.slug === c.slug));
  const markets = [...new Set(cities.map((c) => c.market))];

  const channelTrade = CHANNEL_TRADE_PAGES.filter((p) => verticals.some((v) => v.slug === p.vertical)).map(
    (copy): ChannelTradePage => ({
      kind: "channel-trade",
      path: verticalHubPath(copy.vertical, copy.framing),
      framing: seoFraming(copy.framing),
      vertical: seoVertical(copy.vertical),
      copy,
    }),
  );

  return [
    { kind: "index", path: indexPath(), combos },
    ...verticals.map(
      (v): HubPage => ({
        kind: "vertical-hub",
        path: verticalHubPath(v.slug),
        vertical: v,
        combos: combos.filter((c) => c.vertical.slug === v.slug),
      }),
    ),
    ...markets
      .filter((m) => cities.filter((c) => c.market === m).length > 1 && seoCountry(m) !== null)
      .map(
        (m): HubPage => ({
          kind: "country-hub",
          path: countryHubPath(m),
          market: m,
          combos: combos.filter((x) => x.city.market === m),
        }),
      ),
    ...cities.map(
      (c): HubPage => ({
        kind: "city-hub",
        path: cityHubPath(c),
        city: c,
        combos: combos.filter((x) => x.city.slug === c.slug),
      }),
    ),
    ...combos.map(
      (c): ComboPage => ({
        kind: "combo",
        path: c.path,
        vertical: c.vertical,
        city: c.city,
        pair: seoPair(c.vertical.slug, c.city.slug)!,
      }),
    ),
    ...CHANNEL_HUBS.map(
      (copy): ChannelHubPage => ({
        kind: "channel-hub",
        path: framingPath(copy.framing),
        framing: seoFraming(copy.framing),
        copy,
        trades: channelTrade.filter((p) => p.framing.slug === copy.framing).map((p) => ({ vertical: p.vertical, path: p.path })),
      }),
    ),
    ...channelTrade,
  ];
}

/**
 * Can somebody in this city buy Belline today?
 *
 * The single question every page asks before it renders a call to action, and
 * it is answered by `src/lib/markets.ts` rather than by anything written here
 * — the same table the checkout uses to refuse a market. The day GB flips to
 * `live`, the London pages grow a buy button and lose the waitlist without a
 * word of copy changing.
 */
export const marketLive = (city: SeoCity) => MARKETS[city.market].status === "live";

/**
 * Why not, in the market table's own words.
 *
 * Kept for the build's summary line and for anything internal that wants it.
 * It is **not** printed on a page: the table's `gap` is an engineering note
 * written for the gaps report, and the London waitlist was showing a dentist
 * "Phase 4 (numbers) and Phase 5 (markets) of the commercial build-out open
 * it". The decision still comes from this table; the sentence a reader sees is
 * written for a reader (scripts/seo/render.ts, `waitlist`).
 */
export const marketGap = (city: SeoCity): string => MARKETS[city.market].gap ?? "";

export const marketName = (city: SeoCity): string => MARKETS[city.market].name;

/** The markets in the published matrix, live or not — for the build's summary line. */
export function marketsInPlay(env?: Record<string, string | undefined>): Market[] {
  return [...new Set(seoPages(env).flatMap((p) => ("city" in p && p.city ? [p.city.market] : [])))];
}

/**
 * The hreflang block for one page, in the shape site-locale.ts writes it.
 *
 * With one locale this is `en` and `x-default` pointing at the same URL, which
 * is correct and is also the seam a second language slots into: the renderer
 * asks for a page's alternates by locale and never composes a URL itself.
 */
export function seoAlternates(pathFor: (locale: SeoLocale) => string): string {
  const links = SEO_LOCALES.map((l) => `<link rel="alternate" hreflang="${l.lang}" href="${ORIGIN}${pathFor(l)}">`);
  const def = SEO_LOCALES.find((l) => l.xDefault) ?? SEO_LOCALES[0];
  return [...links, `<link rel="alternate" hreflang="x-default" href="${ORIGIN}${pathFor(def)}">`].join("\n");
}

/** `<url>` lines for sitemap.xml, hubs first. */
export function seoSitemapEntries(env?: Record<string, string | undefined>): string[] {
  return seoPages(env).map((page) => {
    const priority = page.kind === "combo" || page.kind === "channel-trade" ? "0.7" : "0.6";
    return `  <url><loc>${ORIGIN}${page.path}</loc><changefreq>monthly</changefreq><priority>${priority}</priority></url>`;
  });
}

/** Every URL the full matrix would have, published or not — for the docs and the report. */
export function allMatrixUrls(): string[] {
  return MATRIX.map(({ vertical, city }) => `${ORIGIN}${comboPath(vertical, seoCity(city))}`);
}
