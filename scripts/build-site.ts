/**
 * Build the public website as a standalone static site.
 *
 * The marketing pages live in `public/` so the app serves them during
 * development, but in production they belong on their own domain — the
 * landing page should be at `yourdomain.com`, not at
 * `app.yourdomain.com/landing.html`. This copies them into `site/` with the
 * landing page as `index.html`, ready to drag onto any static host.
 *
 *   npm run site
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VERTICALS, type Vertical } from "./site-content";
import { applyPricing, trialSentence } from "./site-pricing";
import { applyIntegrations } from "./site-integrations";
import { applySiteFlags } from "../src/lib/site-flags";
import {
  LEGAL_PAGES,
  applyAlternates,
  legalAlternates,
  localiseEnglishLanding,
  renderGermanLanding,
  renderGermanLegal,
  type LegalPage,
} from "./site-locale";
import { GERMAN_PAGES } from "./site-pricing-de";
import { TRIAL } from "../src/lib/billing/plans";
import { flag } from "../src/lib/flags";
import { describeIdentityGaps, legalIdentity } from "../src/lib/legal/identity";
import {
  OUTREACH_PRIVACY_SOURCE,
  OUTREACH_PRIVACY_SOURCE_DE,
  describePlaceholders,
  noticeReadiness,
  outreachPrivacyUrl,
} from "../src/lib/legal/outreach-privacy";
import { SENDING_DOMAINS, senderPageFile } from "../src/lib/sales/sending/domains";
import { UNSUBSCRIBE_PATH } from "../src/lib/sales/sending/unsubscribe";
import { senderPage } from "./site-sender";
import { BADGE, BELL_FAB, CALL_PANEL, MARK, esc } from "./site-chrome";
import { marketLive, missingPairCopy, seoPages, seoSitemapEntries, verticalHubPath } from "./seo/matrix";
import { SEO_VERTICALS } from "./seo/verticals";
import { renderSeoPage } from "./seo/render";
import { SEO_REDIRECTS } from "../src/lib/seo-redirects";
import { renderLlmsTxt, verticalJsonLd } from "./site-llms";

/**
 * Are the German pages part of this build? `SITE_GERMAN=off` leaves them out.
 *
 * Not a product flag: `language.de` says whether Belline answers in German,
 * which is a different question from whether we publish a German page. A
 * German page published in Germany owes its reader an Impressum naming a real
 * company (§5 DDG), and there is no company to name yet — so production builds
 * with `SITE_GERMAN=off` and the pages simply do not exist. Leaving them up
 * unlinked is not good enough; a URL that answers is published.
 *
 * The picker, the hreflang alternates and the links follow, so a build never
 * offers a page it did not write (scripts/site-locale.ts `publishedCountries`).
 */
const GERMAN = (process.env.SITE_GERMAN ?? "on").toLowerCase() !== "off";

const SOURCE = "public";
/**
 * Where the build goes: `site/`, unless SITE_OUT names a folder. check-webchat
 * builds the landing page twice, flag off and flag on, into throwaway folders
 * that way, without touching the real site/.
 */
const OUT = process.env.SITE_OUT || "site";
const ORIGIN = "https://belline.ai";

/** The landing page becomes the site root; everything else keeps its name. */
const RENAME: Record<string, string> = { "landing.html": "index.html" };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// css, js and mp3 belong here as much as the images do: the pages link
// /site.css, /site.js and the demo call's audio, and leaving any of them out
// ships a site that is unstyled, inert or silent while the build reports
// success. This filter has quietly broken the site twice; add to it whenever
// a page starts referencing a new kind of file.
const ASSET = /\.(css|js|json|txt|xml|mp3|svg|png|jpg|jpeg|webp|ico|woff2?)$/i;

/**
 * Every asset under `public/`, as a path relative to it.
 *
 * Recursive on purpose: photography lives in `public/img/`, and a flat
 * readdir would skip the whole folder without erroring — the site would
 * deploy, and every image on it would be broken.
 */
function assetsUnder(dir: string, prefix = ""): string[] {
  return fs.readdirSync(path.join(SOURCE, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) return assetsUnder(path.join(dir, entry.name), rel);
    return ASSET.test(entry.name) ? [rel] : [];
  });
}

/**
 * Only these become public pages.
 *
 * It used to be every `.html` under `public/`, which is how the market study,
 * the 90-day plan and the go-live runbook were served on belline.ai for
 * anybody who guessed the filename. Those now live in docs/site/. A page has
 * to be named here to ship — a new one that is not is a build error, not a
 * leak.
 */
const PAGES = [
  "landing.html",
  "404.html",
  "privacy.html",
  "terms.html",
  OUTREACH_PRIVACY_SOURCE,
  "landing.de.html",
  "privacy.de.html",
  "terms.de.html",
  OUTREACH_PRIVACY_SOURCE_DE,
];

/**
 * German sources: never published under their own names. Each is rendered
 * once per DACH country, into /de-de, /de-at and /de-ch, by
 * scripts/site-locale.ts (see the end of the page loop).
 */
const GERMAN_SOURCES: Record<string, "landing" | LegalPage> = {
  "landing.de.html": "landing",
  "privacy.de.html": "privacy.html",
  "terms.de.html": "terms.html",
  [OUTREACH_PRIVACY_SOURCE_DE]: "outreach-privacy.html",
};

/**
 * Who the legal pages name.
 *
 * The block itself moved to `src/lib/legal/identity.ts`, because the outreach
 * engine needs the same names: German commercial email has to state the
 * sending entity, its address and who represents it, and a second copy of
 * those strings would be a second copy to forget to fill in. Edit it there;
 * this build and every cold email read the one block.
 *
 * Empty, the pages say "Belline" and give the email address, and the build
 * says so every time — loudly, because a privacy policy that does not name its
 * controller is a page that looks finished and is not.
 */
const LEGAL = legalIdentity();
if (!LEGAL.entity || !LEGAL.address || !LEGAL.law) {
  console.warn(
    "\n  ⚠  privacy.html and terms.html: company name, address or governing law not filled in (LEGAL in src/lib/legal/identity.ts).\n",
  );
}

/**
 * The trial sentence in the terms, from the catalogue.
 *
 * §2 states how long the trial runs, so a change to `TRIAL` has to reach the
 * terms as surely as it reaches the pricing page. Throws rather than ship a
 * terms page whose trial has quietly drifted from what we are selling.
 */
function fillTrial(html: string): string {
  const slot = /(<p class="gen" data-gen="trial-sentence">)[^<]*(<\/p>)/;
  if (!slot.test(html)) throw new Error("terms.html has lost its generated trial sentence.");
  return html.replace(slot, (_m, open: string, close: string) => `${open}${trialSentence()}${close}`);
}

function fillLegal(html: string, lang: "en" | "de" = "en"): string {
  const put = (key: string, value: string) =>
    value
      ? html.replace(new RegExp(`<span data-legal="${key}">[^<]*</span>`, "g"), `<span data-legal="${key}">${value}</span>`)
      : html;
  html = put("entity", LEGAL.entity);
  // The address completes a sentence ("reachable at …" / "erreichbar unter …")
  // only while it is empty; filled, it is the address itself in either language.
  html = put("address", LEGAL.address);
  html = put("law", lang === "de" ? LEGAL.lawDe : LEGAL.law);
  // Only the outreach notice carries these two. It names the controller under
  // Art. 13/14 to a reader who never agreed to hear from us, and "Belline,
  // somewhere" is not a controller.
  html = put("director", LEGAL.managingDirector);
  html = put("registration", LEGAL.registration);
  return html;
}

/**
 * Whether the outreach privacy notice may be published at all.
 *
 * Two failures, treated differently, because they are different kinds of
 * thing (src/lib/legal/outreach-privacy.ts):
 *
 *  - **Invented details** — the build stops. A notice under Art. 13/14 naming
 *    "Example Ltd, 123 Main Street" is not an unfinished page, it is a false
 *    statement served from our own domain to somebody we wrote to uninvited.
 *    There is no build in which shipping that is better than failing.
 *
 *  - **Empty details** — the page is left out, loudly, exactly as the German
 *    pages are left out of a `SITE_GERMAN=off` build. There is no company yet,
 *    so there is no controller to name; and the same emptiness already stops
 *    the outreach engine from sending anything that could link here.
 */
const NOTICE = noticeReadiness(LEGAL);
if (NOTICE.placeholders.length > 0) {
  console.error(
    `\n  ${SOURCE}/${OUTREACH_PRIVACY_SOURCE}: refusing to publish a privacy notice with invented company details — ` +
      `${describePlaceholders(NOTICE.placeholders)}.\n  Put the real values in src/lib/legal/identity.ts, or leave them empty.\n`,
  );
  process.exit(1);
}
if (!NOTICE.ready) {
  console.warn(
    `\n  ⚠  ${OUTREACH_PRIVACY_SOURCE} and ${OUTREACH_PRIVACY_SOURCE_DE} are not published: the outreach privacy notice ` +
      `has to name its controller, and we are missing ${describeIdentityGaps(NOTICE.missing)}.\n` +
      "     Nothing can be cold-emailed until the same fields are filled, so no message will link to a page that is not there.\n",
  );
}

const pages = PAGES.filter((f) => {
  if (!NOTICE.ready && (f === OUTREACH_PRIVACY_SOURCE || f === OUTREACH_PRIVACY_SOURCE_DE)) return false;
  if (fs.existsSync(path.join(SOURCE, f))) return true;
  console.error(`  page missing: ${SOURCE}/${f}`);
  process.exit(1);
});
if (!NOTICE.ready) delete GERMAN_SOURCES[OUTREACH_PRIVACY_SOURCE_DE];
for (const stray of fs.readdirSync(SOURCE).filter((f) => f.endsWith(".html") && !PAGES.includes(f))) {
  console.error(`\n  ${SOURCE}/${stray} is not in PAGES and will not be published. Move it or list it.\n`);
  process.exit(1);
}

/**
 * Clip filenames for a scene's lines, in order.
 *
 * Built by `npm run voices`, which needs a speech key; this build does not. A
 * missing manifest drops the page back to the silent timed transcript rather
 * than failing — the marketing site has to stay buildable on a machine with
 * no vendor credentials, which is most of them.
 *
 * Declared here rather than beside its use: `const` has no hoisting, and
 * reading it from the page loop above would be a temporal dead zone.
 */
const VOICE_MANIFEST: Record<string, string> = (() => {
  const file = path.join(SOURCE, "audio", "manifest.json");
  if (!fs.existsSync(file)) {
    console.log("  (no audio manifest — run 'npm run voices' to give the demo a voice)");
    return {};
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
})();

/**
 * Undefined unless every line in the scene has a clip: a half-voiced call is
 * worse than a silent one.
 *
 * Full paths, not bare filenames, and that is the whole fix for a Listen
 * button that had never once played a sound in production. Assets are
 * fingerprinted on the way into site/ — `bell.mp3` becomes `bell.a1b2c3d4.mp3`
 * — and every reference is rewritten by `repoint`, which searches for
 * `/audio/bell.mp3`. A bare `bell.mp3` in this JSON matched nothing, went out
 * unrewritten, and asked the browser for a file that no longer existed under
 * that name. The button worked locally, where nothing is hashed, which is
 * exactly why nobody caught it.
 */
function withAudio(scene: { turns: [string, string][] }) {
  const audio = scene.turns.map(([, text]) =>
    VOICE_MANIFEST[text] ? `/audio/${VOICE_MANIFEST[text]}` : null,
  );
  return audio.every((a) => a) ? audio : undefined;
}

const LANDING_SCENES = VERTICALS.map((v) => ({
  ...v.scenes[0],
  label: v.name,
  audio: withAudio(v.scenes[0]),
}));

// The same scenes as a file the page can fetch.
//
// public/landing.html is a template with an empty scene block, filled in when
// this script builds it into site/. Serving that template directly — which
// the app does on its own hostname — left the call panel dead and the Listen
// button wired to nothing. The page falls back to this file, so it works
// compiled or not.
fs.writeFileSync(
  path.join(SOURCE, "call-scenes.json"),
  JSON.stringify(LANDING_SCENES),
  "utf8",
);

/**
 * Logos, icons, photography, recordings — anything the pages reference.
 *
 * Listed *after* the scene file is written, not before: the scan is a
 * snapshot, and taking it first left the file on disk but out of the build,
 * which is the same silent-omission failure as the img/ folder and the
 * stylesheet before it.
 */
const assets = assetsUnder(".");

if (pages.length === 0) {
  console.error(`\n  No pages found in ${SOURCE}/\n`);
  process.exit(1);
}

/**
 * Content-addressed filenames.
 *
 * vercel.json serves /img/* and /audio/* with `immutable, max-age=31536000`,
 * which is correct and also a trap: replacing a photograph at the same path
 * means every browser that has ever visited keeps the old one for a year.
 * That is exactly what happened — new photography went live, the server
 * returned it, and returning visitors saw the previous pictures.
 *
 * Immutable caching is only safe when the URL changes with the bytes. So it
 * does now: salons.jpg becomes salons.6466fc3e.jpg, and a new photograph is a
 * new URL by construction rather than by anyone remembering to rename it.
 *
 * Text assets are rewritten rather than hashed-and-forgotten, because a path
 * can appear in HTML, in site.js (the call-scenes fallback) and inside
 * call-scenes.json itself.
 */
const TEXT = /\.(html|css|js|json)$/i;
// The stylesheet and the script are hashed too. They were not, and a phone
// that had cached yesterday's site.css kept yesterday's buttons after a
// deploy had removed them — "must-revalidate" is a request, not a promise.
// Text assets are both rewritten *and* renamed: the name changes with the
// bytes, and every reference follows.
const HASHED = /\.(css|js|mp3|svg|png|jpg|jpeg|webp|ico|woff2?)$/i;

/**
 * The two widget entry points, never renamed.
 *
 * `embed.js` and `embed-video.js` are loaded from the app's own origin — by a
 * customer's website, and by our site.js for Belle's bubble — so their URLs
 * belong to the app, not to this build. Hashing them rewrote
 * `appOrigin + "/embed-video.js"` inside site.js to a name only the marketing
 * host has, and on a deployment where the two are different hosts the browser
 * refused it and Belle's bubble never replaced the still hero.
 */
const NEVER_HASHED = new Set(["embed.js", "embed-video.js"]);

/**
 * The brand tokens, inlined.
 *
 * public/site.css imports /brand/tokens.css so the dashboard and the site read
 * one file. Left as an @import, every visitor would pay a second render-blocking
 * request; inlined, the tokens ship inside the hashed stylesheet. The hash is
 * taken over the inlined bytes, so a token change is a new stylesheet URL.
 */
const TOKENS_IMPORT = '@import url("/brand/tokens.css");';
function assetBytes(asset: string): Buffer {
  const bytes = fs.readFileSync(path.join(SOURCE, asset));
  if (asset !== "site.css") return bytes;
  const css = bytes.toString("utf8");
  if (!css.includes(TOKENS_IMPORT)) {
    console.error(`\n  site.css no longer imports the brand tokens (${TOKENS_IMPORT}).\n`);
    process.exit(1);
  }
  const tokens = fs.readFileSync(path.join(SOURCE, "brand", "tokens.css"), "utf8");
  return Buffer.from(css.replace(TOKENS_IMPORT, tokens), "utf8");
}

const hashedName = new Map<string, string>();
for (const asset of assets) {
  if (!HASHED.test(asset) || NEVER_HASHED.has(asset)) continue;
  const bytes = assetBytes(asset);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const ext = path.posix.extname(asset);
  hashedName.set(asset, `${asset.slice(0, -ext.length)}.${hash}${ext}`);
}

/**
 * Point every reference at its hashed name.
 *
 * Longest first: `/img/hero.jpg` and `/img/hero-sm.jpg` both start with the
 * same eleven characters, and replacing the shorter one first would corrupt
 * the longer.
 */
const rewrites = [...hashedName.entries()].sort((a, b) => b[0].length - a[0].length);

function repoint(text: string): string {
  for (const [from, to] of rewrites) {
    text = text.split(`/${from}`).join(`/${to}`);
  }
  return text;
}

let bytes = 0;
for (const page of pages) {
  if (page in GERMAN_SOURCES) continue;
  const target = RENAME[page] ?? page;
  let html = fs.readFileSync(path.join(SOURCE, page), "utf8");

  // Any cross-page link to the landing page has to follow the rename.
  for (const [from, to] of Object.entries(RENAME)) {
    html = html.split(`"/${from}"`).join(`"/${to === "index.html" ? "" : to}"`);
    html = html.split(`"${from}"`).join(`"${to === "index.html" ? "./" : to}"`);
  }

  // The landing page shows one call per trade, taken from the same data the
  // vertical pages use — so a line the agent no longer says cannot survive on
  // the home page after being fixed everywhere else.
  html = html.replace(
    '<script type="application/json" id="call-scenes"></script>',
    `<script type="application/json" id="call-scenes">${JSON.stringify(LANDING_SCENES)}</script>`,
  );

  // Pricing is generated from src/lib/billing/plans.ts. Re-applied here so a
  // catalogue change cannot ship with yesterday's prices even if nobody ran
  // `npm run pricing`; check-billing fails if public/landing.html is stale.
  if (page === "landing.html") html = applyPricing(html);
  // The integrations strip's tags follow the flags as this build sees them:
  // booking.google on is what turns Google Calendar "Available", and nothing
  // else does. Throws if the strip's markers are gone.
  if (page === "landing.html") html = applyIntegrations(html, process.env);
  // The country and language picker, and hreflang to the German pages.
  if (page === "landing.html") html = localiseEnglishLanding(html);
  if (page in LEGAL_PAGES) html = applyAlternates(html, legalAlternates(page as LegalPage));
  // The hand-written sentences about a flagged capability — the hero's
  // calendar badge and lead, "Whatever you book with", the privacy page's
  // Google section — follow the same flags (src/lib/site-flags.ts). The app's
  // server applies both again as it serves, from its own env.
  html = applySiteFlags(page, html, process.env);
  if (page === "terms.html") html = fillTrial(html);

  html = repoint(fillLegal(html));

  fs.writeFileSync(path.join(OUT, target), html, "utf8");
  bytes += Buffer.byteLength(html);
  console.log(`  ${page.padEnd(16)} →  ${OUT}/${target}`);
}

// --- German pages -------------------------------------------------------------
//
// One source each, three countries each: /de-de, /de-at and /de-ch, with that
// market's planned prices, its own language tag and Swiss spelling for de-CH.
// The legal pages are convenience translations; the English pages govern and
// each German one says so and links to it.
for (const [source, kind] of Object.entries(GERMAN ? GERMAN_SOURCES : {})) {
  const german = fs.readFileSync(path.join(SOURCE, source), "utf8");
  for (const page of Object.values(GERMAN_PAGES)) {
    const env = process.env;
    const rendered =
      kind === "landing"
        ? renderGermanLanding(german, page.market, env)
        : renderGermanLegal(kind, german, page.market, env);
    const target = path.posix.join(page.slug, kind === "landing" ? "index.html" : `${LEGAL_PAGES[kind].german}.html`);
    const html = repoint(fillLegal(rendered, "de"));
    fs.mkdirSync(path.join(OUT, page.slug), { recursive: true });
    fs.writeFileSync(path.join(OUT, target), html, "utf8");
    bytes += Buffer.byteLength(html);
    console.log(`  ${source.padEnd(16)} →  ${OUT}/${target}`);
  }
}

// Without this the pages deploy with a broken logo and no favicon — the
// HTML references /logo.svg and /icon.svg, which only exist if copied.
for (const asset of assets) {
  const name = hashedName.get(asset) ?? asset;
  const target = path.join(OUT, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (TEXT.test(asset)) {
    // site.js fetches /call-scenes.json, and call-scenes.json names the audio
    // files. Both have to follow the rename or the Listen button goes quiet.
    fs.writeFileSync(target, repoint(assetBytes(asset).toString("utf8")), "utf8");
  } else {
    fs.copyFileSync(path.join(SOURCE, asset), target);
  }

  bytes += fs.statSync(target).size;
  console.log(`  ${asset.padEnd(22)} →  ${OUT}/${name}`);
}

// --- vertical pages ---------------------------------------------------------

/**
 * The header's links.
 *
 * The other three trades first — someone who landed on /salons from a search
 * is one click from their own trade — then the two sections of the home page
 * they would otherwise have to hunt for. Anchors are absolute (`/#price`, not
 * `#price`), because those sections do not exist on this page and a bare hash
 * would scroll to nothing.
 */
function navFor(active: string): string {
  const links = VERTICALS.filter((v) => v.slug !== active)
    .map((v) => `<a href="/${v.slug}">${esc(v.name)}</a>`)
    .join("\n      ");
  return `${links}
      <a href="/#how">How it works</a>
      <a href="/#price">Pricing</a>
      <a class="nav-cta" href="https://app.belline.ai/checkout">Get started</a>
      <a class="nav-quiet" href="https://app.belline.ai/login" rel="nofollow">Sign in</a>`;
}

/**
 * One trade's page.
 *
 * The same page as the home page with different knowledge, which is why it is
 * built from the same stylesheet and the same blocks rather than a second
 * design: an operator who arrives on /salons from a search and then clicks
 * through to the pricing should not feel handed to another company.
 *
 * Two scenes, deliberately in that order. The first is the request taken for
 * the team to confirm, which is what they came to see. The second is the call
 * Belline hands over or refuses, which is what
 * they are actually deciding about — a receptionist that will say anything is
 * worse than no receptionist, and every operator knows it.
 */
/**
 * The link from a trade page into the trade's city pages.
 *
 * Without it the whole of `/ai-receptionist` is a crawl island: the landing
 * pages link *out* to `/dental` and `/salons`, and nothing linked back, so the
 * only route in from this site was the sitemap. The trade hub is the right
 * destination — it is the page that lists the cities — and the link only
 * appears where this build actually wrote one.
 */
function seoLinkFor(tradeSlug: string): string {
  const vertical = SEO_VERTICALS.find((x) => x.tradePage === `/${tradeSlug}`);
  const built = vertical && seoPages().some((p) => p.kind === "vertical-hub" && p.vertical?.slug === vertical.slug);
  if (!vertical || !built) return "";
  return `      <a href="${verticalHubPath(vertical.slug)}">AI receptionist for ${esc(vertical.plural)}, city by city</a><br>\n`;
}

function verticalPage(v: Vertical): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#FFFFFF">
<title>${esc(v.title)}</title>
<meta name="description" content="${esc(v.description)}">
<link rel="canonical" href="${ORIGIN}/${v.slug}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Belline">
<meta property="og:url" content="${ORIGIN}/${v.slug}">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(v.description)}">
<meta property="og:image" content="${ORIGIN}/brand/belline-og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Belline bell button beside the words: Someone always answers.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(v.title)}">
<meta name="twitter:description" content="${esc(v.description)}">
<meta name="twitter:image" content="${ORIGIN}/brand/belline-og.png">

<!--
  Structured data. Generated by scripts/site-llms.ts from the catalogue and the
  markets module: the sector pages carried none at all, so a search engine or
  an assistant reading /clinics had no machine-readable way to learn that this
  is a paid service, who sells it, where, or from what price.
-->
${verticalJsonLd(v, ORIGIN)}

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body>

<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="/">
      ${BADGE}
      <span>Belline</span>
    </a>
    <nav id="site-nav" data-open="false">
      ${navFor(v.slug)}
    </nav>
    <!--
      Das Menü fürs Telefon. Vorher stand hier nichts: unter 900 px hat die
      Navigation schlicht "display: none" bekommen, und damit gab es auf einem
      Telefon keinen Weg zu Preisen oder Anmeldung außer scrollen. Das ist kein
      aufgeräumter Kopf, das ist ein fehlender.
    -->
    <button class="menu-toggle" type="button" aria-expanded="false"
            aria-controls="site-nav" aria-label="Open menu">
      <span class="bar"></span>
    </button>
  </div>
</header>

<main>

  <section class="hero">
    <div class="wrap hero-in">
      <div class="hero-copy">
        <p class="eyebrow rise">Belline for ${esc(v.name.toLowerCase())}</p>
        <h1 class="display rise rise-1">${esc(v.headline)}</h1>
        <p class="lead rise rise-2">${esc(v.lead)}</p>

        <!--
          Kaufen ist der Hauptknopf, auch hier. Vorher stand "Hear Belline"
          gefüllt davor und "Get Belline" als Umriss daneben — die Seite hat
          also am lautesten zu dem geführt, was nichts verkauft, während die
          Startseite inzwischen genau einen Knopf hat. Zwei Seiten desselben
          Trichters, die sich widersprechen, ist schlimmer als jede der beiden
          Varianten für sich.
        -->
        <div class="cta-row rise rise-3">
          <a class="btn" href="https://app.belline.ai/checkout">Get started</a>
        </div>

        <p class="hero-note rise rise-4">
          Keep your existing number. No porting, no new hardware. Answers in
          English. Or <a href="https://app.belline.ai/call?start=1" data-call>speak to Belline in your browser</a>, free.
        </p>
      </div>

${CALL_PANEL}
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">Rules it follows</p>
          <h2 class="display">Answering is the easy part.<br>Knowing what not to say is harder.</h2>
        </div>
        <p class="sec-lead">
          Belline answers only from what you tell it: your services, prices,
          hours and rules. What it doesn’t know, it takes as a message for your
          team.
        </p>
      </div>

      <div class="knows">
        ${v.constraints
          .map(
            (c) => `<div>
          <h3>${esc(c.head)}</h3>
          <p>${esc(c.body)}</p>
        </div>`,
          )
          .join("\n        ")}
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="split">
        <div>
          <p class="eyebrow">Where it stops</p>
          <h2 class="display">The most important thing it does is know what it must not answer.</h2>
          <p style="margin-top:26px">${esc(v.boundary)}</p>
          <a class="btn" href="https://app.belline.ai/checkout">Get started</a>
        </div>
        <figure class="plate">
          <img src="${esc(v.image)}" width="880" height="495" loading="lazy" alt="${esc(v.imageAlt)}">
        </figure>
      </div>
    </div>
  </section>

  <section class="rule closer">
    <div class="wrap">
      <p class="eyebrow">Hear it now</p>
      <h2 class="display">Be the caller.</h2>
      <p class="lead" style="margin-top:26px; max-width:50ch">
        The same receptionist your callers would reach. Ask it something hard,
        then ask for a person.
      </p>

      <div class="cta-row" style="margin-top:34px">
        <a class="btn" href="https://app.belline.ai/call?start=1" data-call>
          ${MARK}
          Speak to Belline
        </a>
      </div>

      <p class="fine" style="max-width:56ch">
        Free, in your browser, 24 hours a day. Or ring
        <a href="tel:+15717785920">+1 571 778 5920</a>. That’s an international
        call from the UAE, so your usual charges apply. Calls last up to ten
        minutes, and the line takes a limited number of calls each day.
      </p>

      <div class="terms">
        <div>
          <h4>Keep your number</h4>
          <p>Forward calls to Belline from the line you already have. Forward only the calls nobody answers, and your team still picks up first.</p>
        </div>
        <div>
          <h4>Nothing to install</h4>
          <p>No new handset, no app for your staff, no change to what is printed on your door.</p>
        </div>
        <div>
          <h4>${TRIAL.days} days free</h4>
          <p>${trialSentence()}</p>
        </div>
      </div>
    </div>
  </section>

</main>

<footer>
  <div class="wrap foot-in">
    <a class="brand" href="/">
      ${BADGE}
      <span>Belline</span>
    </a>
    <p>
      AI voice and chat reception for UAE businesses that take calls, messages or bookings.<br>
      <a href="tel:+15717785920">+1 571 778 5920</a> (an international call from the UAE) ·
      <a href="mailto:hello@belline.ai">hello@belline.ai</a> ·
      <a href="https://app.belline.ai/login" rel="nofollow">Staff sign-in</a><br>
${seoLinkFor(v.slug)}      <a href="/privacy">Privacy policy</a> ·
      <a href="/terms">Terms of service</a>
    </p>
  </div>
</footer>

${BELL_FAB}
<script type="application/json" id="call-scenes">${JSON.stringify(v.scenes.map((sc) => ({ ...sc, audio: withAudio(sc) })))}</script>
<script src="/site.js"></script>
</body>
</html>
`;
}

for (const v of VERTICALS) {
  // A directory with an index, so the URL is /dental rather than /dental.html.
  const dir = path.join(OUT, v.slug);
  fs.mkdirSync(dir, { recursive: true });
  // Repointed like the copied pages: these carry /img/… straight out of
  // site-content.ts, and without this every vertical page would ask for a
  // filename the build no longer writes.
  const html = repoint(verticalPage(v));
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  bytes += Buffer.byteLength(html);
  console.log(`  ${v.slug.padEnd(22)} →  ${OUT}/${v.slug}/index.html`);
}

// --- location landing pages ---------------------------------------------------
//
// `/ai-receptionist/<trade>/<city>`, plus a hub per trade, a hub per city and
// an index over the lot (scripts/seo/). The data is three files — the trade,
// the city, and the copy that is only true where the two meet — so a new
// combination is a data edit and nothing here changes. docs/seo-pages.md is
// the how-to.
//
// The first pass publishes three of them on purpose, so the quality can be
// judged before thirty pages go out under one domain. `SEO_PAGES=all` builds
// every combination that has pair copy written for it.
const MISSING_PAIRS = missingPairCopy();
if (MISSING_PAIRS.length > 0) {
  console.error(
    `\n  A location landing page was listed for publication with no copy written for it: ${MISSING_PAIRS.join(", ")}.\n` +
      "  Write it in scripts/seo/pairs.ts, or take it out of FIRST_PASS in scripts/seo/matrix.ts.\n" +
      "  There is no generic fallback here deliberately: a page with the city's name dropped into\n" +
      "  the trade's paragraph is the scaled-content abuse this whole arrangement exists to avoid.\n",
  );
  process.exit(1);
}

const SEO_PAGES = seoPages();
const SEO_CONTEXT = { pages: SEO_PAGES, withAudio };
for (const page of SEO_PAGES) {
  // Every path is `/a/b/c`, so the file is `a/b/c/index.html` and the URL has
  // no extension — the same directory-with-an-index shape as /dental.
  const dir = path.join(OUT, page.path.replace(/^\//, ""));
  fs.mkdirSync(dir, { recursive: true });
  // `repoint` for the same reason the trade pages need it: these carry
  // /img/… out of scripts/seo/verticals.ts, and the build renames every image.
  const html = repoint(renderSeoPage(page, SEO_CONTEXT));
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  bytes += Buffer.byteLength(html);
  console.log(`  ${page.path.padEnd(22)} →  ${OUT}${page.path}/index.html`);
}
const NOT_OPEN_PAGES = SEO_PAGES.filter((p) => ("city" in p && p.city ? !marketLive(p.city) : false)).length;
if (NOT_OPEN_PAGES > 0) {
  console.log(
    `  (${NOT_OPEN_PAGES} of them are for markets we are not open in: waitlist, no prices, no checkout — src/lib/markets.ts decides, not the copy.)`,
  );
}

/**
 * The permanent redirects from the URLs this system used to have.
 *
 * Three landing pages and three city hubs shipped at
 * `/ai-receptionist/<trade>/<city>` before the country segment went in;
 * src/lib/seo-redirects.ts explains why it went in and holds the list.
 * Netlify reads a `_redirects` file out of the publish directory, so it is
 * written here from the same table the app's own server and `npm run
 * check:seo` read — three consumers, one list, and no chance of the site and
 * the server disagreeing about where an indexed URL went.
 */
{
  const lines = SEO_REDIRECTS.map((r) => `${r.from} ${r.to} 301!`);
  fs.writeFileSync(path.join(OUT, "_redirects"), `${lines.join("\n")}\n`, "utf8");
  console.log(`  _redirects             →  ${lines.length} permanent redirects from the old URL shape`);
}

/**
 * The sitemap, with the location pages added to it.
 *
 * public/sitemap.xml is hand-kept for the pages that are hand-written, and
 * that is fine while there are sixteen of them. These are generated, and a
 * generated page whose sitemap entry is typed by hand is a page that silently
 * stops being listed the first time somebody adds a city — so the entries are
 * written here, from the same `seoPages()` the build just rendered. Rewritten
 * in `site/` rather than in `public/`, because the source file is a source.
 */
{
  const file = path.join(OUT, "sitemap.xml");
  const xml = fs.readFileSync(file, "utf8");
  const close = "</urlset>";
  if (!xml.includes(close)) {
    console.error(`\n  ${OUT}/sitemap.xml has no </urlset> to add the location pages before.\n`);
    process.exit(1);
  }
  const entries = seoSitemapEntries();
  const out = xml.replace(close, `${entries.join("\n")}\n${close}`);
  fs.writeFileSync(file, out, "utf8");
  console.log(`  sitemap.xml            →  ${entries.length} location pages listed`);
}

// --- llms.txt -----------------------------------------------------------------
//
// What an assistant reads when somebody asks it to find an AI receptionist.
// Generated (scripts/site-llms.ts) from the catalogue, the markets module, the
// language registry and the flags, never typed out here: a machine-readable
// summary that has to be remembered is one that will be wrong the week after a
// price changes. `npm run check:llms` fails if it drifts from any of them.
//
// Written last, after every page and the sitemap exist: it is a summary of the
// site, and a summary is the wrong thing to write before the thing it
// summarises. The `SITE_GERMAN` gate is passed through, so a build that did
// not publish the German pages does not advertise them to an assistant either.
{
  const llms = renderLlmsTxt({ origin: ORIGIN, german: GERMAN });
  fs.writeFileSync(path.join(OUT, "llms.txt"), llms, "utf8");
  bytes += Buffer.byteLength(llms);
  console.log(`  ${"llms.txt".padEnd(22)} →  ${OUT}/llms.txt`);
}

// --- sending-domain pages -----------------------------------------------------
//
// One per cold-sending domain (src/lib/sales/sending/domains.ts), into
// site/sender/<domain>/index.html. `src/lib/marketing.ts` serves the matching
// one at `/` when a request arrives addressed to that domain, so there is a
// single build and a single deployment rather than four — the pages differ
// only by hostname, and four build outputs would be four things to forget.
//
// Unlike the outreach privacy notice, these are published while the company
// details are empty, for the same reason privacy.html is: the notice's job is
// to name a controller and it cannot do that job half-done, whereas this
// page's job is to tell a suspicious recipient that the domain is ours and how
// to make us stop, and all of that is true today. What it must never do is
// invent the missing half, so it prints the same "Belline" the email footer
// prints and says in words that there is no company yet.
const SENDER_LEGAL_GAPS = describeIdentityGaps(NOTICE.missing);
if (SENDER_LEGAL_GAPS) {
  console.warn(
    `\n  ⚠  the ${SENDING_DOMAINS.length} sending-domain pages are published naming only "Belline": ` +
      `we are missing ${SENDER_LEGAL_GAPS}.\n` +
      "     They say so on their face rather than inventing a company. Fill src/lib/legal/identity.ts\n" +
      "     and rebuild, and they will carry the same letterhead as the email footers.\n",
  );
}
for (const domain of SENDING_DOMAINS) {
  const file = senderPageFile(domain.domain);
  const html = repoint(
    senderPage({
      domain,
      legal: LEGAL,
      // Only when the build actually published it. A link to a page this same
      // build decided not to write is a 404 on the one page whose entire
      // purpose is being checkable by a stranger.
      privacyUrl: NOTICE.ready ? outreachPrivacyUrl({ language: "en" }) : null,
      policyUrl: `${domain.site}/privacy`,
      unsubscribePath: UNSUBSCRIBE_PATH,
    }),
  );
  fs.mkdirSync(path.join(OUT, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(OUT, file), html, "utf8");
  bytes += Buffer.byteLength(html);
  console.log(`  ${domain.domain.padEnd(22)} →  ${OUT}/${file}`);
}

console.log(
  `\n  ${pages.length + VERTICALS.length + SEO_PAGES.length + SENDING_DOMAINS.length} pages, ${assets.length} assets, ${(bytes / 1024).toFixed(0)} KB. No build step, no dependencies.\n` +
    `  Deploy: drag the ${OUT}/ folder onto Netlify Drop, or run 'npx vercel deploy --prod ${OUT}'.\n`,
);
