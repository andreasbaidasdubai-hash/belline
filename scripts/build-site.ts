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

const SOURCE = "public";
const OUT = "site";

/** The landing page becomes the site root; everything else keeps its name. */
const RENAME: Record<string, string> = { "landing.html": "index.html" };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const ASSET = /\.(svg|png|jpg|jpeg|webp|ico|woff2?)$/i;

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
/** Logos, icons, photography — anything the pages reference by URL. */
const assets = assetsUnder(".");

if (pages.length === 0) {
  console.error(`\n  No pages found in ${SOURCE}/\n`);
  process.exit(1);
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

  fs.writeFileSync(path.join(OUT, target), html, "utf8");
  bytes += Buffer.byteLength(html);
  console.log(`  ${page.padEnd(16)} →  ${OUT}/${target}`);
}

// Without this the pages deploy with a broken logo and no favicon — the
// HTML references /logo.svg and /icon.svg, which only exist if copied.
for (const asset of assets) {
  const target = path.join(OUT, asset);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(SOURCE, asset), target);
  bytes += fs.statSync(target).size;
  console.log(`  ${asset.padEnd(22)} →  ${OUT}/${asset}`);
}

console.log(
  `\n  ${pages.length} pages, ${assets.length} assets, ${(bytes / 1024).toFixed(0)} KB. No build step, no dependencies.\n` +
    `  Deploy: drag the ${OUT}/ folder onto Netlify Drop, or run 'npx vercel deploy --prod ${OUT}'.\n`,
);
