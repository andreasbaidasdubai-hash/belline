/**
 * The German pages' pricing, generated from the catalogue.
 *
 * The same blocks as scripts/site-pricing.ts renders for the English page —
 * the plan cards, the billing-period switch, the four terms, the calculator's
 * plan list, the structured-data offers and the generated FAQ answers — in
 * German, for one DACH market at a time. Three differences, all deliberate:
 *
 *   The market is not open. Every price here is a planning figure from
 *   `plans.ts` (`provisional`), so the block says "Geplante Preise", says
 *   nothing can be bought yet, and every plan button goes to the waitlist
 *   form on the same page. No link here reaches the checkout.
 *
 *   "Empfohlen", not "Most popular". There is no customer in these countries
 *   whose choice could make a plan popular.
 *
 *   Prices are written the German way ("1.419 €", "CHF 1’639"), by
 *   `formatMoney(…, locale)`, which site.js mirrors for the calculator.
 *
 * public/landing.de.html carries the block as the Germany render; the build
 * renders it again for Austria and Switzerland.
 */

import { TRIAL, annualMonthsSaved, annualPerMonth, offered, periodFee, priceOf, type Product } from "../src/lib/billing/plans";
import { formatMoney, type Market } from "../src/lib/markets";
import {
  CONVERSATION_DEFINITION_DE,
  MINUTE_DEFINITION_DE,
  allowanceLinesDe,
  catalogueDe,
  overLimitSentenceDe,
  trialSentenceDe,
  type GermanLocale,
} from "../src/lib/billing/speak-de";

export type DachMarket = "DE" | "AT" | "CH";

/** Each German page: its market, locale, path and names. */
export const GERMAN_PAGES: Record<DachMarket, { market: DachMarket; locale: GermanLocale; slug: string; forCountry: string; inCountry: string }> = {
  DE: { market: "DE", locale: "de-DE", slug: "de-de", forCountry: "für Deutschland", inCountry: "in Deutschland" },
  AT: { market: "AT", locale: "de-AT", slug: "de-at", forCountry: "für Österreich", inCountry: "in Österreich" },
  CH: { market: "CH", locale: "de-CH", slug: "de-ch", forCountry: "für die Schweiz", inCountry: "in der Schweiz" },
};

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Allowances, then "Alles aus Starter" and only what a plan adds — as the English cards do. */
function cardLinesDe(product: Product, below: Product | undefined, locale: GermanLocale): string[] {
  const live = (list: { text: string; status: string }[]) => list.filter((f) => f.status === "live").map((f) => f.text);
  const allowances = live(allowanceLinesDe(product, locale));
  const features = live(product.features);
  if (!below) return [...allowances, ...features.map(catalogueDe)];
  const inherited = new Set(live(below.features));
  return [...allowances, `Alles aus ${below.name}`, ...features.filter((f) => !inherited.has(f)).map(catalogueDe)];
}

function planCardDe(product: Product, below: Product | undefined, market: DachMarket): string {
  const { locale } = GERMAN_PAGES[market];
  const money = (minor: number) => formatMoney(minor, market, locale);
  const monthly = priceOf(product.id, market);
  const best = Boolean(product.recommended);
  const lines = cardLinesDe(product, below, locale)
    .map((line) => `            <li>${esc(line)}</li>`)
    .join("\n");
  return `        <div class="plan${best ? " is-best" : ""}">
          <div class="plan-tag"${best ? "" : ' aria-hidden="true"'}>${best ? "Empfohlen" : ""}</div>
          <h3>${esc(product.name)}</h3>
          <p class="plan-sub">${esc(catalogueDe(product.summary))}</p>
          <div class="plan-price">
            <span class="amt" data-monthly="${money(monthly)}" data-annual="${money(annualPerMonth([product.id], market))}">${money(monthly)}</span>
            <span class="per">pro Standort, pro Monat</span>
            <span class="billed" data-monthly="Monatliche Abrechnung, jederzeit kündbar."
                  data-annual="${money(periodFee([product.id], market, "annual"))} einmal jährlich abgerechnet.">Monatliche Abrechnung, jederzeit kündbar.</span>
          </div>
          <ul>
${lines}
          </ul>
          <a class="btn${best ? "" : " line"}" href="#warteliste" data-cta="plan-${product.id}">Auf die Warteliste</a>
        </div>`;
}

/** The smallest whole number of months the annual prices save, so no card is promised more. */
function monthsSaved(market: DachMarket): number {
  return Math.min(...offered(market).map((p) => annualMonthsSaved([p.id], market)));
}

/** The whole generated pricing block for one German page. */
export function renderPricingDe(market: DachMarket): string {
  const page = GERMAN_PAGES[market];
  const plans = offered(market);
  if (plans.length === 0) throw new Error(`No plan is priced for ${market} in src/lib/billing/plans.ts.`);
  const saved = monthsSaved(market);
  const save = saved > 0 ? ` <span class="cycle-save">${saved} ${saved === 1 ? "Monat" : "Monate"} gratis</span>` : "";

  return `<!-- pricing:start — generated from src/lib/billing/plans.ts by scripts/site-pricing-de.ts. Change the catalogue, then run npm run pricing; do not edit by hand. -->
      <p class="market-note" data-market-note="${market}"><strong>Geplante Preise ${esc(page.forCountry)}</strong>, netto. Belline ist ${esc(page.inCountry)} noch nicht verfügbar, Sie können noch nichts kaufen. Bis zum Start können sich Preise und Konditionen ändern.</p>
      <div class="cycle" role="group" aria-label="Abrechnungszeitraum">
        <button type="button" class="cycle-opt is-on" data-cycle="monthly" aria-pressed="true">Monatlich</button>
        <button type="button" class="cycle-opt" data-cycle="annual" aria-pressed="false">
          Jährlich${save}
        </button>
      </div>

      <div class="market" data-market="${market}">
      <div class="plans">
${plans.map((p, i) => planCardDe(p, plans[i - 1], market)).join("\n\n")}
      </div>
      </div>

      <p class="compare">Ein Telefonservice nimmt eine Nachricht auf. Belline beantwortet die Frage, nimmt die Details auf und sagt Ihrem Team, was als Nächstes zu tun ist.</p>

      <div class="terms terms-4">
        <div>
          <h4>Was als Minute zählt</h4>
          <p>${esc(MINUTE_DEFINITION_DE)}</p>
        </div>
        <div>
          <h4>Was als Gespräch zählt</h4>
          <p>${esc(CONVERSATION_DEFINITION_DE)}</p>
        </div>
        <div>
          <h4>Wenn ein Kontingent aufgebraucht ist</h4>
          <p>${esc(overLimitSentenceDe(market, page.locale))}</p>
        </div>
        <div>
          <h4>${TRIAL.days} Tage kostenlos</h4>
          <p>${esc(trialSentenceDe())}</p>
        </div>
      </div>
<!-- pricing:end -->`;
}

/** The calculator's plan list and its answer for the example numbers (10 a week, 30 %, 250 a booking). */
export function renderRoiDe(market: DachMarket): { options: string; sentence: string; detail: string } {
  const { locale } = GERMAN_PAGES[market];
  const plans = offered(market);
  const chosen = plans.find((p) => p.recommended) ?? plans[0];
  const options = plans
    .map((p) => {
      const major = priceOf(p.id, market) / 100;
      return `              <option value="${major}" data-name="${esc(p.name)}"${p === chosen ? " selected" : ""}>${esc(p.name)} – ${formatMoney(priceOf(p.id, market), market, locale)} pro Monat</option>`;
    })
    .join("\n");
  const bookings = (10 * 0.3 * 52) / 12;
  const worthMinor = Math.round(bookings * 250) * 100;
  const sentence = `Etwa ${formatMoney(worthMinor, market, locale)} pro Monat`;
  const n = Math.round(bookings);
  const side = worthMinor >= priceOf(chosen.id, market) ? "mehr" : "weniger";
  const detail = `Das sind etwa ${n} ${n === 1 ? "Buchung" : "Buchungen"} pro Monat, ${side} als ${chosen.name} kostet.`;
  return { options, sentence, detail };
}

/** An example caller's number in the hero, in the country's own format. */
const EXAMPLE_CALLER: Record<DachMarket, string> = {
  DE: "+49 151 ••• 4417",
  AT: "+43 664 ••• 4417",
  CH: "+41 79 ••• 4417",
};

/** The generated phrases outside the pricing block, by `data-gen` key. */
export function generatedPhrasesDe(market: DachMarket): Record<string, string> {
  const { locale } = GERMAN_PAGES[market];
  const saved = monthsSaved(market);
  return {
    "trial-short": `Geplant: ${TRIAL.days} Tage kostenlos, ohne Karte.`,
    "roi-detail": renderRoiDe(market).detail,
    "roi-currency": market === "CH" ? "CHF" : "€",
    "example-price": formatMoney(190 * 100, market, locale),
    "example-caller": EXAMPLE_CALLER[market],
    "faq-allowance": overLimitSentenceDe(market, locale),
    "faq-tied-in":
      "Nein. Monatliche Tarife sind jederzeit kündbar und laufen bis zum Ende des bezahlten Zeitraums. " +
      (saved > 0
        ? `Jährliche Tarife werden im Voraus bezahlt und enthalten ${saved} ${saved === 1 ? "Monat" : "Monate"} gratis.`
        : "Jährliche Tarife werden im Voraus bezahlt."),
  };
}

/** FAQ answers that appear twice, visible (by data-gen) and in the FAQPage data (by question). */
export const GENERATED_FAQ_DE: Record<string, string> = {
  "Was passiert, wenn unser Kontingent aufgebraucht ist?": "faq-allowance",
  "Sind wir vertraglich gebunden?": "faq-tied-in",
};

function applyGeneratedDe(html: string, market: DachMarket): string {
  const phrases = generatedPhrasesDe(market);
  for (const [key, text] of Object.entries(phrases)) {
    const slot = new RegExp(`(<(span|p) class="gen" data-gen="${key}">)[^<]*(</\\2>)`, "g");
    if (!slot.test(html)) throw new Error(`landing.de.html has lost its generated "${key}" text.`);
    html = html.replace(slot, (_m, open: string, _tag: string, close: string) => `${open}${esc(text)}${close}`);
  }
  for (const [question, key] of Object.entries(GENERATED_FAQ_DE)) {
    const name = JSON.stringify(question).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const answer = new RegExp(`("name": ${name}, "acceptedAnswer": \\{ "@type": "Answer", "text": )"(?:[^"\\\\]|\\\\.)*"`);
    if (!answer.test(html)) throw new Error(`landing.de.html's structured data has lost the answer to "${question}".`);
    html = html.replace(answer, (_m, open: string) => `${open}${JSON.stringify(phrases[key])}`);
  }
  return html;
}

function renderOffersDe(market: DachMarket): string {
  const currency = market === "CH" ? "CHF" : "EUR";
  return offered(market)
    .map(
      (p) =>
        `        { "@type": "Offer", "name": ${JSON.stringify(`Belline ${p.name}`)}, "price": "${priceOf(p.id, market) / 100}", "priceCurrency": "${currency}", "billingIncrement": "P1M", "availability": "https://schema.org/PreOrder" }`,
    )
    .join(",\n");
}

/** Put one country's generated pricing into a copy of landing.de.html. Throws if a marker has gone missing. */
export function applyPricingDe(html: string, market: DachMarket): string {
  html = applyGeneratedDe(html, market);

  const block = /<!-- pricing:start[\s\S]*?<!-- pricing:end -->/;
  if (!block.test(html)) throw new Error("landing.de.html has lost its <!-- pricing:start --> / <!-- pricing:end --> markers.");
  html = html.replace(block, () => renderPricingDe(market));

  const roi = renderRoiDe(market);
  const select = /(<select name="plan">\r?\n)[\s\S]*?(\r?\n\s*<\/select>)/;
  if (!select.test(html)) throw new Error("landing.de.html has lost the ROI calculator's plan list.");
  html = html.replace(select, (_m, open: string, close: string) => `${open}${roi.options}${close}`);

  const out = /(<p class="roi-out" id="roi-out" aria-live="polite">)[^<]*(<\/p>)/;
  if (!out.test(html)) throw new Error("landing.de.html has lost the ROI calculator's answer line.");
  html = html.replace(out, (_m, open: string, close: string) => `${open}${esc(roi.sentence)}${close}`);

  const offers = /("offers": \[\r?\n)[\s\S]*?(\r?\n\s*\])/;
  if (!offers.test(html)) throw new Error("landing.de.html has lost its structured-data offers.");
  html = html.replace(offers, (_m, open: string, close: string) => `${open}${renderOffersDe(market)}${close}`);

  return html;
}

export type { Market };
