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

const pages = fs
  .readdirSync(SOURCE)
  .filter((f) => f.endsWith(".html"));

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

console.log(
  `\n  ${pages.length} pages, ${(bytes / 1024).toFixed(0)} KB. No build step, no dependencies.\n` +
    `  Deploy: drag the ${OUT}/ folder onto Netlify Drop, or run 'npx vercel deploy --prod ${OUT}'.\n`,
);
