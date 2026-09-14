/**
 * The website's pricing, generated from the catalogue.
 *
 * The pricing section of public/landing.html used to be typed by hand, and
 * check-billing compared it with plans.ts after the fact. Now plans.ts is the
 * only place a price or an allowance is written: this renders the section,
 * the ROI calculator's plan list and the structured-data offers, and writes
 * them between markers in public/landing.html.
 *
 * One block per market. Only markets whose `status` is `live` are published —
 * a price derived for a country we cannot yet serve is not a price anybody
 * should read — but every market renders, and check-billing pins every one of
 * them to the engine, so the day a market opens its page is already right.
 *
 *   npm run pricing          rewrite public/landing.html
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNELS,
  CHANNEL_ORDER,
  TRIAL,
  allowanceText,
  annualPerMonth,
  periodFee,
  priceOf,
  publicLines,
  sellable,
  type Product,
} from "../src/lib/billing/plans";
import { MARKETS, formatMoney, liveMarkets, type Market } from "../src/lib/markets";
import { CONVERSATION_DEFINITION, MINUTE_DEFINITION } from "../src/lib/billing/usage";
import { liveChannelsPhrase } from "../src/lib/billing/speak";

const APP = "https://app.belline.ai";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The trial, in one sentence, for every page that mentions it. */
export function trialSentence(): string {
  return (
    `${TRIAL.phoneMinutes} minutes of live calls, with ${liveChannelsPhrase()} all switched on. ` +
    "No card, nothing charged. Standard onboarding is free."
  );
}

function bundleCard(product: Product, market: Market): string {
  const money = (minor: number) => formatMoney(minor, market);
  const monthly = priceOf(product.id, market);
  const best = Boolean(product.recommended);
  const lines = publicLines(product)
    .map((line) => `            <li>${esc(line)}</li>`)
    .join("\n");
  return `        <div class="plan${best ? " is-best" : ""}">
          <div class="plan-tag"${best ? "" : ' aria-hidden="true"'}>${best ? "Most popular" : ""}</div>
          <h3>${esc(product.name)}</h3>
          <p class="plan-sub">${esc(product.summary)}</p>
          <div class="plan-price">
            <span class="amt" data-monthly="${money(monthly)}" data-annual="${money(annualPerMonth([product.id], market))}">${money(monthly)}</span>
            <span class="per">per month</span>
            <span class="billed" data-monthly="Billed monthly. Cancel anytime."
                  data-annual="${money(periodFee([product.id], market, "annual"))} billed once a year.">Billed monthly. Cancel anytime.</span>
          </div>
          <ul>
${lines}
          </ul>
          <a class="btn${best ? "" : " line"}" href="${APP}/checkout?bundle=${product.id}&amp;market=${market}" data-cta="plan-${product.id}">Get ${esc(product.name)}</a>
        </div>`;
}

function moduleRow(product: Product, market: Market): string {
  const money = (minor: number) => formatMoney(minor, market);
  const channel = CHANNEL_ORDER.find((c) => c in product.allowances)!;
  const monthly = priceOf(product.id, market);
  const allowance = allowanceText(channel, product.allowances[channel] as number);
  // Allowance first, then what else the module does. The allowance is already
  // in the row's own words, so it is not repeated in the list.
  const extras = publicLines(product).filter((line) => line !== allowance);
  const price = product.free
    ? `<span class="module-price">Free</span>`
    : `<span class="module-price" data-monthly="${money(monthly)} a month" data-annual="${money(annualPerMonth([product.id], market))} a month">${money(monthly)} a month</span>`;
  return `            <li class="module">
              <div class="module-row">
                <span class="module-name">${esc(product.name)}</span>
                ${price}
              </div>
              <p class="module-what">${esc(allowance)}</p>
              <details>
                <summary>What's included</summary>
                <ul>
${extras.map((line) => `                  <li>${esc(line)}</li>`).join("\n")}
                </ul>
              </details>
              <a class="module-cta" href="${APP}/checkout?products=${product.id}&amp;market=${market}" data-cta="module-${product.id}">${product.free ? "Start free" : `Choose ${esc(product.name)}`}</a>
            </li>`;
}

/** Everything one market's visitor sees. */
export function renderMarket(market: Market, hidden = false): string {
  const products = sellable(market);
  const bundles = products.filter((p) => p.kind === "bundle");
  const groups = CHANNEL_ORDER.filter((c) => CHANNELS[c].status === "live")
    .map((channel) => ({
      channel,
      modules: products.filter((p) => p.kind === "module" && channel in p.allowances),
    }))
    .filter((g) => g.modules.length > 0);

  return `      <div class="market" data-market="${market}"${hidden ? " hidden" : ""}>
      <div class="plans">
${bundles.map((b) => bundleCard(b, market)).join("\n\n")}
      </div>

      <div class="modules">
        <h3 class="modules-head">Or only the channel you need</h3>
        <div class="module-groups">
${groups
  .map(
    (g) => `          <ul class="module-group" aria-label="${esc(CHANNELS[g.channel].name)}">
${g.modules.map((m) => moduleRow(m, market)).join("\n")}
          </ul>`,
  )
  .join("\n")}
        </div>
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

  return `<!-- pricing:start — generated from src/lib/billing/plans.ts by scripts/site-pricing.ts. Change the catalogue, then run npm run pricing; do not edit by hand. -->
${picker}      <div class="cycle" role="group" aria-label="Billing period">
        <button type="button" class="cycle-opt is-on" data-cycle="monthly" aria-pressed="true">Monthly</button>
        <button type="button" class="cycle-opt" data-cycle="annual" aria-pressed="false">
          Annual <span class="cycle-save">2 months free</span>
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
          <h4>No surprise invoices</h4>
          <p>There is no per-minute or per-conversation charge on any plan. The invoice is the plan fee and nothing else — if an allowance runs short, Belline keeps answering and the answer is a bigger plan, not a bigger bill. Only the free chat pauses at its limit.</p>
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
  const bundles = sellable(market).filter((p) => p.kind === "bundle");
  const chosen = bundles.find((b) => b.recommended) ?? bundles[0];
  const options = bundles
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
        `        { "@type": "Offer", "name": ${JSON.stringify(p.name)}, "price": "${priceOf(p.id, market) / 100}", "priceCurrency": "${currency}", "billingIncrement": "P1M" }`,
    )
    .join(",\n");
}

/** Put the generated pricing into a copy of landing.html. Throws if a marker has gone missing. */
export function applyPricing(html: string): string {
  const home = liveMarkets()[0] ?? "AE";

  const block = /<!-- pricing:start[\s\S]*?<!-- pricing:end -->/;
  if (!block.test(html)) throw new Error("landing.html has lost its <!-- pricing:start --> / <!-- pricing:end --> markers.");
  html = html.replace(block, () => renderPricing());

  const roi = renderRoi(home);
  const select = /(<select name="plan">\n)[\s\S]*?(\n\s*<\/select>)/;
  if (!select.test(html)) throw new Error("landing.html has lost the ROI calculator's plan list.");
  html = html.replace(select, (_m, open: string, close: string) => `${open}${roi.options}${close}`);

  const out = /(<p class="roi-out" id="roi-out" aria-live="polite">)[^<]*(<\/p>)/;
  if (!out.test(html)) throw new Error("landing.html has lost the ROI calculator's answer line.");
  html = html.replace(out, (_m, open: string, close: string) => `${open}${roi.sentence}${close}`);

  const offers = /("offers": \[\n)[\s\S]*?(\n\s*\])/;
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
