/**
 * The location landing pages, rendered.
 *
 * One function per shape — the landing page itself, a trade hub, a city hub,
 * the index — all built from public/site.css and the same blocks as every
 * other page on this site (scripts/site-chrome.ts). There is no second design
 * system here and no second source of prices: a page that can be bought on
 * renders the catalogue through `renderPricing`, exactly as public/landing.html
 * does, and a page that cannot renders no prices at all.
 *
 * The one rule that shapes every function below:
 *
 *   **A page for a market that is not live never carries a way to buy.**
 *
 * `src/lib/markets.ts` says AE is live and GB and IE are not, and the checkout
 * refuses a market that is not live — so a London page with a "Get started"
 * button would send somebody to a checkout that turns them away, having told
 * them on the way that we serve their city. Instead those pages carry the
 * waitlist, the same way the German pages do, and say in the hero that we are
 * not open there. `marketLive` is read once per page and decides the hero's
 * button, the pricing section, the closer, the structured data's offers and
 * the footer. scripts/check-seo.ts fails the build if a checkout link, a
 * trial sentence or a price ever reaches one of them.
 */

import { VERTICALS } from "../site-content";
import { renderPricing, trialSentence } from "../site-pricing";
import { TRIAL } from "../../src/lib/billing/plans";
import { MARKETS, formatMoney } from "../../src/lib/markets";
import { publicFlag } from "../../src/lib/site-flags";
import { priceOf, sellable } from "../../src/lib/billing/plans";
import { BADGE, BELL_FAB, CALL_PANEL, DEMO_NUMBER, DEMO_NUMBER_SPOKEN, HERO_VIDEO, MARK, MENU_TOGGLE, esc } from "../site-chrome";
import { SEO_CITIES, inCity, seoCity, seoCountry, type SeoCity } from "./cities";
import { seoVertical, type SeoFaq, type SeoVertical } from "./verticals";
import type { PairCopy } from "./pairs";
import {
  MATRIX_FRAMING,
  ORIGIN,
  cityHubPath,
  comboPath,
  countryHubPath,
  countrySlug,
  framingPath,
  indexPath,

  marketLive,
  marketName,
  seoAlternates,
  verticalHubPath,
  type ChannelHubPage,
  type ChannelTradePage,
  type ComboPage,
  type HubPage,
  type SeoLocale,
  type SeoPage,
} from "./matrix";

const APP = "https://app.belline.ai";

/** Every page in the matrix, so a renderer can link to its siblings. */
export interface RenderContext {
  pages: SeoPage[];
  /** Clip filenames for a demo scene, or undefined when the audio is not built. */
  withAudio: (scene: { turns: [string, string][] }) => (string | null)[] | undefined;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** The trade page's recorded demo scenes, so the call panel plays the real thing. */
function scenesFor(vertical: SeoVertical, ctx: RenderContext) {
  const slug = (vertical.tradePage ?? "").replace(/^\//, "");
  const trade = VERTICALS.find((v) => v.slug === slug);
  if (!trade) return [];
  return trade.scenes.map((sc) => ({ ...sc, audio: ctx.withAudio(sc) }));
}

// --- head ---------------------------------------------------------------------

interface HeadParts {
  title: string;
  description: string;
  path: string;
  /** The same page in another locale, for hreflang. Never composed by hand. */
  pathFor: (locale: SeoLocale) => string;
  jsonLd: string;
}

function head({ title, description, path, pathFor, jsonLd }: HeadParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#FFFFFF">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${ORIGIN}${path}">
${seoAlternates(pathFor)}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Belline">
<meta property="og:url" content="${ORIGIN}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:locale" content="en_AE">
<meta property="og:image" content="${ORIGIN}/brand/belline-og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Belline bell button beside the words: Someone always answers.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ORIGIN}/brand/belline-og.png">
<script type="application/ld+json">
${jsonLd}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body${VIDEO ? ' class="video-pending"' : ""}>
`;
}

/**
 * Is Belle's video bubble live in this build?
 *
 * It decides two class names and nothing else, and it has to, because the
 * alternative is what these pages were doing: painting the no-video hero —
 * the still face under a heading, a paragraph, a "Talk to Belle" button and
 * three floating buttons — and then letting site.js take all of it away again
 * when the widget config answers. Measured on a warm local cache, the hero's
 * "Get started" was at y=426 for the first two seconds and at y=700
 * afterwards: a 274-pixel jump, on a phone, under the reader's thumb, at the
 * only moment the page asks them to do anything.
 *
 * `body.video-pending` and `.hero-demo.has-video-hero` are exactly the two
 * classes public/landing.html carries for this (src/lib/site-flags.ts), and
 * site.css was written to hold Belle's place with them. The landing page gets
 * them from the flag swap machinery, which is keyed to that one file by exact
 * strings; these pages are generated, so they read the same flag directly.
 */
const VIDEO = publicFlag("video.avatar");

/**
 * The header.
 *
 * "Get started" only on a page somebody can act on. On a page for a market we
 * are not open in, the header's call to action is the waitlist anchor on that
 * same page — the German pages do exactly this, and for the same reason: a
 * nav button that leads to a checkout which refuses you is worse than no
 * button.
 */
function header(live: boolean, links: { href: string; label: string }[]): string {
  const nav = links.map((l) => `      <a href="${l.href}">${esc(l.label)}</a>`).join("\n");
  const cta = live
    ? `      <a class="nav-cta" href="${APP}/checkout">Get started</a>
      <a class="nav-quiet" href="${APP}/login" rel="nofollow">Sign in</a>`
    : `      <a class="nav-cta" href="#waitlist">Join the waitlist</a>`;
  return `<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="/">
      ${BADGE}
      <span>Belline</span>
    </a>
    <nav id="site-nav" data-open="false">
${nav}
${cta}
    </nav>
${MENU_TOGGLE}
  </div>
</header>
`;
}

function footer(live: boolean): string {
  return `<footer>
  <div class="wrap foot-in">
    <a class="brand" href="/">
      ${BADGE}
      <span>Belline</span>
    </a>
    <p>
      AI voice and chat reception for businesses that take calls, messages or bookings.
      ${live ? "Live in the United Arab Emirates." : "Live in the United Arab Emirates only."}<br>
      <a href="mailto:hello@belline.ai">hello@belline.ai</a> ·
      <a href="${APP}/login" rel="nofollow">Staff sign-in</a><br>
      <a href="/privacy">Privacy policy</a> ·
      <a href="/terms">Terms of service</a> ·
      <a href="${indexPath()}">All locations</a>
    </p>
  </div>
</footer>
`;
}

const scripts = (scenes: unknown[]) =>
  `${BELL_FAB}
<script type="application/json" id="call-scenes">${JSON.stringify(scenes)}</script>
<script src="/site.js"></script>
</body>
</html>
`;

// --- shared sections ----------------------------------------------------------

/**
 * The line under the demo call button.
 *
 * The published demo number is a United States one, so the sentence says so
 * wherever the reader is: from Dubai it is an international call, and from
 * London it is an international call. Saying it twice in the same words on
 * every page is deliberate — it is the kind of sentence that gets dropped
 * from a generated page and then nobody notices for a month.
 */
const demoLine = (city: SeoCity) =>
  `Free, in your browser, 24 hours a day, up to ten minutes a call. There is a dial-in too, on a United States number — <a href="tel:${DEMO_NUMBER}">${DEMO_NUMBER_SPOKEN}</a> — so from ${esc(city.name)} it is an international call at your own cost. The browser is the better way.`;

/**
 * "the United Kingdom", not "United Kingdom".
 *
 * `MARKETS[…].name` is the country's name on a form — "United Kingdom",
 * "United Arab Emirates" — and a sentence needs the article those names carry
 * in prose. Without it the London page read "we will write when we open in
 * United Kingdom", which is the sort of thing a template says.
 */
const theMarketName = (city: SeoCity) => {
  const name = marketName(city);
  return /^(United|Netherlands|Philippines|Czech)/.test(name) ? `the ${name}` : name;
};

/** The clock a reader recognises, not the IANA identifier the server uses. */
const CLOCK_NAMES: Record<string, string> = {
  "Asia/Dubai": "Gulf Standard Time",
  "Europe/London": "UK time",
  "Europe/Dublin": "Irish time",
};
const clockName = (city: SeoCity) => CLOCK_NAMES[city.timezone] ?? `${city.timezone.replace("_", " ")} time`;

/** How it works. The home page's three steps, in the trade's own words. */
function howItWorks(vertical: SeoVertical, live: boolean): string {
  return `  <section id="how" class="rule" data-shared="site">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">How it works</p>
          <h2 class="display">Set up from what you already have.</h2>
        </div>
        <p class="sec-lead lead">Most of the work is checking what Belline found. You decide when customers reach it.</p>
      </div>

      <ol class="steps steps-home">
        <li class="step">
          <div class="num" aria-hidden="true">1</div>
          <h3>Give Belline what you already have</h3>
          <p>Your website, price list or brochure. It reads them and drafts your services, prices, hours and the questions ${esc(vertical.singular)} gets asked every day.</p>
        </li>
        <li class="step">
          <div class="num" aria-hidden="true">2</div>
          <h3>Check what it found</h3>
          <p>Fix anything wrong, fill the gaps, and set the rules it must hold. Nothing goes live until you have read it.</p>
        </li>
        <li class="step">
          <div class="num" aria-hidden="true">3</div>
          <h3>Switch it on</h3>
          <p>Ring it yourself first. Then forward your line and paste one line of HTML into your website. Customers only reach Belline once you do.</p>
        </li>
      </ol>
${live ? `\n      <div class="cta-row">\n        <a class="btn" href="${APP}/checkout" data-cta="steps">Get started</a>\n      </div>\n` : ""}    </div>
  </section>
`;
}

/** The per-channel feature list, the same three channels as the home page. */
function channels(city: SeoCity): string {
  return `  <section id="channels" class="rule" data-shared="site">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Every channel</p>
          <h2 class="display">Call answering, website chat and WhatsApp — one receptionist.</h2>
        </div>
        <p class="sec-lead lead">Chat and voice on your website, WhatsApp and your phone, with the same information and the same rules in each.</p>
      </div>

      <ul class="channels channels-3">
        <li>
          <div class="channel-head">
            <h3>Chat and voice on your website</h3>
            <span class="state state-available">Available</span>
          </div>
          <p>Visitors type, or tap to talk, without leaving your website. Your team can take over any chat from the inbox.</p>
          <p class="channel-how">One line of HTML.</p>
        </li>
        <li>
          <div class="channel-head">
            <h3>WhatsApp for your business</h3>
            <span class="state state-available">Available</span>
          </div>
          <p>Belline answers a second WhatsApp number you register with it. Your own WhatsApp stays as it is. ${esc(city.habits.split(".")[0])}.</p>
          <p class="channel-how">We set the number up with you.</p>
        </li>
        <li>
          <div class="channel-head">
            <h3>Your phone</h3>
            <span class="state state-available">Available</span>
          </div>
          <p>Keep your number. Forward calls to Belline when nobody answers or the line is busy. Your phone provider may charge for forwarded calls.</p>
          <p class="channel-how">One setting on the line you already have.</p>
        </li>
      </ul>
    </div>
  </section>
`;
}

/**
 * Where a customer story will go.
 *
 * Not a placeholder in the sense the check hunts for — there is no lorem, no
 * TODO and no invented quotation. It is a true sentence about the state of the
 * business, in the space a real story will occupy, because the alternative on
 * a page like this is always the same: somebody writes "Trusted by 200+ Dubai
 * restaurants" and nobody can point at one of them.
 */
function caseStudySlot(vertical: SeoVertical, city: SeoCity): string {
  const live = marketLive(city);
  // Not a full-width section with a photograph and display type any more.
  // The sentence is true and worth saying; said at the same size as "Per
  // location, per month", sixteen times across the system, an honest
  // admission starts to read as the thing this company most wants to talk
  // about. Same words, a tenth of the weight.
  return `  <section class="rule">
    <div class="wrap">
      <div data-case-study="pending" style="max-width:62ch">
        <div>
          <p class="eyebrow">Customer stories</p>
          <h3>There is no testimonial here yet.</h3>
          <p class="fine" style="margin-top:12px">
            ${
              live
                ? `When ${esc(vertical.singular)} ${esc(inCity(city))} agrees to be named, its story goes in this space: what it was losing, what it changed, and what its own team says about it.`
                : `Nobody ${esc(inCity(city))} can be a customer yet, so there is nobody here to quote. When we open in ${esc(theMarketName(city))} and somebody agrees to be named, their story goes in this space.`
            }
            Until then this space stays empty on purpose. We are not going to write
            a quotation nobody said, or count customers we do not have.
          </p>
${
  live
    ? `          <p class="fine">
            Running ${esc(vertical.singular)} ${esc(inCity(city))} and willing to talk about it?
            <a href="mailto:hello@belline.ai">Write to us</a> and a person answers.
          </p>`
    : ""
}
        </div>
      </div>
    </div>
  </section>
`;
}

/** The FAQ, visible. The same questions and the same words go into the JSON-LD. */
function faqSection(faqs: SeoFaq[]): string {
  const items = faqs
    .map(
      (f) => `        <details>
          <summary>${esc(f.q)}</summary>
          <div class="answer"><p>${esc(f.a)}</p></div>
        </details>`,
    )
    .join("\n");
  return `  <section id="faq" class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Questions</p>
          <h2 class="display">What operators ask us.</h2>
        </div>
      </div>
      <div class="faq">
${items}
      </div>
    </div>
  </section>
`;
}

/**
 * The pricing block, from the catalogue, for a market we are live in.
 *
 * `renderPricing` is the same function public/landing.html's prices come from
 * (scripts/site-pricing.ts, reading src/lib/billing/plans.ts). One market, so
 * no market picker: a Dubai page shows dirhams and nothing else.
 */
function pricing(city: SeoCity): string {
  return `  <section id="price" class="rule" data-shared="site">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Pricing</p>
          <h2 class="display">Per location, per month.</h2>
        </div>
        <p class="sec-lead lead">The same prices as everywhere else in ${esc(marketName(city))}. No setup fee, no per-call charge.</p>
      </div>
${renderPricing([city.market])}
    </div>
  </section>
`;
}

/**
 * The waitlist, for a market we are not open in.
 *
 * Copied in substance from public/landing.de.html: the same endpoint, the same
 * honeypot, the same privacy sentence, the same "we are not emailing you now".
 * What it must never grow is a price, a trial sentence or a checkout link —
 * there is nothing to buy, and a page that implies otherwise is the exact
 * dishonesty this whole arrangement exists to avoid.
 */
function waitlist(city: SeoCity, vertical: SeoVertical | null, path: string): string {
  const types: [string, string][] = [
    ["salon", "Salon or spa"],
    ["restaurant", "Restaurant or café"],
    ["clinic", "Clinic"],
    ["dental", "Dental practice"],
    ["fitness", "Gym or studio"],
    ["real-estate", "Real estate"],
    ["garage", "Garage or car service"],
    ["education", "Tutor or school"],
    ["home-services", "Home services"],
    ["hotel", "Hotel"],
    ["pet-care", "Pet care"],
    ["professional", "Professional services"],
    ["other", "Something else"],
  ];
  const guess = vertical
    ? { restaurants: "restaurant", "hair-salons": "salon", "dental-clinics": "dental", "aesthetic-clinics": "clinic", spas: "salon" }[vertical.slug]
    : "";
  const options = types
    .map(([value, label]) => `                <option value="${value}"${value === guess ? " selected" : ""}>${esc(label)}</option>`)
    .join("\n");
  const countries = [...new Set([city.market, "GB", "IE"])].filter((m) => MARKETS[m as "GB"].status === "not-yet");
  const countryOptions = countries
    .map((m) => `                <option value="${m}"${m === city.market ? " selected" : ""}>${esc(MARKETS[m as "GB"].name)}</option>`)
    .join("\n");

  return `  <section id="book" class="rule closer" data-shared="site">
    <div class="wrap closer-in">
      <div>
        <p class="eyebrow">Not open here yet</p>
        <h2 class="display">Be first when we open ${esc(inCity(city))}.</h2>
        <p class="lead">
          Belline is live in the United Arab Emirates and nowhere else. There is
          nothing to buy on this page and no price to quote you in ${esc(MARKETS[city.market].currency)}.
          Leave your details and we will write when we open in ${esc(theMarketName(city))}.
        </p>
        <p class="fine">
          What "not open" means, concretely: no local numbers bought, no support
          hours in this timezone, and a checkout that will not take a business
          registered in ${esc(theMarketName(city))}.
        </p>

        <form class="book-form waitlist" id="waitlist" action="${APP}/api/leads/waitlist" method="post" novalidate>
          <input type="hidden" name="page" value="${esc(path)}">
          <div class="f-row">
            <label class="f">
              <span>Your name</span>
              <input name="name" type="text" autocomplete="name" maxlength="120" required>
              <em class="f-err" hidden></em>
            </label>
            <label class="f">
              <span>Email</span>
              <input name="email" type="email" autocomplete="email" maxlength="254" required>
              <em class="f-err" hidden></em>
            </label>
          </div>
          <div class="f-row">
            <label class="f">
              <span>Business</span>
              <input name="company" type="text" autocomplete="organization" maxlength="160" required>
              <em class="f-err" hidden></em>
            </label>
            <label class="f">
              <span>Country</span>
              <select name="country" required>
${countryOptions}
              </select>
              <em class="f-err" hidden></em>
            </label>
          </div>
          <label class="f">
            <span>Business type <span class="opt">(optional)</span></span>
            <select name="businessType">
              <option value="">Please choose</option>
${options}
            </select>
            <em class="f-err" hidden></em>
          </label>
          <div class="hp" aria-hidden="true">
            <label>Website <input name="website2" type="text" tabindex="-1" autocomplete="off"></label>
          </div>
          <p class="f-note waitlist-privacy">
            We store your name, email address, business, country and business type
            so we can contact you when Belline opens where you are. We are not
            emailing you now. Ask us to delete your entry at any time at
            <a href="mailto:hello@belline.ai">hello@belline.ai</a>.
            More in the <a href="/privacy">privacy policy</a>.
          </p>
          <button class="btn book-submit" type="submit">Join the waitlist</button>
          <p class="f-note waitlist-note" role="status" aria-live="polite"></p>
        </form>
      </div>

      <div class="proof">
        <h3>Try it before we get there.</h3>
        <p>Speak to Belle free in your browser. It is the same receptionist your customers would reach, answering in English.</p>
        <ul>
          <li>Ask what it costs</li>
          <li>Ask it something awkward</li>
          <li>Ask to speak to a person</li>
        </ul>
        <div class="cta-row">
          <a class="btn line" href="${APP}/call?start=1" data-call>Speak to Belle</a>
        </div>
        <p class="fine">${demoLine(city)}</p>
      </div>
    </div>
  </section>
`;
}

/** The closing call to action for a market we are live in. */
function closer(city: SeoCity, vertical: SeoVertical): string {
  return `  <section class="rule closer" data-shared="site">
    <div class="wrap">
      <p class="eyebrow">Hear it now</p>
      <h2 class="display">Be the caller.</h2>
      <p class="lead" style="margin-top:26px; max-width:50ch">
        The same receptionist your callers in ${esc(city.name)} would reach. Ask it
        something hard, then ask for a person.
      </p>

      <div class="cta-row" style="margin-top:34px">
        <a class="btn" href="${APP}/checkout" data-cta="closer">Get started</a>
        <a class="btn line" href="${APP}/call?start=1" data-call>
          ${MARK}
          Speak to Belline
        </a>
      </div>

      <p class="fine" style="max-width:56ch">${demoLine(city)}</p>

      <div class="terms">
        <div>
          <h4>Keep your number</h4>
          <p>Forward calls to Belline from the ${esc(city.name)} line you already have. Forward only the calls nobody answers, and your team still picks up first.</p>
        </div>
        <div>
          <h4>Nothing to install</h4>
          <p>No new handset, no app for your staff, no change to what is printed on your door.</p>
        </div>
        <div>
          <h4>${TRIAL.days} days free</h4>
          <p>${esc(trialSentence())}</p>
        </div>
      </div>
    </div>
  </section>
`;
}

/** Siblings and hubs. Every href is checked against the built set by check-seo. */
function internalLinks(page: ComboPage, ctx: RenderContext): string {
  const combos = ctx.pages.filter((p): p is ComboPage => p.kind === "combo");
  const sameVertical = combos.filter((p) => p.vertical.slug === page.vertical.slug && p.city.slug !== page.city.slug);
  const sameCity = combos.filter((p) => p.city.slug === page.city.slug && p.vertical.slug !== page.vertical.slug);
  const list = (items: { href: string; label: string }[]) =>
    items.map((i) => `        <li><a href="${i.href}">${esc(i.label)}</a></li>`).join("\n");

  const blocks: string[] = [];
  // The labels name the trade and the city rather than just one of them. Bare
  // "Dubai" and bare "Dental clinics" were twelve inbound links to a page
  // about dental clinics in Dubai, not one of which said so.
  if (sameVertical.length) {
    blocks.push(`      <div>
        <h3>${esc(page.vertical.name)} in other cities</h3>
        <ul class="kinds">
${list(sameVertical.map((p) => ({ href: p.path, label: `${p.vertical.name} ${inCity(p.city)}` })))}
        </ul>
      </div>`);
  }
  if (sameCity.length) {
    blocks.push(`      <div>
        <h3>Other trades in ${esc(page.city.name)}</h3>
        <ul class="kinds">
${list(sameCity.map((p) => ({ href: p.path, label: `${p.vertical.name} ${inCity(p.city)}` })))}
        </ul>
      </div>`);
  }
  blocks.push(`      <div>
        <h3>Start somewhere wider</h3>
        <ul class="kinds">
          <li><a href="${verticalHubPath(page.vertical.slug)}">AI receptionist for ${esc(page.vertical.plural)}</a></li>
          <li><a href="${cityHubPath(page.city)}">AI receptionist ${esc(inCity(page.city))}</a></li>
          <li><a href="${indexPath()}">Every trade and city</a></li>
${page.vertical.tradePage ? `          <li><a href="${page.vertical.tradePage}">Belline for ${esc(page.vertical.name.toLowerCase())}</a></li>` : ""}
        </ul>
      </div>`);

  // The other two framings, and only where this build actually wrote them.
  // A WhatsApp page for this trade if there is one, the call-answering page
  // always — they are the same product read from a different angle, and a
  // reader who came looking for one of those phrases should not have to go
  // back to a search engine to find it.
  const whatsapp = ctx.pages.find(
    (p): p is ChannelTradePage => p.kind === "channel-trade" && p.vertical.slug === page.vertical.slug,
  );
  const callAnswering = ctx.pages.find((p): p is ChannelHubPage => p.kind === "channel-hub" && p.framing.slug === "call-answering");
  const otherFramings = [
    ...(whatsapp ? [{ href: whatsapp.path, label: `WhatsApp chatbot for ${whatsapp.vertical.plural}` }] : []),
    ...(callAnswering ? [{ href: callAnswering.path, label: "Call answering, and how it differs" }] : []),
  ];
  if (otherFramings.length) {
    blocks.push(`      <div>
        <h3>The same line, a different way in</h3>
        <ul class="kinds">
${list(otherFramings)}
        </ul>
      </div>`);
  }

  return `  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Nearby</p>
          <h2 class="display">Somewhere else, or something else.</h2>
        </div>
      </div>
      <div class="knows">
${blocks.join("\n")}
      </div>
    </div>
  </section>
`;
}

// --- structured data ----------------------------------------------------------

/**
 * FAQPage, and a Service that describes what is on offer where.
 *
 * `offers` appear only on a page for a market we are live in. An Offer is a
 * statement that the thing can be bought, and putting a price on the London
 * page's structured data would put a price in a search result for a city whose
 * checkout turns people away — the same lie, told by a machine instead of a
 * sentence. SoftwareApplication carries the offers on those pages because it
 * is what the home page already uses and the prices come from one catalogue.
 */
function comboJsonLd(page: ComboPage, faqs: SeoFaq[]): string {
  const { vertical, city } = page;
  const live = marketLive(city);
  const url = `${ORIGIN}${page.path}`;
  const name = `AI receptionist for ${vertical.plural} ${inCity(city)}`;

  const graph: unknown[] = [
    {
      "@type": "Organization",
      "@id": `${ORIGIN}/#organization`,
      name: "Belline",
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/brand/png/belline-mark-512.png`,
      email: "hello@belline.ai",
      // No `telephone`. The only number we publish is the demo line, and it is
      // a United States one: the visible copy says so in the same breath, and
      // a machine-readable field cannot carry that qualification. Presenting a
      // demo number as the company's phone number is the kind of small lie
      // structured data makes easy and nobody ever notices.
      areaServed: "AE",
    },
    {
      "@type": "Service",
      name,
      serviceType: "AI receptionist",
      url,
      description: page.pair.description,
      provider: { "@id": `${ORIGIN}/#organization` },
      // `areaServed` is a statement that the service is available there, so on
      // a market we are not open in it says the country we *are* open in and
      // the page's own words carry the rest. It used to name London, on a page
      // whose first paragraph says we are not open in London — the visible
      // half honest and the machine-readable half not, which is the worse way
      // round of the two.
      areaServed: live
        ? { "@type": "City", name: city.name, containedInPlace: { "@type": "Country", name: MARKETS[city.market].name } }
        : { "@type": "Country", name: MARKETS.AE.name },
      audience: { "@type": "BusinessAudience", name: vertical.plural },
      ...(live ? { availableChannel: { "@type": "ServiceChannel", serviceUrl: `${APP}/checkout` } } : {}),
    },
    // And no SoftwareApplication at all where there is nothing to offer. An
    // application node with no `offers` is not eligible for the rich result it
    // exists to earn, so on the waitlist pages it was an invalid item making a
    // claim to a search engine that the page itself refuses to make.
    ...(live
      ? [
          {
            "@type": "SoftwareApplication",
            name: "Belline",
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            url: `${ORIGIN}/`,
            offers: sellable(city.market).map((p) => ({
              "@type": "Offer",
              name: `Belline ${p.name}`,
              price: String(priceOf(p.id, city.market) / 100),
              priceCurrency: MARKETS[city.market].currency,
              url: `${APP}/checkout`,
              availability: "https://schema.org/InStock",
            })),
          },
        ]
      : []),
    {
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "AI receptionist", item: `${ORIGIN}${indexPath()}` },
        { "@type": "ListItem", position: 2, name: vertical.name, item: `${ORIGIN}${verticalHubPath(vertical.slug)}` },
        { "@type": "ListItem", position: 3, name: city.name, item: `${ORIGIN}${cityHubPath(city)}` },
        { "@type": "ListItem", position: 4, name: name, item: url },
      ],
    },
  ];
  return json({ "@context": "https://schema.org", "@graph": graph });
}

function hubJsonLd(page: HubPage, title: string, description: string, faqs: SeoFaq[] = []): string {
  return json({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: title,
        url: `${ORIGIN}${page.path}`,
        description,
        hasPart: page.combos.map((c) => ({
          "@type": "WebPage",
          name: `AI receptionist for ${c.vertical.plural} ${inCity(c.city)}`,
          url: `${ORIGIN}${c.path}`,
        })),
      },
      // A trade hub renders eight visible questions and used to publish none
      // of them. The words are identical to the ones on the page, which is the
      // only condition under which this markup is allowed to exist.
      ...(faqs.length
        ? [
            {
              "@type": "FAQPage",
              mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
            },
          ]
        : []),
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "AI receptionist", item: `${ORIGIN}${indexPath()}` },
          ...(page.path === indexPath() ? [] : [{ "@type": "ListItem", position: 2, name: title, item: `${ORIGIN}${page.path}` }]),
        ],
      },
    ],
  });
}

// --- the landing page ---------------------------------------------------------

/**
 * The landing page's six to eight questions.
 *
 * The pair's own first, up to four of them, because they are the questions
 * only this page can answer — and because a FAQ block that is entirely
 * trade-level is a FAQ block six sister pages also carry word for word. The
 * trade's own questions are rotated so that two sister pages do not carry the
 * same four answers, and all of them live on the trade hub above.
 */
export function faqsFor(vertical: SeoVertical, pair: PairCopy, city?: SeoCity): SeoFaq[] {
  const mine = pair.faqs.slice(0, 4);
  // A trade question the pair already asked is dropped and the next one taken
  // in its place. Without this, four pages shipped two versions of the same
  // question six lines apart in one accordion — "Will it tell a caller a
  // treatment will work for them?" above "Will it tell a caller whether a
  // treatment is right for them?" — which is the most visible way a generated
  // page announces itself. The pair's version wins, because it is the one
  // written for this city.
  const rotated = tradeFaqsFor(vertical, city).filter((t) => !mine.some((p) => sameQuestion(p, t)));
  const spare = vertical.faqs.filter(
    (t) => !rotated.includes(t) && !mine.some((p) => sameQuestion(p, t)) && !rotated.some((r) => sameQuestion(r, t)),
  );
  return [...mine, ...rotated, ...spare].slice(0, Math.max(6, mine.length + rotated.length));
}

/**
 * Two questions that a reader would call the same question.
 *
 * Word overlap rather than anything clever: these are short questions in one
 * voice, and if half the words match, the answers underneath them match too.
 * Measured over both the question and the answer, because "How does it handle
 * a wedding party?" and "Can it handle a bridal enquiry?" share almost no
 * words and have, word for word, the same answer.
 */
export function sameQuestion(a: SeoFaq, b: SeoFaq): boolean {
  return overlap(a.q, b.q) >= 0.5 || overlap(a.a, b.a) >= 0.45;
}

const STOP = new Set(["the", "a", "an", "it", "is", "are", "to", "of", "and", "or", "for", "in", "on", "with", "that", "this", "does", "do", "will", "can", "what", "how", "your", "our", "you", "we", "they", "them", "its", "not", "no", "yes", "at", "by", "as", "from", "be", "been", "has", "have", "if", "so", "but", "than", "then", "there", "their", "one", "any", "all", "which", "who", "when"]);

function overlap(x: string, y: string): number {
  const words = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    );
  const a = words(x);
  const b = words(y);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  // Over the union, not the smaller set: measured against the smaller set, a
  // three-word question matched almost anything that happened to contain one
  // of its words.
  return shared / (a.size + b.size - shared);
}

/**
 * Which of the trade's own questions this city's page carries.
 *
 * Two, and a different two in each city, so that the three pages under a trade
 * do not publish the same four answers word for word. The slice is taken by
 * the city's position in the city list, modulo four, so the four cities
 * in this system disjoint and keeps a page's questions stable when a fifth is
 * added somewhere else.
 *
 * The full eight are on the trade hub, which is where somebody reading about
 * the trade rather than about their own city arrives — so nothing is hidden,
 * and the page that repeats them is the one page above all of them rather than
 * three pages beside each other.
 */
export function tradeFaqsFor(vertical: SeoVertical, city?: SeoCity): SeoFaq[] {
  if (!city) return vertical.faqs.slice(0, 2);
  const slot = Math.max(0, SEO_CITIES.findIndex((c) => c.slug === city.slug)) % 4;
  const mine = vertical.faqs.filter((_, i) => i % 4 === slot);
  return mine.length ? mine : vertical.faqs.slice(0, 2);
}

/** The trade's questions, all of them, on the hub above the city pages. */
export const hubFaqs = (vertical: SeoVertical): SeoFaq[] => vertical.faqs;

export function comboPage(page: ComboPage, ctx: RenderContext): string {
  const { vertical, city, pair } = page;
  const live = marketLive(city);
  const title = `AI receptionist for ${vertical.titlePlural ?? vertical.plural} ${inCity(city)} | Belline`;
  const h1 = `AI receptionist for ${vertical.plural} ${inCity(city)}`;
  const faqs = faqsFor(vertical, pair, city);
  const scenes = scenesFor(vertical, ctx);

  /**
   * The demo call, only where there is a recorded one.
   *
   * The scenes come from the trade page under /salons, /dental, /clinics or
   * /restaurants, keyed to audio clips by their exact text. Real estate has no
   * such page, so its landing pages carry no call panel rather than playing a
   * dental practice's conversation under a property heading — which is what an
   * empty panel would have done, because site.js falls back to the site-wide
   * scenes when the page gives it none.
   */
  const hearTheLine = scenes.length
    ? `
  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Hear the line</p>
          <h2 class="display">Two calls ${esc(vertical.singular)} actually takes.</h2>
        </div>
        <p class="sec-lead lead">
          The first is the request taken for your team to confirm. The second is
          the call Belline refuses or hands over — which is the one you are
          really deciding about.
        </p>
      </div>
${CALL_PANEL}
    </div>
  </section>
`
    : "";

  const heroCta = live
    ? `        <div class="cta-row rise rise-3">
          <a class="btn" href="${APP}/checkout" data-cta="hero">Get started</a>
        </div>

        <p class="hero-note rise rise-4">
          <span class="gen" data-gen="hero-reassure">${TRIAL.days} days free · No card required · Plans from ${formatMoney(
            Math.min(...sellable(city.market).map((p) => priceOf(p.id, city.market))),
            city.market,
          )}/month</span>
          <span class="hero-note-more"><span class="hero-langs" data-langs>Answers in English.</span></span>
        </p>`
    : `        <div class="cta-row rise rise-3">
          <a class="btn" href="#waitlist" data-cta="hero">Join the waitlist</a>
        </div>

        <p class="hero-note rise rise-4">
          Belline is live in the United Arab Emirates and is <strong>not open in ${esc(theMarketName(city))}</strong> yet.
          Nothing on this page can be bought.
          <span class="hero-note-more"><span class="hero-langs" data-langs>Answers in English.</span></span>
        </p>`;

  return (
    head({
      title,
      description: pair.description,
      path: page.path,
      pathFor: (locale) => comboPath(vertical.slug, city, locale.lang),
      jsonLd: comboJsonLd(page, faqs),
    }) +
    header(live, [
      { href: verticalHubPath(vertical.slug), label: vertical.name },
      { href: cityHubPath(city), label: city.name },
      { href: "#how", label: "How it works" },
      { href: live ? "#price" : "#waitlist", label: live ? "Pricing" : "Waitlist" },
    ]) +
    `
<main>

  <section class="hero">
    <div class="wrap hero-in hero-demo${VIDEO ? " has-video-hero" : ""}">
      <div class="hero-copy">
        <p class="eyebrow rise">Belline ${esc(inCity(city))}</p>
        <h1 class="display rise rise-1">${esc(h1)}</h1>
        <p class="lead rise rise-2">${esc(pair.lead)}</p>

        <ul class="hero-can rise rise-2" aria-label="What Belline does for you">
          <li>Answers questions</li>
          <li>Captures enquiries</li>
          <li>Takes booking requests</li>
        </ul>

${heroCta}
      </div>

${HERO_VIDEO}
    </div>
  </section>

${hearTheLine}
  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">${esc(city.name)}, specifically</p>
          <h2 class="display">What ${esc(vertical.singular)} ${esc(inCity(city))} is actually answering.</h2>
        </div>
        <p class="sec-lead lead">${esc(city.intro.split(". ")[0])}.</p>
      </div>

      <div class="knows">
${pair.local.map((p) => `        <div>\n          <h3>${esc(p.head)}</h3>\n          <p>${esc(p.body)}</p>\n        </div>`).join("\n")}
      </div>

      <!--
        Two facts, not four. The week and the peak hours belong in the pair
        copy above, where somebody has written about what they mean for this
        trade; repeating the city hub's four-up block here made a third of
        every landing page identical to a page one click away, which is
        exactly what check-seo's uniqueness floor is for.
      -->
      <div class="terms">
        <div>
          <h4>Languages on the line</h4>
          <p>${esc(city.languages)}</p>
        </div>
        <div>
          <h4>In an emergency</h4>
          <p>Belline gives the instruction you set for ${esc(city.country)}: ${esc(city.emergency)}. It takes no appointment request at that moment, because an appointment would be the wrong answer.</p>
        </div>
        <div>
          <h4>Your own number</h4>
          <p>Keep the ${esc(city.name)} number on your door and your listings. You forward the calls nobody answers; nothing about how customers reach you changes.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">What comes down the line</p>
          <h2 class="display">Every call ${esc(vertical.singular)} gets, and what happens to it.</h2>
        </div>
        <p class="sec-lead lead">Belline takes requests. Your team confirms them. Nothing enters your diary without a person putting it there.</p>
      </div>

      <div class="knows">
${vertical.callTypes.map((p) => `        <div>\n          <h3>${esc(p.head)}</h3>\n          <p>${esc(p.body)}</p>\n        </div>`).join("\n")}
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="split">
        <div>
          <p class="eyebrow">Where it stops</p>
          <h2 class="display">The most important thing it does is know what it must not answer.</h2>
          <p style="margin-top:26px">${esc(vertical.boundary)}</p>
        </div>
        <figure class="plate">
          <img src="${esc(vertical.image)}" width="880" height="495" loading="lazy" alt="${esc(vertical.imageAlt)}">
        </figure>
      </div>
    </div>
  </section>

${channels(city)}${howItWorks(vertical, live)}${live ? pricing(city) : ""}${caseStudySlot(vertical, city)}${faqSection(faqs)}${live ? closer(city, vertical) : waitlist(city, vertical, page.path)}${internalLinks(page, ctx)}
</main>

` +
    footer(live) +
    scripts(scenes)
  );
}

// --- hubs ---------------------------------------------------------------------

function comboCards(page: HubPage, by: "city" | "vertical"): string {
  return page.combos
    .map((c) => {
      const label = by === "city" ? c.city.name : c.vertical.name;
      const line =
        by === "city"
          ? `${c.city.week.split(".")[0]}.`
          : `${c.vertical.pains[0].head}.`;
      return `        <div>
          <h3><a href="${c.path}">${esc(label)}</a></h3>
          <p>${esc(line)}</p>
        </div>`;
    })
    .join("\n");
}

export function verticalHubPage(page: HubPage, ctx: RenderContext): string {
  const v = page.vertical!;
  /**
   * A hub is buyable when **any** city under it is.
   *
   * It used to be `every`, which went wrong the moment one trade had cities in
   * two markets. The dental hub lists Dubai, Abu Dhabi, Sharjah and London;
   * because of London it rendered in waitlist mode, and a waitlist hub's
   * header button points at `#waitlist` — an anchor no hub has — while its
   * hero button pointed at the Dubai page's `#waitlist`, which does not exist
   * either, because Dubai is live and sells. So the one page a Dubai dentist
   * might land on first had a single button on it and that button did nothing.
   * The city cards say which places are open; the hub sells, because somebody
   * reading it can buy.
   */
  const sells = page.combos.some((c) => marketLive(c.city));
  const scenes = scenesFor(v, ctx);
  return (
    head({
      title: v.hub.title,
      description: v.hub.description,
      path: page.path,
      pathFor: (locale) => verticalHubPath(v.slug, MATRIX_FRAMING, locale.lang),
      jsonLd: hubJsonLd(page, v.hub.title, v.hub.description, hubFaqs(v)),
    }) +
    header(sells, [
      { href: indexPath(), label: "All locations" },
      { href: "#cities", label: "Cities" },
      { href: "#how", label: "How it works" },
    ]) +
    `
<main>

  <section class="hero">
    <div class="wrap hero-in">
      <div class="hero-copy">
        <p class="eyebrow rise">AI receptionist for ${esc(v.plural)}</p>
        <h1 class="display rise rise-1">${esc(v.hub.headline)}</h1>
        <p class="lead rise rise-2">${esc(v.hub.lead)}</p>
        <div class="cta-row rise rise-3">
          ${sells ? `<a class="btn" href="${APP}/checkout" data-cta="hero">Get started</a>` : `<a class="btn" href="${page.combos[0].path}#waitlist" data-cta="hero">Join the waitlist</a>`}
        </div>
        <p class="hero-note rise rise-4"><span class="hero-langs" data-langs>Answers in English.</span></p>
      </div>

${CALL_PANEL}
    </div>
  </section>

  <section id="cities" class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">By city</p>
          <h2 class="display">Where we have written it up.</h2>
        </div>
        <p class="sec-lead lead">
          Each page is about ${esc(v.singular)}'s phone in that city — the week
          it keeps, the languages on the line and the calls it loses.
        </p>
      </div>
      <div class="knows">
${comboCards(page, "city")}
      </div>
    </div>
  </section>

  <!--
    Pain points here, call types on the landing pages. The two used to be on
    both, which made a hub and the page below it substantially the same
    document — and a search engine reading a hundred pages of this system
    would see a hub whose only original content was a list of links.
  -->
  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Why the calls go missing</p>
          <h2 class="display">Nobody is ignoring the phone.</h2>
        </div>
        <p class="sec-lead lead">${esc(v.plural.charAt(0).toUpperCase() + v.plural.slice(1))} lose calls for reasons that have nothing to do with caring about them.</p>
      </div>
      <div class="knows">
${v.pains.map((p) => `        <div>\n          <h3>${esc(p.head)}</h3>\n          <p>${esc(p.body)}</p>\n        </div>`).join("\n")}
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="split">
        <div>
          <p class="eyebrow">Where it stops</p>
          <h2 class="display">Knowing what not to say is the hard part.</h2>
          <p style="margin-top:26px">${esc(v.boundary)}</p>
${v.tradePage ? `          <p class="fine"><a href="${v.tradePage}">More about Belline for ${esc(v.name.toLowerCase())}</a></p>` : ""}
        </div>
        <figure class="plate">
          <img src="${esc(v.image)}" width="880" height="495" loading="lazy" alt="${esc(v.imageAlt)}">
        </figure>
      </div>
    </div>
  </section>

${howItWorks(v, sells)}${faqSection(hubFaqs(v))}
</main>

` +
    footer(sells) +
    scripts(scenes)
  );
}

export function cityHubPage(page: HubPage, ctx: RenderContext): string {
  const c = page.city!;
  const live = marketLive(c);
  const scenes = page.combos[0] ? scenesFor(page.combos[0].vertical, ctx) : [];
  return (
    head({
      title: c.hub.title,
      description: c.hub.description,
      path: page.path,
      pathFor: (locale) => cityHubPath(c, locale.lang),
      jsonLd: hubJsonLd(page, c.hub.title, c.hub.description),
    }) +
    header(live, [
      { href: indexPath(), label: "All locations" },
      ...(ctx.pages.some((p) => p.kind === "country-hub" && p.market === c.market)
        ? [{ href: countryHubPath(c.market), label: MARKETS[c.market].name }]
        : []),
      { href: "#trades", label: "Trades" },
      // Not "#how": a city hub has no three-steps block. It pointed at an
      // anchor the page does not contain, which on a phone is a nav item that
      // closes the menu and does nothing.
      { href: live ? "#price" : "#waitlist", label: live ? "Pricing" : "Waitlist" },
    ]) +
    `
<main>

  <section class="hero">
    <div class="wrap hero-in">
      <div class="hero-copy">
        <p class="eyebrow rise">AI receptionist ${esc(inCity(c))}</p>
        <h1 class="display rise rise-1">${esc(c.hub.headline)}</h1>
        <p class="lead rise rise-2">${esc(c.hub.lead)}</p>
        <div class="cta-row rise rise-3">
          ${live ? `<a class="btn" href="${APP}/checkout" data-cta="hero">Get started</a>` : `<a class="btn" href="#waitlist" data-cta="hero">Join the waitlist</a>`}
        </div>
        <p class="hero-note rise rise-4"><span class="hero-langs" data-langs>Answers in English.</span></p>
      </div>

${CALL_PANEL}
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">${esc(c.name)}</p>
          <h2 class="display">What a phone line here is like.</h2>
        </div>
        <p class="sec-lead lead">${esc(c.intro)}</p>
      </div>

      <div class="terms terms-4">
        <div>
          <h4>Languages on the line</h4>
          <p>${esc(c.languages)}</p>
        </div>
        <div>
          <h4>The working week</h4>
          <p>${esc(c.week)}</p>
        </div>
        <div>
          <h4>When it rings</h4>
          <p>${esc(c.peak)}</p>
        </div>
        <div>
          <h4>How people get in touch</h4>
          <p>${esc(c.habits)}</p>
        </div>
      </div>
    </div>
  </section>

  <section id="trades" class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">By trade</p>
          <h2 class="display">Written up for ${esc(c.name)}.</h2>
        </div>
      </div>
      <div class="knows">
${comboCards(page, "vertical")}
      </div>
    </div>
  </section>

  <!--
    No channels strip and no three steps here.

    A city hub is an index: its job is to say what a phone line in this city is
    like and then send the reader to the trade page that is actually about
    them. Both of those blocks are the same words on every page of the site, so
    carrying them here made the hub two thirds boilerplate — check-seo's
    uniqueness floor caught it, which is what it is for. The trade pages below
    carry them, where they are read by somebody who has already arrived
    somewhere specific.
  -->
  <section class="rule">
    <div class="wrap">
      <div class="split">
        <div>
          <p class="eyebrow">Practicalities</p>
          <h2 class="display">Your number, your clock.</h2>
          <p style="margin-top:26px">
            Keep the ${esc(c.name)} number you already have — on your door, your
            listings and your receipts — and forward to Belline only the calls
            nobody picks up. New accounts here start on ${esc(clockName(c))}${
              c.clocksChange
                ? ", and the clocks move twice a year, so a forwarding rule set on the clock keeps doing the right thing through both halves of the year"
                : ", which does not change with the seasons, so an evening cut-off is the same hour all year"
            }.
          </p>
          <p class="fine">
            Wherever in ${esc(c.name)} you are, the setup is the same: one
            setting on the line you already have, and nothing printed on your
            door changes.
          </p>
        </div>
      </div>
    </div>
  </section>

${live ? pricing(c) : waitlist(c, null, page.path)}
</main>

` +
    footer(live) +
    scripts(scenes)
  );
}

export function indexPage(page: HubPage, ctx: RenderContext): string {
  const title = "AI receptionist by trade and city | Belline";
  const description =
    "Belline's AI receptionist, written up trade by trade and city by city: what each line actually answers, what it refuses, and where we are open.";
  const verticals = [...new Map(page.combos.map((c) => [c.vertical.slug, c.vertical])).values()];
  const cities = [...new Map(page.combos.map((c) => [c.city.slug, c.city])).values()];
  const live = page.combos.some((c) => marketLive(c.city));
  const countryHubs = ctx.pages.filter((p): p is HubPage => p.kind === "country-hub");
  const channels = ctx.pages.filter((p): p is ChannelHubPage => p.kind === "channel-hub");

  const rows = verticals
    .map(
      (v) => `        <div>
          <h3><a href="${verticalHubPath(v.slug)}">${esc(v.name)}</a></h3>
          <p>${page.combos
            .filter((c) => c.vertical.slug === v.slug)
            .map((c) => `<a href="${c.path}">${esc(c.city.name)}</a>`)
            .join(" · ")}</p>
        </div>`,
    )
    .join("\n");

  return (
    head({
      title,
      description,
      path: page.path,
      pathFor: (locale) => indexPath(locale.lang),
      jsonLd: hubJsonLd(page, title, description),
    }) +
    header(live, [
      { href: "/", label: "Belline" },
      { href: "/#how", label: "How it works" },
      { href: "/#price", label: "Pricing" },
    ]) +
    `
<main>

  <section class="hero">
    <div class="wrap hero-in">
      <div class="hero-copy">
        <p class="eyebrow rise">By trade and city</p>
        <h1 class="display rise rise-1">An AI receptionist, written up for the line you actually run.</h1>
        <p class="lead rise rise-2">
          A dental practice's phone is not a restaurant's, and a Sharjah week is
          not a Dubai one. These pages are written one at a time rather than
          generated, so each says something true about that trade in that city.
          Belline is live in the United Arab Emirates; pages for cities we are
          not open in say so and sell nothing.
        </p>
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Trades</p>
          <h2 class="display">Pick the line you run.</h2>
        </div>
      </div>
      <div class="knows">
${rows}
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Cities</p>
          <h2 class="display">And where you run it.</h2>
        </div>
      </div>
      <ul class="kinds">
${countryHubs.map((p) => `        <li><a href="${p.path}">${esc(MARKETS[p.market!].name)} — everywhere we are open</a></li>`).join("\n")}
${cities.map((c) => `        <li><a href="${cityHubPath(c)}">${esc(c.name)}${marketLive(c) ? "" : " — not open yet"}</a></li>`).join("\n")}
      </ul>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">The same receptionist, a different way in</p>
          <h2 class="display">Not everybody calls it an AI receptionist.</h2>
        </div>
        <p class="sec-lead lead">
          Some businesses come looking for call answering, and a great many in
          the UAE come looking for WhatsApp. It is one product either way, and
          these pages are about the channel rather than the trade.
        </p>
      </div>
      <ul class="kinds">
${channels.map((p) => `        <li><a href="${p.path}">${esc(p.copy.headline)}</a></li>`).join("\n")}
      </ul>
    </div>
  </section>

</main>

` +
    footer(live) +
    scripts([])
  );
}

/**
 * The country hub: `/ai-receptionist/in/ae`.
 *
 * Built only where a country has more than one published city and somebody has
 * written country copy for it (scripts/seo/cities.ts). Its job is the thing
 * neither a city page nor a trade page can do: say what is true across the
 * whole market — the week, the messaging habit, the language limit, the
 * currency — and then get out of the way and send the reader one level down.
 */
export function countryHubPage(page: HubPage, ctx: RenderContext): string {
  const market = page.market!;
  const country = seoCountry(market)!;
  const live = MARKETS[market].status === "live";
  const cities = [...new Map(page.combos.map((c) => [c.city.slug, c.city])).values()];
  const verticals = [...new Map(page.combos.map((c) => [c.vertical.slug, c.vertical])).values()];
  const scenes = page.combos[0] ? scenesFor(page.combos[0].vertical, ctx) : [];

  return (
    head({
      title: country.title,
      description: country.description,
      path: page.path,
      pathFor: (locale) => countryHubPath(market, locale.lang),
      jsonLd: hubJsonLd(page, country.title, country.description),
    }) +
    header(live, [
      { href: indexPath(), label: "All locations" },
      { href: "#cities", label: "Emirates" },
      { href: "#trades", label: "Trades" },
      { href: live ? "#price" : "#waitlist", label: live ? "Pricing" : "Waitlist" },
    ]) +
    `
<main>

  <section class="hero">
    <div class="wrap hero-in">
      <div class="hero-copy">
        <p class="eyebrow rise">AI receptionist in ${esc(MARKETS[market].name)}</p>
        <h1 class="display rise rise-1">${esc(country.headline)}</h1>
        <p class="lead rise rise-2">${esc(country.lead)}</p>
        <div class="cta-row rise rise-3">
          ${live ? `<a class="btn" href="${APP}/checkout" data-cta="hero">Get started</a>` : `<a class="btn" href="#waitlist" data-cta="hero">Join the waitlist</a>`}
        </div>
        <p class="hero-note rise rise-4"><span class="hero-langs" data-langs>Answers in English.</span></p>
      </div>

${CALL_PANEL}
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">${esc(MARKETS[market].name)}</p>
          <h2 class="display">What a business line here has to cope with.</h2>
        </div>
        <p class="sec-lead lead">${esc(country.intro)}</p>
      </div>

      <div class="terms terms-4">
${country.facts.map((f) => `        <div>\n          <h4>${esc(f.head)}</h4>\n          <p>${esc(f.body)}</p>\n        </div>`).join("\n")}
      </div>
    </div>
  </section>

  <section id="cities" class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">By emirate</p>
          <h2 class="display">Two working weeks, three sets of habits.</h2>
        </div>
      </div>
      <div class="knows">
${cities
  .map(
    (c) => `        <div>
          <h3><a href="${cityHubPath(c)}">${esc(c.name)}</a></h3>
          <p>${esc(`${c.week.split(".")[0]}.`)}</p>
        </div>`,
  )
  .join("\n")}
      </div>
    </div>
  </section>

  <section id="trades" class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">By trade</p>
          <h2 class="display">And what your own line is asked.</h2>
        </div>
      </div>
      <div class="knows">
${verticals
  .map(
    (v) => `        <div>
          <h3><a href="${verticalHubPath(v.slug)}">${esc(v.name)}</a></h3>
          <p>${page.combos
            .filter((c) => c.vertical.slug === v.slug)
            .map((c) => `<a href="${c.path}">${esc(c.city.name)}</a>`)
            .join(" · ")}</p>
        </div>`,
  )
  .join("\n")}
      </div>
    </div>
  </section>

${live ? pricing(cities[0]) : ""}
</main>

` +
    footer(live) +
    scripts(scenes)
  );
}

// --- the framing pages ---------------------------------------------------------

/**
 * `/whatsapp-chatbot` and `/call-answering`.
 *
 * The two framings that are not the matrix, each a single page with its own
 * substance rather than a rewrite of the home page with a word swapped. Both
 * are UAE pages: `marketLive` has nothing to read here because there is no
 * city, so they sell on the same basis the home page does, which is that the
 * UAE is open and the checkout refuses everywhere else.
 */
export function channelHubPage(page: ChannelHubPage, ctx: RenderContext): string {
  const { copy } = page;
  const uae = seoCity("dubai");
  const scenes = scenesFor(seoVerticalWithScenes(ctx), ctx);
  const links = page.trades.length
    ? `  <section id="trades" class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">By trade</p>
          <h2 class="display">Written up for the line you run.</h2>
        </div>
        <p class="sec-lead lead">What a ${esc(page.framing.name.toLowerCase())} is actually asked differs by trade more than it differs by city, so these pages are written by trade.</p>
      </div>
      <ul class="kinds">
${page.trades.map((t) => `        <li><a href="${t.path}">${esc(page.framing.name)} for ${esc(t.vertical.plural)}</a></li>`).join("\n")}
      </ul>
    </div>
  </section>
`
    : // A framing with no trade pages of its own still has to lead somewhere.
      // /call-answering used to take seventeen inbound links and pass on one,
      // which makes it the end of the crawl and a dead end for a reader who
      // has just decided they want this.
      `  <section id="trades" class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">By trade</p>
          <h2 class="display">What it answers depends on what you do.</h2>
        </div>
        <p class="sec-lead lead">The rules, the questions and the calls that have to reach a person are different in every trade, so the substance is written up trade by trade.</p>
      </div>
      <ul class="kinds">
${ctx.pages
  .filter((p): p is HubPage => p.kind === "vertical-hub")
  .map((p) => `        <li><a href="${p.path}">AI receptionist for ${esc(p.vertical!.plural)}</a></li>`)
  .join("\n")}
      </ul>
    </div>
  </section>
`;

  return (
    head({
      title: copy.title,
      description: copy.description,
      path: page.path,
      pathFor: (locale) => framingPath(page.framing.slug, locale.lang),
      jsonLd: channelJsonLd(page.path, copy.title, copy.description, copy.faqs),
    }) +
    header(true, [
      { href: indexPath(), label: "By trade and city" },
      ...(page.trades.length ? [{ href: "#trades", label: "Trades" }] : []),
      { href: "#faq", label: "Questions" },
      { href: "#price", label: "Pricing" },
    ]) +
    `
<main>

  <section class="hero">
    <div class="wrap hero-in">
      <div class="hero-copy">
        <p class="eyebrow rise">${esc(page.framing.name)}</p>
        <h1 class="display rise rise-1">${esc(copy.headline)}</h1>
        <p class="lead rise rise-2">${esc(copy.lead)}</p>
        <div class="cta-row rise rise-3">
          <a class="btn" href="${APP}/checkout" data-cta="hero">Get started</a>
        </div>
        <p class="hero-note rise rise-4">
          <span class="gen" data-gen="hero-reassure">${TRIAL.days} days free · No card required · Plans from ${formatMoney(
            Math.min(...sellable("AE").map((p) => priceOf(p.id, "AE"))),
            "AE",
          )}/month</span>
          <span class="hero-note-more"><span class="hero-langs" data-langs>Answers in English.</span></span>
        </p>
      </div>

${CALL_PANEL}
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">What this actually is</p>
          <h2 class="display">${esc(page.framing.name)}, and what it is not.</h2>
        </div>
        <p class="sec-lead lead">${esc(copy.intro)}</p>
      </div>

      <div class="knows">
${copy.sections.map((s) => `        <div>\n          <h3>${esc(s.head)}</h3>\n          <p>${esc(s.body)}</p>\n        </div>`).join("\n")}
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="split">
        <div>
          <p class="eyebrow">Where it stops</p>
          <h2 class="display">The line it does not cross.</h2>
          <p style="margin-top:26px">${esc(copy.boundary)}</p>
        </div>
        <figure class="plate">
          <img src="/img/bell.jpg" width="880" height="495" loading="lazy" alt="A brass bell on a long reception counter in an empty lobby.">
        </figure>
      </div>
    </div>
  </section>

${links}${faqSection(copy.faqs)}${pricing(uae)}
</main>

` +
    footer(true) +
    scripts(scenes)
  );
}

/** `/whatsapp-chatbot/<trade>`. */
export function channelTradePage(page: ChannelTradePage, ctx: RenderContext): string {
  const { copy, vertical } = page;
  const uae = seoCity("dubai");
  const scenes = scenesFor(vertical, ctx);
  const hub = ctx.pages.find((p): p is ChannelHubPage => p.kind === "channel-hub" && p.framing.slug === page.framing.slug);
  const siblings = ctx.pages.filter(
    (p): p is ChannelTradePage => p.kind === "channel-trade" && p.framing.slug === page.framing.slug && p.vertical.slug !== vertical.slug,
  );
  const cities = ctx.pages.filter((p): p is ComboPage => p.kind === "combo" && p.vertical.slug === vertical.slug && marketLive(p.city));

  return (
    head({
      title: copy.title,
      description: copy.description,
      path: page.path,
      pathFor: (locale) => verticalHubPath(vertical.slug, page.framing.slug, locale.lang),
      jsonLd: channelJsonLd(
        page.path,
        copy.title,
        copy.description,
        copy.faqs,
        vertical.plural,
        hub ? { path: hub.path, name: hub.copy.title.split(" | ")[0].split(" — ")[0] } : undefined,
      ),
    }) +
    header(true, [
      ...(hub ? [{ href: hub.path, label: page.framing.name }] : []),
      { href: verticalHubPath(vertical.slug), label: vertical.name },
      { href: "#faq", label: "Questions" },
      { href: "#price", label: "Pricing" },
    ]) +
    `
<main>

  <section class="hero">
    <div class="wrap hero-in hero-demo${VIDEO ? " has-video-hero" : ""}">
      <div class="hero-copy">
        <p class="eyebrow rise">${esc(page.framing.name)} · ${esc(vertical.name)}</p>
        <h1 class="display rise rise-1">${esc(copy.headline)}</h1>
        <p class="lead rise rise-2">${esc(copy.lead)}</p>

        <ul class="hero-can rise rise-2" aria-label="What Belline does for you">
          <li>Answers questions</li>
          <li>Captures enquiries</li>
          <li>Takes booking requests</li>
        </ul>

        <div class="cta-row rise rise-3">
          <a class="btn" href="${APP}/checkout" data-cta="hero">Get started</a>
        </div>

        <p class="hero-note rise rise-4">
          <span class="gen" data-gen="hero-reassure">${TRIAL.days} days free · No card required · Plans from ${formatMoney(
            Math.min(...sellable("AE").map((p) => priceOf(p.id, "AE"))),
            "AE",
          )}/month</span>
          <span class="hero-note-more"><span class="hero-langs" data-langs>Answers in English.</span></span>
        </p>
      </div>

${HERO_VIDEO}
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">On WhatsApp, specifically</p>
          <h2 class="display">What ${esc(vertical.singular)} is asked in writing.</h2>
        </div>
        <p class="sec-lead lead">A message is not a quieter phone call. It is answered differently, it is kept, and it can be screenshotted — which changes what is safe to say.</p>
      </div>

      <div class="knows">
${copy.local.map((l) => `        <div>\n          <h3>${esc(l.head)}</h3>\n          <p>${esc(l.body)}</p>\n        </div>`).join("\n")}
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">What comes down the line</p>
          <h2 class="display">Every enquiry ${esc(vertical.singular)} gets, and what happens to it.</h2>
        </div>
        <p class="sec-lead lead">Belline takes requests. Your team confirms them. Nothing enters your diary without a person putting it there.</p>
      </div>

      <div class="knows">
${vertical.callTypes.map((p) => `        <div>\n          <h3>${esc(p.head)}</h3>\n          <p>${esc(p.body)}</p>\n        </div>`).join("\n")}
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="split">
        <div>
          <p class="eyebrow">Where it stops</p>
          <h2 class="display">The most important thing it does is know what it must not answer.</h2>
          <p style="margin-top:26px">${esc(vertical.boundary)}</p>
        </div>
        <figure class="plate">
          <img src="${esc(vertical.image)}" width="880" height="495" loading="lazy" alt="${esc(vertical.imageAlt)}">
        </figure>
      </div>
    </div>
  </section>

${faqSection(copy.faqs)}${pricing(uae)}  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Nearby</p>
          <h2 class="display">Somewhere else, or something else.</h2>
        </div>
      </div>
      <div class="knows">
        <div>
          <h3>The phone, city by city</h3>
          <ul class="kinds">
${cities.map((c) => `            <li><a href="${c.path}">${esc(vertical.name)} ${esc(inCity(c.city))}</a></li>`).join("\n")}
          </ul>
        </div>
${
  siblings.length
    ? `        <div>
          <h3>WhatsApp for other trades</h3>
          <ul class="kinds">
${siblings.map((s) => `            <li><a href="${s.path}">${esc(s.vertical.name)}</a></li>`).join("\n")}
          </ul>
        </div>`
    : ""
}
        <div>
          <h3>Start somewhere wider</h3>
          <ul class="kinds">
${hub ? `            <li><a href="${hub.path}">${esc(page.framing.name)} for UAE businesses</a></li>` : ""}
            <li><a href="${verticalHubPath(vertical.slug)}">AI receptionist for ${esc(vertical.plural)}</a></li>
            <li><a href="${indexPath()}">Every trade and city</a></li>
          </ul>
        </div>
      </div>
    </div>
  </section>

</main>

` +
    footer(true) +
    scripts(scenes)
  );
}

/**
 * A framing page's structured data: what it is, and the FAQ that is on it.
 *
 * `parent` is the framing's own hub, so a trade page's breadcrumb is the path
 * a reader would actually have walked. Without it the three page types in this
 * system had three different breadcrumb conventions, which is the sort of
 * thing nobody notices until a rich result shows the wrong trail.
 */
function channelJsonLd(
  path: string,
  title: string,
  description: string,
  faqs: SeoFaq[],
  audience?: string,
  parent?: { path: string; name: string },
): string {
  const url = `${ORIGIN}${path}`;
  return json({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Service",
        name: title.split(" | ")[0],
        serviceType: "AI receptionist",
        url,
        description,
        provider: { "@type": "Organization", name: "Belline", url: `${ORIGIN}/` },
        areaServed: { "@type": "Country", name: MARKETS.AE.name },
        ...(audience ? { audience: { "@type": "BusinessAudience", name: audience } } : {}),
        availableChannel: { "@type": "ServiceChannel", serviceUrl: `${APP}/checkout` },
      },
      {
        "@type": "SoftwareApplication",
        name: "Belline",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: `${ORIGIN}/`,
        offers: sellable("AE").map((p) => ({
          "@type": "Offer",
          name: `Belline ${p.name}`,
          price: String(priceOf(p.id, "AE") / 100),
          priceCurrency: MARKETS.AE.currency,
          url: `${APP}/checkout`,
          availability: "https://schema.org/InStock",
        })),
      },
      {
        "@type": "FAQPage",
        mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Belline", item: `${ORIGIN}/` },
          ...(parent ? [{ "@type": "ListItem", position: 2, name: parent.name, item: `${ORIGIN}${parent.path}` }] : []),
          { "@type": "ListItem", position: parent ? 3 : 2, name: title.split(" | ")[0], item: url },
        ],
      },
    ],
  });
}

/** Any published trade that has a recorded demo call, for a page with no trade of its own. */
function seoVerticalWithScenes(ctx: RenderContext): SeoVertical {
  const combo = ctx.pages.find((p): p is ComboPage => p.kind === "combo" && Boolean(p.vertical.tradePage));
  return combo ? combo.vertical : seoVertical("restaurants");
}

/** One page, whichever shape it is. */
export function renderSeoPage(page: SeoPage, ctx: RenderContext): string {
  if (page.kind === "combo") return comboPage(page, ctx);
  if (page.kind === "channel-hub") return channelHubPage(page, ctx);
  if (page.kind === "channel-trade") return channelTradePage(page, ctx);
  if (page.kind === "vertical-hub") return verticalHubPage(page, ctx);
  if (page.kind === "country-hub") return countryHubPage(page, ctx);
  if (page.kind === "city-hub") return cityHubPage(page, ctx);
  return indexPage(page, ctx);
}
