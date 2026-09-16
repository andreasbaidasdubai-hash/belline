/**
 * The countries Belline sells in, and the money it sells in there.
 *
 * Deliberately small for now: currency, how a price is written, and whether
 * the market is open. Phase 5 of the commercial build-out grows this into the
 * whole per-country definition (speech locale, emergency number, disclosure
 * rules, outreach compliance). It lives in its own file from the start so
 * that growth is additions, not a move.
 *
 * Pure data and pure functions — the checkout renders in the browser and
 * imports this.
 */

export type Market = "AE" | "GB" | "AU" | "CA" | "US" | "SG" | "IE" | "NZ" | "CH" | "DE" | "AT";

export interface MarketInfo {
  code: Market;
  name: string;
  currency: "AED" | "GBP" | "AUD" | "CAD" | "USD" | "SGD" | "EUR" | "NZD" | "CHF";
  /** Written before the number: "AED 249", "£35", "A$59". */
  prefix: string;
  /** The currency as Belle says it: "two hundred and forty-nine dirhams". */
  spoken: { one: string; many: string };
  /**
   * `live` — we can take a customer here today: a number, a checkout, support.
   * `not-yet` — priced and ready in the catalogue, never sold. Its prices reach
   * a public page only on that country's own waitlist page (DE, AT and CH, in
   * German), labelled there as planned, with no way to buy.
   */
  status: "live" | "not-yet";
  gap?: string;
  /**
   * The timezone a new account in this market starts in. Signup takes it from
   * here, never from the browser: a UAE business whose owner happens to be
   * in Zurich still opens at nine in Dubai. Owners in a second zone of a large
   * country (Perth, Vancouver) change it in their settings.
   */
  timezone: string;
  /**
   * US dollars per one unit of the currency, for internal arithmetic only:
   * margins, and the client book's totals. Never used to price anything a
   * customer sees — prices are set per market, not converted.
   */
  planningUsdRate: number;
}

/** When the planning exchange rates below were last looked at. */
export const PLANNING_RATES_DATE = "2026-09-14";

const NOT_OPEN =
  "No local numbers bought, no outreach running and no support hours in this timezone yet — " +
  "Phase 4 (numbers) and Phase 5 (markets) of the commercial build-out open it.";

export const MARKETS: Record<Market, MarketInfo> = {
  AE: {
    code: "AE",
    name: "United Arab Emirates",
    currency: "AED",
    timezone: "Asia/Dubai",
    prefix: "AED ",
    spoken: { one: "dirham", many: "dirhams" },
    status: "live",
    // Pegged at 3.6725 since 1997, so this one is exact.
    planningUsdRate: 1 / 3.6725,
  },
  GB: {
    code: "GB",
    name: "United Kingdom",
    currency: "GBP",
    timezone: "Europe/London",
    prefix: "£",
    spoken: { one: "pound", many: "pounds" },
    status: "not-yet",
    gap: NOT_OPEN,
    planningUsdRate: 1.3,
  },
  AU: {
    code: "AU",
    name: "Australia",
    currency: "AUD",
    timezone: "Australia/Sydney",
    prefix: "A$",
    spoken: { one: "Australian dollar", many: "Australian dollars" },
    status: "not-yet",
    gap: NOT_OPEN,
    planningUsdRate: 0.66,
  },
  CA: {
    code: "CA",
    name: "Canada",
    currency: "CAD",
    timezone: "America/Toronto",
    prefix: "C$",
    spoken: { one: "Canadian dollar", many: "Canadian dollars" },
    status: "not-yet",
    gap: NOT_OPEN,
    planningUsdRate: 0.73,
  },
  US: {
    code: "US",
    name: "United States",
    currency: "USD",
    timezone: "America/New_York",
    prefix: "$",
    spoken: { one: "dollar", many: "dollars" },
    status: "not-yet",
    gap: NOT_OPEN,
    planningUsdRate: 1,
  },
  SG: {
    code: "SG",
    name: "Singapore",
    currency: "SGD",
    timezone: "Asia/Singapore",
    prefix: "S$",
    spoken: { one: "Singapore dollar", many: "Singapore dollars" },
    status: "not-yet",
    gap: NOT_OPEN,
    planningUsdRate: 0.77,
  },
  IE: {
    code: "IE",
    name: "Ireland",
    currency: "EUR",
    timezone: "Europe/Dublin",
    prefix: "€",
    spoken: { one: "euro", many: "euros" },
    status: "not-yet",
    gap: NOT_OPEN,
    planningUsdRate: 1.12,
  },
  NZ: {
    code: "NZ",
    name: "New Zealand",
    currency: "NZD",
    timezone: "Pacific/Auckland",
    prefix: "NZ$",
    spoken: { one: "New Zealand dollar", many: "New Zealand dollars" },
    status: "not-yet",
    gap: NOT_OPEN,
    planningUsdRate: 0.6,
  },
  CH: {
    code: "CH",
    name: "Switzerland",
    currency: "CHF",
    timezone: "Europe/Zurich",
    prefix: "CHF ",
    spoken: { one: "franc", many: "francs" },
    status: "not-yet",
    gap:
      "A founder-network market, not an agent one (addendum §5): no outreach agent, and Swiss " +
      "German speech recognition is not built.",
    planningUsdRate: 1.2,
  },
  // Germany and Austria: German landing pages with a waitlist (2026-09-16),
  // nothing sold. Belline answers in English only, so the pages say so.
  DE: {
    code: "DE",
    name: "Germany",
    currency: "EUR",
    timezone: "Europe/Berlin",
    prefix: "€",
    spoken: { one: "euro", many: "euros" },
    status: "not-yet",
    gap: `${NOT_OPEN} German speech is not built either: Belline answers in English.`,
    planningUsdRate: 1.12,
  },
  AT: {
    code: "AT",
    name: "Austria",
    currency: "EUR",
    timezone: "Europe/Vienna",
    prefix: "€",
    spoken: { one: "euro", many: "euros" },
    status: "not-yet",
    gap: `${NOT_OPEN} German speech is not built either: Belline answers in English.`,
    planningUsdRate: 1.12,
  },
};

export const MARKET_CODES = Object.keys(MARKETS) as Market[];

export function isMarket(value: unknown): value is Market {
  return typeof value === "string" && value in MARKETS;
}

/** The market a subscription or a query string names, or the UAE. */
export function marketOf(value: unknown): Market {
  return isMarket(value) ? value : "AE";
}

/**
 * What a new account in a market starts with: its currency and its clock.
 * The one place signup reads them from, so a country site added later changes
 * this table and nothing else.
 */
export function marketDefaults(market: unknown): { market: Market; currency: MarketInfo["currency"]; timezone: string } {
  const code = marketOf(market);
  return { market: code, currency: MARKETS[code].currency, timezone: MARKETS[code].timezone };
}

export function liveMarkets(): Market[] {
  return MARKET_CODES.filter((m) => MARKETS[m].status === "live");
}

/**
 * Write an amount in minor units as a price.
 *
 * Whole numbers print without decimals, because "AED 249.00" reads like an
 * invoice line and a pricing page is not one. Anything fractional keeps both
 * digits.
 */
export function formatMoney(minor: number, market: Market, locale: PriceLocale = "en"): string {
  const info = MARKETS[market];
  const major = minor / 100;
  if (locale !== "en") return germanMoney(major, info, locale);
  const digits = Number.isInteger(major)
    ? major.toLocaleString("en-GB")
    : major.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${info.prefix}${digits}`;
}

/** The languages a public page writes a price in. */
export type PriceLocale = "en" | "de-DE" | "de-AT" | "de-CH";

/** A no-break space: "69 €" and "CHF 79" never wrap between number and currency. */
const NBSP = " ";

/**
 * A price as a German page writes it, by hand rather than through Intl so the
 * build, the checks and site.js all produce the same characters on every
 * machine: "1.419 €" in Germany and Austria, "CHF 1’639" in Switzerland, and
 * any other currency by its code before the number ("AED 99").
 */
function germanMoney(major: number, info: MarketInfo, locale: Exclude<PriceLocale, "en">): string {
  const swiss = locale === "de-CH";
  const [whole, cents] = Math.abs(major).toFixed(Number.isInteger(major) ? 0 : 2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, swiss ? "’" : ".");
  const digits = `${major < 0 ? "-" : ""}${grouped}${cents ? `${swiss ? "." : ","}${cents}` : ""}`;
  if (info.currency === "EUR") return `${digits}${NBSP}€`;
  return `${info.currency}${NBSP}${digits}`;
}

/** Minor units of a market's currency, in US dollars. Internal arithmetic only. */
export function toUsd(minor: number, market: Market): number {
  return (minor / 100) * MARKETS[market].planningUsdRate;
}
