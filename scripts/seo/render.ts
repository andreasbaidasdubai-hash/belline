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
import { priceOf, sellable } from "../../src/lib/billing/plans";
import { BADGE, BELL_FAB, CALL_PANEL, DEMO_NUMBER, DEMO_NUMBER_SPOKEN, HERO_VIDEO, MARK, MENU_TOGGLE, esc } from "../site-chrome";
import { inCity, type SeoCity } from "./cities";
import type { SeoFaq, SeoVertical } from "./verticals";
import type { PairCopy } from "./pairs";
import {
  ORIGIN,
  cityHubPath,
  comboPath,
  indexPath,
  marketGap,
  marketLive,
  marketName,
  seoAlternates,
  verticalHubPath,
  type ComboPage,
  type HubPage,
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
  /** Rendered with the locale's own prefix, for hreflang. */
  pathFor: (prefix: string) => string;
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
<body>
`;
}

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
  `Free, in your browser, 24 hours a day. Or ring <a href="tel:${DEMO_NUMBER}">${DEMO_NUMBER_SPOKEN}</a> — that is a United States number, so it is an international call from ${esc(city.name)} and your usual charges apply. Calls last up to ten minutes, and the line takes a limited number of calls each day.`;

/** How it works. The home page's three steps, in the trade's own words. */
function howItWorks(vertical: SeoVertical, live: boolean): string {
  return `  <section id="how" class="rule">
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
  return `  <section id="channels" class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Every channel</p>
          <h2 class="display">One receptionist, three ways in.</h2>
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
  return `  <section class="rule">
    <div class="wrap">
      <div class="split" data-case-study="pending">
        <div>
          <p class="eyebrow">Customer stories</p>
          <h2 class="display">There is no testimonial here yet.</h2>
          <p style="margin-top:26px">
            When ${esc(vertical.singular)} ${esc(inCity(city))} agrees to be named, its story goes in this space:
            what it was losing, what it changed, and what its own team says about it.
            Until then this space stays empty on purpose. We are not going to write
            a quotation nobody said, or count customers we do not have.
          </p>
          <p class="fine">
            Running ${esc(vertical.singular)} ${esc(inCity(city))} and willing to talk about it?
            <a href="mailto:hello@belline.ai">Write to us</a> and a person answers.
          </p>
        </div>
        <figure class="plate">
          <img src="${esc(vertical.image)}" width="880" height="495" loading="lazy" alt="${esc(vertical.imageAlt)}">
        </figure>
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
  return `  <section id="price" class="rule">
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

  return `  <section id="book" class="rule closer">
    <div class="wrap closer-in">
      <div>
        <p class="eyebrow">Not open here yet</p>
        <h2 class="display">Be first when we open ${esc(inCity(city))}.</h2>
        <p class="lead">
          Belline is live in the United Arab Emirates and nowhere else. There is
          nothing to buy on this page and no price to quote you in ${esc(MARKETS[city.market].currency)}.
          Leave your details and we will write when we open in ${esc(marketName(city))}.
          ${esc(marketGap(city))}
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
  return `  <section class="rule closer">
    <div class="wrap">
      <p class="eyebrow">Hear it now</p>
      <h2 class="display">Be the caller.</h2>
      <p class="lead" style="margin-top:26px; max-width:50ch">
        The same receptionist your callers in ${esc(city.name)} would reach. Ask it
        something hard, then ask for a person.
      </p>

      <div class="cta-row" style="margin-top:34px">
        <a class="btn" href="${APP}/call?start=1" data-call>
          ${MARK}
          Speak to Belline
        </a>
        <a class="btn line" href="${APP}/checkout" data-cta="closer">Get started</a>
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
  if (sameVertical.length) {
    blocks.push(`      <div>
        <h3>${esc(page.vertical.name)} in other cities</h3>
        <ul class="kinds">
${list(sameVertical.map((p) => ({ href: p.path, label: p.city.name })))}
        </ul>
      </div>`);
  }
  if (sameCity.length) {
    blocks.push(`      <div>
        <h3>Other trades in ${esc(page.city.name)}</h3>
        <ul class="kinds">
${list(sameCity.map((p) => ({ href: p.path, label: p.vertical.name })))}
        </ul>
      </div>`);
  }
  blocks.push(`      <div>
        <h3>Start somewhere wider</h3>
        <ul class="kinds">
          <li><a href="${verticalHubPath(page.vertical.slug)}">AI receptionist for ${esc(page.vertical.plural)}</a></li>
          <li><a href="${cityHubPath(page.city.slug)}">AI receptionist ${esc(inCity(page.city))}</a></li>
          <li><a href="${indexPath()}">Every trade and city</a></li>
${page.vertical.tradePage ? `          <li><a href="${page.vertical.tradePage}">Belline for ${esc(page.vertical.name.toLowerCase())}</a></li>` : ""}
        </ul>
      </div>`);

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
      name: "Belline",
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/brand/png/belline-mark-512.png`,
      email: "hello@belline.ai",
      telephone: DEMO_NUMBER_SPOKEN.replace(/ /g, "-"),
      areaServed: "AE",
    },
    {
      "@type": "Service",
      name,
      serviceType: "AI receptionist",
      url,
      description: page.pair.description,
      provider: { "@type": "Organization", name: "Belline", url: `${ORIGIN}/` },
      areaServed: { "@type": "City", name: city.name, containedInPlace: { "@type": "Country", name: MARKETS[city.market].name } },
      audience: { "@type": "BusinessAudience", name: vertical.plural },
      // `available` on a live market, `PreOrder`-free on one we are not open
      // in: no availability statement at all rather than a hopeful one.
      ...(live ? { areaServed: { "@type": "City", name: city.name }, availableChannel: { "@type": "ServiceChannel", serviceUrl: `${APP}/checkout` } } : {}),
    },
    {
      "@type": "SoftwareApplication",
      name: "Belline",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: `${ORIGIN}/`,
      ...(live
        ? {
            offers: sellable(city.market).map((p) => ({
              "@type": "Offer",
              name: `Belline ${p.name}`,
              price: String(priceOf(p.id, city.market) / 100),
              priceCurrency: MARKETS[city.market].currency,
              billingIncrement: "P1M",
            })),
          }
        : {}),
    },
    {
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "AI receptionist", item: `${ORIGIN}${indexPath()}` },
        { "@type": "ListItem", position: 2, name: vertical.name, item: `${ORIGIN}${verticalHubPath(vertical.slug)}` },
        { "@type": "ListItem", position: 3, name: city.name, item: url },
      ],
    },
  ];
  return json({ "@context": "https://schema.org", "@graph": graph });
}

function hubJsonLd(page: HubPage, title: string, description: string): string {
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
 * trade's remaining questions live on the trade hub (`hubFaqs`), so no answer
 * is published twice inside this system.
 */
export function faqsFor(vertical: SeoVertical, pair: PairCopy): SeoFaq[] {
  return [...pair.faqs.slice(0, 4), ...vertical.faqs.slice(0, 4)].slice(0, 8);
}

/** The trade's questions that the landing pages do not take. */
export const hubFaqs = (vertical: SeoVertical): SeoFaq[] => vertical.faqs.slice(4);

export function comboPage(page: ComboPage, ctx: RenderContext): string {
  const { vertical, city, pair } = page;
  const live = marketLive(city);
  const title = `AI receptionist for ${vertical.plural} ${inCity(city)} | Belline`;
  const h1 = `AI receptionist for ${vertical.plural} ${inCity(city)}`;
  const faqs = faqsFor(vertical, pair);
  const scenes = scenesFor(vertical, ctx);

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
          Belline is live in the United Arab Emirates and is <strong>not open in ${esc(marketName(city))}</strong> yet.
          Nothing on this page can be bought.
          <span class="hero-note-more"><span class="hero-langs" data-langs>Answers in English.</span></span>
        </p>`;

  return (
    head({
      title,
      description: pair.description,
      path: page.path,
      pathFor: (prefix) => `${prefix}/${vertical.slug}/${city.slug}`,
      jsonLd: comboJsonLd(page, faqs),
    }) +
    header(live, [
      { href: verticalHubPath(vertical.slug), label: vertical.name },
      { href: cityHubPath(city.slug), label: city.name },
      { href: "#how", label: "How it works" },
      { href: live ? "#price" : "#waitlist", label: live ? "Pricing" : "Waitlist" },
    ]) +
    `
<main>

  <section class="hero">
    <div class="wrap hero-in hero-demo">
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

${channels(city)}${howItWorks(vertical, live)}${live ? pricing(city) : ""}${caseStudySlot(vertical, city)}${faqSection(faqs)}${internalLinks(page, ctx)}${live ? closer(city, vertical) : waitlist(city, vertical, page.path)}
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
  // A hub is buyable when any city on it is. Every hub in the first pass is
  // either all-live or all-not, and where a hub mixes the two the cards say
  // which is which and the hub itself sells nothing.
  const allLive = page.combos.every((c) => marketLive(c.city));
  const scenes = scenesFor(v, ctx);
  return (
    head({
      title: v.hub.title,
      description: v.hub.description,
      path: page.path,
      pathFor: (prefix) => `${prefix}/${v.slug}`,
      jsonLd: hubJsonLd(page, v.hub.title, v.hub.description),
    }) +
    header(allLive, [
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
          ${allLive ? `<a class="btn" href="${APP}/checkout" data-cta="hero">Get started</a>` : `<a class="btn" href="${page.combos[0].path}#waitlist" data-cta="hero">Join the waitlist</a>`}
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

${howItWorks(v, allLive)}${faqSection(hubFaqs(v))}
</main>

` +
    footer(allLive) +
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
      pathFor: (prefix) => `${prefix}/in/${c.slug}`,
      jsonLd: hubJsonLd(page, c.hub.title, c.hub.description),
    }) +
    header(live, [
      { href: indexPath(), label: "All locations" },
      { href: "#trades", label: "Trades" },
      { href: live ? "#how" : "#waitlist", label: live ? "How it works" : "Waitlist" },
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
            nobody picks up. New accounts here start on ${esc(c.timezone.replace("_", " "))} time${
              c.clocksChange
                ? ", and the clocks move twice a year, so a forwarding rule set on the clock keeps doing the right thing through both halves of the year"
                : ", which does not change with the seasons, so an evening cut-off is the same hour all year"
            }.
          </p>
          <p class="fine">
            Common enough here to be worth saying: we hear from businesses in
            ${esc(c.districts.slice(0, -1).join(", "))} and ${esc(c.districts[c.districts.length - 1])} alike, and none of that
            changes the setup — it is one setting on the line you already have.
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
  const title = "AI receptionist by trade and city — Belline";
  const description =
    "Belline's AI receptionist, written up trade by trade and city by city: what each line actually answers, what it refuses, and where we are open.";
  const verticals = [...new Map(page.combos.map((c) => [c.vertical.slug, c.vertical])).values()];
  const cities = [...new Map(page.combos.map((c) => [c.city.slug, c.city])).values()];
  const live = page.combos.some((c) => marketLive(c.city));

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
      pathFor: (prefix) => prefix,
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
${cities.map((c) => `        <li><a href="${cityHubPath(c.slug)}">${esc(c.name)}${marketLive(c) ? "" : " — not open yet"}</a></li>`).join("\n")}
      </ul>
    </div>
  </section>

</main>

` +
    footer(live) +
    scripts([])
  );
}

/** One page, whichever shape it is. */
export function renderSeoPage(page: SeoPage, ctx: RenderContext): string {
  if (page.kind === "combo") return comboPage(page, ctx);
  if (page.kind === "vertical-hub") return verticalHubPage(page, ctx);
  if (page.kind === "city-hub") return cityHubPage(page, ctx);
  return indexPage(page, ctx);
}
