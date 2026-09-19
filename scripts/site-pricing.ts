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
  VIDEO_RECEPTIONIST_TEXT,
  VIDEO_VOICE_MINUTE_RATIO,
  videoLive,
  videoMinutesFor,
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

/** Voice minutes one video minute uses: the catalogue's own setting (plans.ts). */
export { VIDEO_VOICE_MINUTE_RATIO };

/** Whole video minutes a voice allowance covers: the voice pool divided by the ratio, rounded down. */
export function videoMinutesOf(voiceMinutes: number): number {
  return videoMinutesFor(voiceMinutes);
}

/** "2.5" in English, "2,5" in German. */
export const ratioText = (lang: "en" | "de" = "en") => (lang === "de" ? String(VIDEO_VOICE_MINUTE_RATIO).replace(".", ",") : String(VIDEO_VOICE_MINUTE_RATIO));

export function videoLine(voiceMinutes: number): string {
  return `Video receptionist · ${videoMinutesOf(voiceMinutes)} video minutes (each uses ${ratioText()} voice minutes)`;
}

/** The trial, with video minutes only while the video receptionist is live (plans.ts `videoLive`). */
export function trialLine(): string {
  const minutes = videoLive() ? `${TRIAL.minutes} voice or ${videoMinutesOf(TRIAL.minutes)} video minutes` : `${TRIAL.minutes} voice minutes`;
  return `${TRIAL.days} days, ${minutes} and ${TRIAL.conversations} text conversations`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A card's video row, written on the voice row's line, or nothing while video
 * is not live, like every other line whose feature's `status` is not live.
 * One line, so src/lib/site-flags.ts can add it or take it away as the app's
 * server serves a page built with the flag the other way.
 */
export function videoRow(line: string): string {
  return videoLive() ? `<li class="allow-video">${esc(line)}</li>` : "";
}

/**
 * The catalogue's own video lines (the feature, and the minutes a pool buys as
 * video). The card says them in its video row, so they stay out of the rows
 * under it and out of "Included in every plan".
 */
export const isVideoText = (text: string) => text === VIDEO_RECEPTIONIST_TEXT || /^[\d.,’]+ (?:video minutes|Videominuten) \(/.test(text);

const liveTexts = (list: { text: string; status: string }[]) => list.filter((f) => f.status === "live" && !isVideoText(f.text)).map((f) => f.text);

/**
 * The features every plan on the page has, in the first plan's order. They
 * are said once, under the cards ("Included in every plan"), so each card
 * only has to say what makes it different.
 */
export function sharedFeatures(plans: Product[]): string[] {
  if (plans.length === 0) return [];
  return liveTexts(plans[0].features).filter((text) => plans.every((p) => liveTexts(p.features).includes(text)));
}

/**
 * One card, in the order a buyer compares them: who it suits, the price, the
 * voice allowance, the text allowance, then what sets it apart. The same
 * number of rows on every card, so the prices line up (site.css, subgrid).
 */
export interface CardParts {
  voice: string;
  text: string;
  /** Users, "Everything in Growth" where the plan below adds something, and the plan's own features. */
  differs: string[];
}

/**
 * The parts of one card from its allowance lines (pools first, then users, as
 * `allowanceFeatures` and `allowanceLinesDe` list them) and its feature texts.
 */
export function cardParts(
  allowances: string[],
  poolCount: number,
  features: string[],
  below: { name: string; features: string[] } | undefined,
  shared: string[],
  everything: (name: string) => string,
  translate: (text: string) => string = (t) => t,
): CardParts {
  const [voice = "", text = ""] = allowances.slice(0, poolCount);
  const users = allowances.slice(poolCount);
  const own = features.filter((f) => !shared.includes(f) && !(below?.features ?? []).includes(f)).map(translate);
  const inheritsMore = Boolean(below && below.features.some((f) => !shared.includes(f)));
  return { voice, text, differs: [...users, ...(inheritsMore ? [everything(below!.name)] : []), ...own] };
}

const poolCountOf = (product: Product) => Object.values(product.pools ?? {}).filter((n) => typeof n === "number").length;

function planCard(product: Product, below: Product | undefined, market: Market, shared: string[]): string {
  const money = (minor: number) => formatMoney(minor, market);
  const monthly = priceOf(product.id, market);
  const best = Boolean(product.recommended);
  const parts = cardParts(
    liveTexts(allowanceFeatures(product)),
    poolCountOf(product),
    liveTexts(product.features),
    below && { name: below.name, features: liveTexts(below.features) },
    shared,
    (name) => `Everything in ${name}`,
  );
  const differs = parts.differs.map((line) => `            <li>${esc(line)}</li>`).join("\n");
  return `        <div class="plan${best ? " is-best" : ""}">
          <div class="plan-tag"${best ? "" : ' aria-hidden="true"'}>${best ? "Recommended" : ""}</div>
          <h3>${esc(product.name)}</h3>
          <p class="plan-sub">${esc(product.summary)}</p>
          <div class="plan-price">
            <span class="amt" data-monthly="${money(monthly)}" data-annual="${money(annualPerMonth([product.id], market))}">${money(monthly)}</span>
            <span class="per">per location, per month</span>
            <span class="billed" data-monthly="Billed monthly. Cancel anytime."
                  data-annual="${money(periodFee([product.id], market, "annual"))} billed once a year.">Billed monthly. Cancel anytime.</span>
          </div>
          <ul class="plan-allow">
            <li class="allow-voice">${esc(parts.voice)}</li>${videoRow(videoLine(product.pools?.minutes ?? 0))}
            <li class="allow-text">${esc(parts.text)}</li>
          </ul>
          <ul class="plan-diff">
${differs}
          </ul>
          <a class="btn${best ? "" : " line"}" href="${APP}/checkout?products=${product.id}&amp;market=${market}" data-cta="plan-${product.id}" aria-label="Get started with ${esc(product.name)}">Get started</a>
        </div>`;
}

/** Everything one market's visitor sees: the three cards, then what every plan includes. */
export function renderMarket(market: Market, hidden = false): string {
  const plans = sellable(market);
  const shared = sharedFeatures(plans);
  return `      <div class="market" data-market="${market}"${hidden ? " hidden" : ""}>
      <div class="plans">
${plans.map((p, i) => planCard(p, plans[i - 1], market, shared)).join("\n\n")}
      </div>
      <div class="plan-shared">
        <h3 class="plan-shared-h">Included in every plan</h3>
        <ul>
${shared.map((line) => `            <li>${esc(line)}</li>`).join("\n")}
        </ul>
      </div>
      </div>`;
}

/** The lowest monthly price on the page, for the hero's reassurance line. */
export function lowestMonthly(market: Market): string {
  return formatMoney(Math.min(...sellable(market).map((p) => priceOf(p.id, market))), market);
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
${picker}      <div class="price-bar">
        <p class="price-trial"><strong>Trial:</strong> ${trialLine()}. No card required.</p>
        <div class="cycle" role="group" aria-label="Billing period">
          <button type="button" class="cycle-opt is-on" data-cycle="monthly" aria-pressed="true">Monthly</button>
          <button type="button" class="cycle-opt" data-cycle="annual" aria-pressed="false">
            Annual${save}
          </button>
        </div>
      </div>

${markets.map((m, i) => renderMarket(m, i > 0)).join("\n\n")}

      <p class="price-tax">Prices exclude VAT where it applies.</p>

      <p class="compare">An answering service takes a message. Belline answers the question, takes the details and tells your team what to do next.</p>

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

/**
 * The ROI calculator's "Compared with" list, and what it shows before any
 * typing: the monthly worth in large type (`sentence`), and the bookings and
 * plan comparison under it (`detail`). public/site.js writes the same two
 * lines in the same words when the visitor changes a number.
 */
export function renderRoi(market: Market): { options: string; sentence: string; detail: string } {
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
  const worthMinor = Math.round(bookings * 250) * 100;
  const sentence = `About ${formatMoney(worthMinor, market)} a month`;
  const n = Math.round(bookings);
  const side = worthMinor >= priceOf(chosen.id, market) ? "more" : "less";
  const detail = `That’s about ${n} booking${n === 1 ? "" : "s"} a month, ${side} than ${chosen.name} costs.`;
  return { options, sentence, detail };
}

/**
 * The plans as structured data.
 *
 * `billingIncrement` used to sit directly on the Offer, where schema.org has
 * no such property: a validator reads it as noise and a reader learns nothing
 * about the period, so "249 AED" could as easily have been a one-off payment.
 * It belongs on a `UnitPriceSpecification`, which is where "one month at a
 * time" is actually sayable. Each Offer now also names what it is an offer
 * *of*, so the three read as three services rather than three numbers, and
 * carries `availability` — the one field that has to differ between a market
 * we sell in and a waitlist page (see renderOffersDe).
 */
export function renderOffers(market: Market, availability = "https://schema.org/InStock"): string {
  const currency = MARKETS[market].currency;
  return sellable(market)
    .map((p) => {
      const price = String(priceOf(p.id, market) / 100);
      const offer = {
        "@type": "Offer",
        name: `Belline ${p.name}`,
        description: p.summary,
        price,
        priceCurrency: currency,
        availability,
        url: "https://belline.ai/#price",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price,
          priceCurrency: currency,
          billingDuration: 1,
          billingIncrement: 1,
          unitCode: "MON",
        },
        itemOffered: { "@type": "Service", name: `Belline ${p.name}`, serviceType: "AI receptionist" },
      };
      return JSON.stringify(offer, null, 2)
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n");
    })
    .join(",\n");
}

/**
 * Short generated phrases that sit outside the pricing block: the trial line
 * under the hero and in the closer, for example. Each appears in the page as
 * `<span class="gen" data-gen="KEY">…</span>` (or a `<p>`), and its text is
 * rewritten from the catalogue on every build, so nobody types it.
 */
export function generatedPhrases(market: Market = liveMarkets()[0] ?? "AE"): Record<string, string> {
  const saved = Math.min(...sellable(market).map((p) => annualMonthsSaved([p.id], market)));
  return {
    "trial-short": `${TRIAL.days} days free, no card.`,
    "hero-reassure": `${TRIAL.days} days free · No card required · Plans from ${lowestMonthly(market)}/month`,
    "video-ratio": `Included in every plan. Each video minute uses ${ratioText()} voice minutes.`,
    "faq-video": `Each video minute uses ${ratioText()} of your plan’s voice minutes, so a plan’s voice minutes cover up to ${sellable(market)
      .map((p) => `${videoMinutesOf(p.pools?.minutes ?? 0)} video minutes on ${p.name}`)
      .join(", ")
      .replace(/, ([^,]*)$/, " and $1")}.`,
    "roi-detail": renderRoi(market).detail,
    "faq-allowance": overLimitSentence(),
    "faq-tied-in":
      "No. Monthly plans cancel any time and run to the end of the paid period. " +
      (saved > 0
        ? `Annual plans are paid up front and include ${saved} month${saved === 1 ? "" : "s"} free.`
        : "Annual plans are paid up front."),
  };
}

/**
 * FAQ answers that name packs, caps or annual terms. They are generated, and
 * they appear twice: in the visible FAQ (by data-gen) and in the FAQPage
 * structured data (by question), so both say the same words.
 */
const GENERATED_FAQ: Record<string, string> = {
  "What happens if we use up our allowance?": "faq-allowance",
  "Are we tied in?": "faq-tied-in",
  "How are video minutes counted?": "faq-video",
};

/**
 * Generated phrases only a page with video on carries. The page in public/ is
 * the flag-off one; src/lib/site-flags.ts puts these in with the flag, and
 * check-billing pins its words to these.
 */
export const VIDEO_ONLY_PHRASES: ReadonlySet<string> = new Set(["video-ratio", "faq-video"]);

function applyGenerated(html: string): string {
  const phrases = generatedPhrases();
  for (const [key, text] of Object.entries(phrases)) {
    const slot = new RegExp(`(<(span|p) class="gen" data-gen="${key}">)[^<]*(</\\2>)`, "g");
    if (!html.includes(`class="gen" data-gen="${key}">`) && VIDEO_ONLY_PHRASES.has(key)) continue;
    if (!slot.test(html)) throw new Error(`landing.html has lost its generated "${key}" text.`);
    html = html.replace(slot, (_m, open: string, _tag: string, close: string) => `${open}${esc(text)}${close}`);
  }
  for (const [question, key] of Object.entries(GENERATED_FAQ)) {
    const name = JSON.stringify(question).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const answer = new RegExp(`("name": ${name}, "acceptedAnswer": \\{ "@type": "Answer", "text": )"(?:[^"\\\\]|\\\\.)*"`);
    if (!answer.test(html) && VIDEO_ONLY_PHRASES.has(key)) continue;
    if (!answer.test(html)) throw new Error(`landing.html's structured data has lost the answer to "${question}".`);
    html = html.replace(answer, (_m, open: string) => `${open}${JSON.stringify(phrases[key])}`);
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

/**
 * The two landing sources as the checks pin them: the English one with its
 * pricing and its picker, the German one as the Germany render of its
 * pricing, its flag-off strip and its picker. Paths, spelling and hreflang are
 * left to the build (scripts/site-locale.ts).
 */
export async function refreshSources(english: string, german: string): Promise<{ english: string; german: string }> {
  // The committed sources keep every country in the picker: they are sources,
  // not published pages. What a build publishes is filtered by language.de
  // (scripts/site-locale.ts publishedCountries), when the build re-applies it.
  const { applyLocalePicker, COUNTRY_PAGES } = await import("./site-locale");
  const { applyPricingDe } = await import("./site-pricing-de");
  const { applyIntegrations } = await import("./site-integrations");
  return {
    english: applyLocalePicker(applyPricing(english), "AE", COUNTRY_PAGES),
    german: applyLocalePicker(applyIntegrations(applyPricingDe(german, "DE"), {}, "de"), "DE", COUNTRY_PAGES),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  const files = { english: path.join(dir, "landing.html"), german: path.join(dir, "landing.de.html") };
  const before = { english: fs.readFileSync(files.english, "utf8"), german: fs.readFileSync(files.german, "utf8") };
  // Not a top-level await: site-pricing-de imports this module, and awaiting it
  // here while this module is still evaluating never settles.
  void refreshSources(before.english, before.german).then((rendered) => {
    // The generated blocks are written with \n; a CRLF checkout keeps CRLF throughout, rather than a file of mixed endings.
    const keep = (source: string, out: string) => (source.includes("\r\n") ? out.replace(/\r?\n/g, "\r\n") : out);
    const after = { english: keep(before.english, rendered.english), german: keep(before.german, rendered.german) };
    for (const key of ["english", "german"] as const) {
      const name = `public/${path.basename(files[key])}`;
      if (after[key] === before[key]) {
        console.log(`  ${name} pricing is already current.`);
      } else {
        fs.writeFileSync(files[key], after[key], "utf8");
        console.log(`  ${name} pricing rewritten from src/lib/billing/plans.ts.`);
      }
    }
  });
}
