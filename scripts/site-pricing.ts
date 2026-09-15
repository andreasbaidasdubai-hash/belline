/**
 * The website's pricing, generated from the catalogue.
 *
 * `plans.ts` is the only place a price or an allowance is written: this
 * renders the pricing section, the ROI calculator's plan list and the
 * structured-data offers, and writes them between markers in
 * public/landing.html.
 *
 * One block per market. Only markets whose `status` is `live` are published,
 * but every market renders, and check-billing pins every one of them to the
 * engine, so the day a market opens its page is already right.
 *
 *   npm run pricing          rewrite public/landing.html
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRIAL,
  allowanceFeatures,
  annualMonthsSaved,
  annualPerMonth,
  periodFee,
  priceOf,
  sellable,
  type Product,
} from "../src/lib/billing/plans";
import { MARKETS, formatMoney, liveMarkets, type Market } from "../src/lib/markets";
import { CONVERSATION_DEFINITION, MINUTE_DEFINITION } from "../src/lib/billing/usage";
import { overLimitSentence, trialSentence } from "../src/lib/billing/speak";

/** Re-exported for scripts/build-site.ts: the sentence itself lives with the catalogue's other sentences. */
export { trialSentence };

const APP = "https://app.belline.ai";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The lines one plan's card shows.
 *
 * Its allowances, then — for every plan above the first — "Everything in
 * Starter" and only what it adds. A card that repeats the tier below it line
 * for line is a card nobody reads to the end.
 */
function cardLines(product: Product, below: Product | undefined): string[] {
  const live = (list: { text: string; status: string }[]) => list.filter((f) => f.status === "live").map((f) => f.text);
  const allowances = live(allowanceFeatures(product));
  const features = live(product.features);
  if (!below) return [...allowances, ...features];
  const inherited = new Set(live(below.features));
  return [...allowances, `Everything in ${below.name}`, ...features.filter((f) => !inherited.has(f))];
}

function planCard(product: Product, below: Product | undefined, market: Market): string {
  const money = (minor: number) => formatMoney(minor, market);
  const monthly = priceOf(product.id, market);
  const best = Boolean(product.recommended);
  const lines = cardLines(product, below)
    .map((line) => `            <li>${esc(line)}</li>`)
    .join("\n");
  return `        <div class="plan${best ? " is-best" : ""}">
          <div class="plan-tag"${best ? "" : ' aria-hidden="true"'}>${best ? "Most popular" : ""}</div>
          <h3>${esc(product.name)}</h3>
          <p class="plan-sub">${esc(product.summary)}</p>
          <div class="plan-price">
            <span class="amt" data-monthly="${money(monthly)}" data-annual="${money(annualPerMonth([product.id], market))}">${money(monthly)}</span>
            <span class="per">per location, per month</span>
            <span class="billed" data-monthly="Billed monthly. Cancel anytime."
                  data-annual="${money(periodFee([product.id], market, "annual"))} billed once a year.">Billed monthly. Cancel anytime.</span>
          </div>
          <ul>
${lines}
          </ul>
          <a class="btn${best ? "" : " line"}" href="${APP}/checkout?products=${product.id}&amp;market=${market}" data-cta="plan-${product.id}">Start free with ${esc(product.name)}</a>
        </div>`;
}

/** Everything one market's visitor sees. */
export function renderMarket(market: Market, hidden = false): string {
  const plans = sellable(market);
  return `      <div class="market" data-market="${market}"${hidden ? " hidden" : ""}>
      <div class="plans">
${plans.map((p, i) => planCard(p, plans[i - 1], market)).join("\n\n")}
      </div>
      </div>`;
}

/** The whole generated pricing block. */
export function renderPricing(markets: Market[] = liveMarkets()): string {
  const picker =
    markets.length > 1
      ? `      <label class="market-pick">
        <span>Prices for</span>
        <select data-market-pick>
${markets.map((m, i) => `          <option value="${m}"${i === 0 ? " selected" : ""}>${esc(MARKETS[m].name)} (${MARKETS[m].currency})</option>`).join("\n")}
        </select>
      </label>
`
      : "";

  // What the stored annual prices actually save, never a number typed here:
  // the smallest saving across the plans, so no card is promised more.
  const home = markets[0] ?? "AE";
  const saved = Math.min(...sellable(home).map((p) => annualMonthsSaved([p.id], home)));
  const save = saved > 0 ? ` <span class="cycle-save">${saved} month${saved === 1 ? "" : "s"} free</span>` : "";

  return `<!-- pricing:start — generated from src/lib/billing/plans.ts by scripts/site-pricing.ts. Change the catalogue, then run npm run pricing; do not edit by hand. -->
${picker}      <div class="cycle" role="group" aria-label="Billing period">
        <button type="button" class="cycle-opt is-on" data-cycle="monthly" aria-pressed="true">Monthly</button>
        <button type="button" class="cycle-opt" data-cycle="annual" aria-pressed="false">
          Annual${save}
        </button>
      </div>

${markets.map((m, i) => renderMarket(m, i > 0)).join("\n\n")}

      <p class="compare">An answering service takes a message. Belline takes the booking — and answers at three in the morning.</p>

      <div class="terms terms-4">
        <div>
          <h4>What counts as a minute</h4>
          <p>${esc(MINUTE_DEFINITION)}</p>
        </div>
        <div>
          <h4>What counts as a conversation</h4>
          <p>${esc(CONVERSATION_DEFINITION)}</p>
        </div>
        <div>
          <h4>When an allowance runs out</h4>
          <p>${esc(overLimitSentence())}</p>
        </div>
        <div>
          <h4>${TRIAL.days} days free</h4>
          <p>${esc(trialSentence())}</p>
        </div>
      </div>
<!-- pricing:end -->`;
}

/** The ROI calculator's "Compare with" list, and the sentence it shows before any typing. */
function renderRoi(market: Market): { options: string; sentence: string } {
  const plans = sellable(market);
  const chosen = plans.find((b) => b.recommended) ?? plans[0];
  const options = plans
    .map((b) => {
      const major = priceOf(b.id, market) / 100;
      return `              <option value="${major}" data-name="${esc(b.name)}"${b === chosen ? " selected" : ""}>${esc(b.name)} — ${formatMoney(priceOf(b.id, market), market)} a month</option>`;
    })
    .join("\n");
  // The markup's own example numbers: 10 missed a week, 30%, 250 a booking.
  const bookings = (10 * 0.3 * 52) / 12;
  const worth = Math.round(bookings * 250).toLocaleString("en-AE");
  const sentence = `About ${Math.round(bookings)} bookings a month, worth roughly AED ${worth}. ${chosen.name} is ${formatMoney(priceOf(chosen.id, market), market)} a month.`;
  return { options, sentence };
}

function renderOffers(market: Market): string {
  const currency = MARKETS[market].currency;
  return sellable(market)
    .map(
      (p) =>
        `        { "@type": "Offer", "name": ${JSON.stringify(`Belline ${p.name}`)}, "price": "${priceOf(p.id, market) / 100}", "priceCurrency": "${currency}", "billingIncrement": "P1M" }`,
    )
    .join(",\n");
}

/**
 * Short generated phrases that sit outside the pricing block: the trial line
 * under the hero and in the closer, for example. Each appears in the page as
 * `<span class="gen" data-gen="KEY">…</span>` (or a `<p>`), and its text is
 * rewritten from the catalogue on every build, so nobody types it.
 */
export function generatedPhrases(): Record<string, string> {
  return {
    "trial-short": `${TRIAL.days} days free, no card.`,
  };
}

function applyGenerated(html: string): string {
  for (const [key, text] of Object.entries(generatedPhrases())) {
    const slot = new RegExp(`(<(span|p) class="gen" data-gen="${key}">)[^<]*(</\\2>)`, "g");
    if (!slot.test(html)) throw new Error(`landing.html has lost its generated "${key}" text.`);
    html = html.replace(slot, (_m, open: string, _tag: string, close: string) => `${open}${esc(text)}${close}`);
  }
  return html;
}

/** Put the generated pricing into a copy of landing.html. Throws if a marker has gone missing. */
export function applyPricing(html: string): string {
  const home = liveMarkets()[0] ?? "AE";

  html = applyGenerated(html);

  const block = /<!-- pricing:start[\s\S]*?<!-- pricing:end -->/;
  if (!block.test(html)) throw new Error("landing.html has lost its <!-- pricing:start --> / <!-- pricing:end --> markers.");
  html = html.replace(block, () => renderPricing());

  const roi = renderRoi(home);
  // \r?\n throughout: a Windows checkout (core.autocrlf) gives landing.html CRLF
  // endings, and a bare \n made the site build throw in Docker and on Vercel.
  const select = /(<select name="plan">\r?\n)[\s\S]*?(\r?\n\s*<\/select>)/;
  if (!select.test(html)) throw new Error("landing.html has lost the ROI calculator's plan list.");
  html = html.replace(select, (_m, open: string, close: string) => `${open}${roi.options}${close}`);

  const out = /(<p class="roi-out" id="roi-out" aria-live="polite">)[^<]*(<\/p>)/;
  if (!out.test(html)) throw new Error("landing.html has lost the ROI calculator's answer line.");
  html = html.replace(out, (_m, open: string, close: string) => `${open}${roi.sentence}${close}`);

  const offers = /("offers": \[\r?\n)[\s\S]*?(\r?\n\s*\])/;
  if (!offers.test(html)) throw new Error("landing.html has lost its structured-data offers.");
  html = html.replace(offers, (_m, open: string, close: string) => `${open}${renderOffers(home)}${close}`);

  return html;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "landing.html");
  const before = fs.readFileSync(file, "utf8");
  const after = applyPricing(before);
  if (after === before) {
    console.log("  public/landing.html pricing is already current.");
  } else {
    fs.writeFileSync(file, after, "utf8");
    console.log("  public/landing.html pricing rewritten from src/lib/billing/plans.ts.");
  }
}
