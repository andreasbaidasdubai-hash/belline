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

const SOURCE = "public";
const OUT = "site";
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
const ASSET = /\.(css|js|json|mp3|svg|png|jpg|jpeg|webp|ico|woff2?)$/i;

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

const pages = fs.readdirSync(SOURCE).filter((f) => f.endsWith(".html"));

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

/** Undefined unless every line in the scene has a clip: a half-voiced call is worse than a silent one. */
function withAudio(scene: { turns: [string, string][] }) {
  const audio = scene.turns.map(([, text]) => VOICE_MANIFEST[text] ?? null);
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
const HASHED = /\.(mp3|svg|png|jpg|jpeg|webp|ico|woff2?)$/i;

const hashedName = new Map<string, string>();
for (const asset of assets) {
  if (!HASHED.test(asset)) continue;
  const bytes = fs.readFileSync(path.join(SOURCE, asset));
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

  html = repoint(html);

  fs.writeFileSync(path.join(OUT, target), html, "utf8");
  bytes += Buffer.byteLength(html);
  console.log(`  ${page.padEnd(16)} →  ${OUT}/${target}`);
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
    fs.writeFileSync(target, repoint(fs.readFileSync(path.join(SOURCE, asset), "utf8")), "utf8");
  } else {
    fs.copyFileSync(path.join(SOURCE, asset), target);
  }

  bytes += fs.statSync(target).size;
  console.log(`  ${asset.padEnd(22)} →  ${OUT}/${name}`);
}

// --- vertical pages ---------------------------------------------------------

/**
 * Escape text that lands in HTML. Every string here is ours rather than a
 * visitor's, but a page that only escapes when it remembers to is a page that
 * eventually forgets.
 */
function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

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
      <a href="/#what">What it does</a>
      <a href="/#price">Pricing</a>
      <a class="nav-cta" href="/#book">Get Belline</a>
      <a class="nav-quiet" href="https://app.belline.ai/login" rel="nofollow">Staff sign-in</a>`;
}

/**
 * The call panel, for the generated pages.
 *
 * The same markup and the same site.js as the home page's hero — the scenes
 * differ, the machinery does not. Two tabs here rather than four: the call
 * this trade's line takes, and the one it refuses. An operator deciding
 * whether to trust this is buying the second one.
 */
const CALL_PANEL = `      <div class="call rise rise-2" id="call" data-speaking="false">
        <div class="call-tabs" role="tablist" aria-label="Choose a call"></div>
        <div class="call-head">
          <span class="call-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
          <span class="call-status">Ringing</span>
          <span class="call-line"></span>
          <button class="call-listen" type="button" aria-pressed="false">
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z"/>
              <path d="M5 11a1 1 0 1 1 2 0 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21a1 1 0 1 1-2 0v-3.07A7 7 0 0 1 5 11Z"/>
            </svg>
            <span class="call-listen-label">Listen</span>
          </button>
          <audio class="call-audio" preload="none"></audio>
        </div>
        <div class="call-body" id="call-body" role="tabpanel" aria-live="polite"></div>
      </div>`;

/**
 * The floating bell, for the generated pages.
 *
 * Same markup as the landing page's, with one difference: the href is
 * `/#book` rather than `#book`, because a vertical page has no booking form
 * of its own and `#book` on /dental would scroll to nothing.
 */
const MARK = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="9.5" r="3.5" fill="currentColor"/>
    <path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor"/>
    <rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor"/>
  </svg>`;

const BELL_FAB = `<a class="bell-fab" href="https://app.belline.ai/call?start=1" data-call aria-label="Hear Belline now">
  ${MARK}
  <span class="bell-fab-say">Hear Belline</span>
</a>`;

/**
 * One trade's page.
 *
 * The same page as the home page with different knowledge, which is why it is
 * built from the same stylesheet and the same blocks rather than a second
 * design: an operator who arrives on /salons from a search and then clicks
 * through to the pricing should not feel handed to another company.
 *
 * Two scenes, deliberately in that order. The first is the booking, which is
 * what they came to see. The second is the call Belline refuses, which is what
 * they are actually deciding about — a receptionist that will say anything is
 * worse than no receptionist, and every operator knows it.
 */
function verticalPage(v: Vertical): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="theme-color" content="#FBF9F5">
<title>${esc(v.title)}</title>
<meta name="description" content="${esc(v.description)}">
<link rel="canonical" href="${ORIGIN}/${v.slug}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Belline">
<meta property="og:url" content="${ORIGIN}/${v.slug}">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(v.description)}">
<meta property="og:image" content="${ORIGIN}/img/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A concierge bell on a reception counter, a call arriving on a phone beside it.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(v.title)}">
<meta name="twitter:description" content="${esc(v.description)}">
<meta name="twitter:image" content="${ORIGIN}/img/og.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body>

<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="/">
      ${MARK}
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

        <div class="cta-row rise rise-3">
          <a class="btn" href="https://app.belline.ai/call?start=1" data-call>
            ${MARK}
            Hear Belline
          </a>
          <a class="btn line" href="/#book">Get Belline</a>
        </div>

        <p class="hero-note rise rise-4">
          Keep your existing number. No porting, no new hardware, nothing for
          your callers to learn. Or ring it —
          <a href="tel:+15717785920">+1 571 778 5920</a>.
        </p>
      </div>

${CALL_PANEL}
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <p class="eyebrow">What it checks</p>
          <h2 class="display">Answering is the easy part.<br>Knowing what is genuinely free is not.</h2>
        </div>
        <p class="sec-lead">
          A voice agent that cannot see your book is an expensive answering
          machine. Belline holds the constraints your team holds in their head,
          which is why it can commit to a time without anyone checking it after.
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
          <a class="btn" href="/#book">Get Belline</a>
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
        A live line, answered by the same agent your callers would reach. Book
        something, change it, then try to catch it out.
      </p>

      <div class="cta-row" style="margin-top:34px">
        <a class="btn" href="https://app.belline.ai/call?start=1" data-call>
          ${MARK}
          Hear Belline
        </a>
        <a class="btn line" href="tel:+15717785920">Ring +1 571 778 5920</a>
      </div>

      <p class="fine" style="max-width:56ch">
        Answered 24 hours a day. Nothing you book is real — the agent says so
        itself. Calls last up to six minutes and the line is capped each day.
        Your own call charges apply.
      </p>

      <div class="terms">
        <div>
          <h4>Keep your number</h4>
          <p>Belline sits behind the line you already have. Your team always gets first refusal; it picks up the calls nobody reaches.</p>
        </div>
        <div>
          <h4>Nothing to install</h4>
          <p>No new handset, no app for your staff, no change to what is printed on your door. Setting a venue up takes about half an hour.</p>
        </div>
        <div>
          <h4>14 days free</h4>
          <p>A limited number of live-call minutes, no card, nothing charged. Standard onboarding is free — we set your venue up with you.</p>
        </div>
      </div>
    </div>
  </section>

</main>

<footer>
  <div class="wrap foot-in">
    <a class="brand" href="/">
      ${MARK}
      <span>Belline</span>
    </a>
    <p>
      AI reception for clinics, dental practices, salons and restaurants.<br>
      <a href="tel:+15717785920">+1 571 778 5920</a> ·
      <a href="mailto:hello@belline.ai">hello@belline.ai</a> ·
      <a href="https://app.belline.ai/login" rel="nofollow">Staff sign-in</a>
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

console.log(
  `\n  ${pages.length + VERTICALS.length} pages, ${assets.length} assets, ${(bytes / 1024).toFixed(0)} KB. No build step, no dependencies.\n` +
    `  Deploy: drag the ${OUT}/ folder onto Netlify Drop, or run 'npx vercel deploy --prod ${OUT}'.\n`,
);
