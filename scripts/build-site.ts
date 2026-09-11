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

function navFor(active: string): string {
  const links = VERTICALS.map(
    (v) =>
      `<a href="/${v.slug}"${v.slug === active ? ' aria-current="page"' : ""}>${esc(v.name)}</a>`,
  ).join("\n      ");
  return `${links}
      <a href="/#how">How it works</a>
      <a href="/#try">Ring it</a>
      <a class="signin-mobile" href="https://app.belline.ai">Sign in</a>`;
}

/**
 * The floating bell, for the generated pages.
 *
 * Same markup as the landing page's, with one difference: the href is
 * `/#book` rather than `#book`, because a vertical page has no booking form
 * of its own and `#book` on /dental would scroll to nothing.
 */
const BELL_FAB = `<a class="bell-fab" href="https://app.belline.ai/call?start=1" data-call aria-label="Talk to Belline now">
  <svg viewBox="355 180 490 430" aria-hidden="true" focusable="false">
    <g fill="currentColor">
      <rect x="555" y="190" width="90" height="35" rx="18"/>
      <rect x="572" y="213" width="56" height="47" rx="10"/>
      <path d="M380 505 C393 477 410 461 431 450 C444 327 506 258 600 258 C694 258 756 327 769 450 C790 461 807 477 820 505 L380 505 Z"/>
      <path d="M365 570 C365 538 383 519 418 519 L500 519 C509 519 515 525 516 538 C521 579 542 595 600 595 C658 595 679 579 684 538 C685 525 691 519 700 519 L782 519 C817 519 835 538 835 570 C835 589 826 600 809 600 L391 600 C374 600 365 589 365 570 Z"/>
    </g>
  </svg>
  <span class="bell-fab-say">Talk to Belline</span>
</a>`;

function verticalPage(v: Vertical): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="theme-color" content="#0F2131">
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body>

<header class="top">
  <div class="wrap top-in">
    <a class="logo" href="/"><img src="/logo.svg" alt="Belline"></a>
    <nav id="site-nav">
      ${navFor(v.slug)}
    </nav>
    <div class="right">
      <a class="signin" href="https://app.belline.ai">Sign in</a>
      <a class="btn small" href="/#demo">Book a demo</a>
      <button class="menu-toggle" type="button" aria-expanded="false"
              aria-controls="site-nav" aria-label="Open menu">
        <span class="bar"></span>
      </button>
    </div>
  </div>
</header>

<main>
  <section class="hero">
    <div class="wrap hero-in">
      <div class="hero-copy">
        <div class="eyebrow">Belline for ${esc(v.name.toLowerCase())}</div>
        <h1>${esc(v.headline)}</h1>
        <p class="lead">${esc(v.lead)}</p>
        <div class="cta-row">
          <a class="btn" href="/#try">Hear it answer</a>
          <a class="btn ghost" href="/#demo">Build my Belline</a>
        </div>
        <p class="reassure">
          Keep your existing number. No porting, no new hardware, nothing for
          your callers to learn.
        </p>
      </div>

      <div class="call" id="call" data-speaking="false">
        <div class="call-tabs" role="tablist" aria-label="Choose a call"></div>
        <div class="call-head">
          <span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="call-status">Ringing</span>
          <span class="call-line">${esc(v.scenes[0].when)}</span>
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
      </div>
    </div>
  </section>

  <section class="band" id="constraints">
    <div class="wrap">
      <div class="narrow">
        <div class="moment"><span class="at">19:48</span><div class="eyebrow">What it checks</div></div>
        <h2>Answering is the easy part. Knowing what is genuinely free is not.</h2>
        <p style="margin-top:16px">
          A voice agent that cannot see your book is an expensive answering
          machine. Belline holds the constraints your team holds in their head,
          which is why it can commit to a time without anyone checking it after.
        </p>
      </div>
      <div class="trades" style="margin-top:34px">
        ${v.constraints
          .map(
            (c) => `<article class="trade">
          <h3>${esc(c.head)}</h3>
          <p>${esc(c.body)}</p>
        </article>`,
          )
          .join("\n        ")}
      </div>
    </div>
  </section>

  <section id="boundary">
    <div class="wrap">
      <div class="split-cta">
        <div>
          <div class="moment"><span class="at">19:48</span><div class="eyebrow">Where it stops</div></div>
          <h2>The most important thing it does is know what it must not answer.</h2>
          <p style="margin-top:16px">${esc(v.boundary)}</p>
          <a class="btn" href="/#demo">Build my Belline</a>
        </div>
        <div class="shot">
          <img src="${esc(v.image)}" width="880" height="495" loading="lazy" alt="${esc(v.imageAlt)}">
        </div>
      </div>
    </div>
  </section>

  <section class="band">
    <div class="wrap">
      <div class="closer">
        <div class="eyebrow">Hear it now</div>
        <h2>Be the caller.</h2>
        <p>
          A live line, answered by the same agent your callers would reach.
          Book something, change it, then try to catch it out.
        </p>
        <a class="dial-cta" href="tel:+15717785920">
          <span class="dial-label">Call the demonstration line</span>
          <span class="dial-number">+1 571 778&nbsp;5920</span>
        </a>
        <p class="dial-note">
          Answered 24 hours a day. Nothing you book is real — the agent says so
          itself. Calls last up to six minutes and the line is capped each day.
          Your own call charges apply.
        </p>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap foot-in">
    <a class="logo" href="/"><img src="/logo.svg" alt="Belline"></a>
    <p>AI reception for clinics, dental practices, salons and restaurants.</p>
  </div>
</footer>

${BELL_FAB}
<script type="application/json" id="call-scenes">${JSON.stringify(v.scenes.map((s) => ({ ...s, audio: withAudio(s) })))}</script>
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
