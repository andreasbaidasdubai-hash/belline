/**
 * Which pages of the trade × city matrix exist, and what their URLs are.
 *
 * One place decides all of it, so adding a city or a trade is a data edit and
 * nothing here changes shape. The three-file split is deliberate:
 *
 *   verticals.ts   what is true about a trade
 *   cities.ts      what is true about a city
 *   pairs.ts       what is only true where the two meet
 *   matrix.ts      which combinations we publish, and where they live
 *
 * URLs
 *
 *   /ai-receptionist                          the index of the whole matrix
 *   /ai-receptionist/<vertical>               the trade hub
 *   /ai-receptionist/in/<city>                the city hub
 *   /ai-receptionist/<vertical>/<city>        the landing page itself
 *
 * `in/` keeps the two hub namespaces apart. Without it a city called
 * "spas" and a trade called "spas" would be the same URL, and the first
 * collision would be found by a 404 in production rather than by reading this.
 *
 * **Publishing is opt-in.** `PUBLISHED` lists the combinations this build
 * writes, and the first pass deliberately lists three — one restaurant, one
 * salon, one clinic — so the quality can be judged before thirty pages go out
 * under one domain. `SEO_PAGES=all` builds every combination that has pair
 * copy. Nothing else has to change to go from three to thirty.
 *
 * **Languages.** Every path here is the English one, and `seoAlternates`
 * renders the hreflang block through the same helper shape the German pages
 * use (scripts/site-locale.ts). Today there is one locale, so the block is
 * `en` plus `x-default`. Adding German is adding a locale to `SEO_LOCALES`
 * with its path prefix and writing the copy — not a refactor of the renderer,
 * which never builds a URL by hand.
 */

import { MARKETS, type Market } from "../../src/lib/markets";
import { SEO_CITIES, seoCity, type SeoCity } from "./cities";
import { SEO_VERTICALS, seoVertical, type SeoVertical } from "./verticals";
import { seoPair, type PairCopy } from "./pairs";

export const ORIGIN = "https://belline.ai";

/** The root every page in this system hangs off. */
export const SEO_ROOT = "/ai-receptionist";

/**
 * The locales these pages exist in.
 *
 * One today. A second is `{ lang: "de-DE", prefix: "/de-de/ki-empfang" }` plus
 * translated data — the renderer reads the prefix from here and never writes
 * a path itself, so the alternates, the canonicals and the sitemap all follow
 * from this array.
 */
export const SEO_LOCALES: readonly { lang: string; prefix: string; xDefault?: boolean }[] = [
  { lang: "en", prefix: SEO_ROOT, xDefault: true },
];

const localeOf = (lang: string) => SEO_LOCALES.find((l) => l.lang === lang) ?? SEO_LOCALES[0];

export const indexPath = (lang = "en") => localeOf(lang).prefix;
export const verticalHubPath = (v: string, lang = "en") => `${localeOf(lang).prefix}/${v}`;
export const cityHubPath = (c: string, lang = "en") => `${localeOf(lang).prefix}/in/${c}`;
export const comboPath = (v: string, c: string, lang = "en") => `${localeOf(lang).prefix}/${v}/${c}`;

/** Every combination the data allows, in a stable order. */
export const MATRIX: readonly { vertical: string; city: string }[] = SEO_VERTICALS.flatMap((v) =>
  SEO_CITIES.map((c) => ({ vertical: v.slug, city: c.slug })),
);

/**
 * The combinations this build publishes.
 *
 * Three for the first pass, chosen to cover the three shapes the system has
 * to get right rather than the three easiest pages: a live market, a second
 * live market whose week and habits genuinely differ from the first, and a
 * market we are not open in, where the page has to carry the same substance
 * with no way to buy.
 *
 * `SEO_PAGES=all` publishes every combination that has pair copy written.
 */
const FIRST_PASS = ["restaurants/dubai", "hair-salons/sharjah", "dental-clinics/london"];

export function publishedCombos(env: Record<string, string | undefined> = process.env): { vertical: string; city: string }[] {
  const all = (env.SEO_PAGES ?? "").toLowerCase() === "all";
  return MATRIX.filter(({ vertical, city }) => {
    const key = `${vertical}/${city}`;
    if (!all && !FIRST_PASS.includes(key)) return false;
    // No pair copy, no page. A combination without hand-written local
    // substance would be the template this whole system exists to avoid, so
    // "all" means every combination somebody has actually written.
    return seoPair(vertical, city) !== null;
  }).map((x) => ({ ...x }));
}

/**
 * A combination named in the first pass but missing its pair copy is a
 * mistake, not a quiet omission: somebody meant to publish it.
 */
export function missingPairCopy(): string[] {
  return FIRST_PASS.filter((key) => {
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
  kind: "vertical-hub" | "city-hub" | "index";
  path: string;
  vertical?: SeoVertical;
  city?: SeoCity;
  /** The published combinations this hub links to. */
  combos: { vertical: SeoVertical; city: SeoCity; path: string }[];
}
export type SeoPage = ComboPage | HubPage;

/**
 * Every page this build writes, hubs included.
 *
 * Hubs are derived rather than listed: a trade hub exists when at least one of
 * its cities is published, and it links only to the pages this same build
 * writes. That is the rule that keeps the first pass honest — three landing
 * pages and the hubs above them, with no link on any of them pointing at a
 * URL that will 404. scripts/check-seo.ts re-derives the set and checks every
 * internal link against it.
 */
export function seoPages(env: Record<string, string | undefined> = process.env): SeoPage[] {
  const combos = publishedCombos(env).map((x) => ({
    vertical: seoVertical(x.vertical),
    city: seoCity(x.city),
    path: comboPath(x.vertical, x.city),
  }));
  if (combos.length === 0) return [];

  const verticals = SEO_VERTICALS.filter((v) => combos.some((c) => c.vertical.slug === v.slug));
  const cities = SEO_CITIES.filter((c) => combos.some((x) => x.city.slug === c.slug));

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
    ...cities.map(
      (c): HubPage => ({
        kind: "city-hub",
        path: cityHubPath(c.slug),
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

/** Why not, in the market table's own words. Never invented here. */
export const marketGap = (city: SeoCity): string => MARKETS[city.market].gap ?? "";

export const marketName = (city: SeoCity): string => MARKETS[city.market].name;

/** The markets in the published matrix, live or not — for the build's summary line. */
export function marketsInPlay(env?: Record<string, string | undefined>): Market[] {
  return [...new Set(seoPages(env).flatMap((p) => ("city" in p && p.city ? [p.city.market] : p.kind === "combo" ? [p.city.market] : [])))];
}

/**
 * The hreflang block for one page, in the shape site-locale.ts writes it.
 *
 * With one locale this is `en` and `x-default` pointing at the same URL, which
 * is correct and is also the seam a second language slots into: the renderer
 * asks for a page's alternates and never composes a URL itself.
 */
export function seoAlternates(pathFor: (prefix: string) => string): string {
  const links = SEO_LOCALES.map((l) => `<link rel="alternate" hreflang="${l.lang}" href="${ORIGIN}${pathFor(l.prefix)}">`);
  const def = SEO_LOCALES.find((l) => l.xDefault) ?? SEO_LOCALES[0];
  return [...links, `<link rel="alternate" hreflang="x-default" href="${ORIGIN}${pathFor(def.prefix)}">`].join("\n");
}

/** `<url>` lines for sitemap.xml, hubs first. */
export function seoSitemapEntries(env?: Record<string, string | undefined>): string[] {
  return seoPages(env).map((page) => {
    const priority = page.kind === "combo" ? "0.7" : page.kind === "index" ? "0.6" : "0.6";
    return `  <url><loc>${ORIGIN}${page.path}</loc><changefreq>monthly</changefreq><priority>${priority}</priority></url>`;
  });
}

/** Every URL the full matrix would have, published or not — for the docs and the report. */
export function allMatrixUrls(): string[] {
  return MATRIX.map(({ vertical, city }) => `${ORIGIN}${comboPath(vertical, city)}`);
}
