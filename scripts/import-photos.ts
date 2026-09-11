/**
 * Bring a supplied photograph into the site at the size the page actually uses.
 *
 *   npm run photos -- <source.jpg> <slug> [focus]
 *
 * The vertical pages render a 880x495 card, so anything larger is wasted bytes
 * on a phone and anything smaller is soft.
 *
 * `focus` is where in the original the 16:9 band is taken from, 0 to 1, and it
 * defaults to the middle. It exists because sharp's `attention` strategy —
 * which is the obvious thing to reach for — cropped a square salon photograph
 * to a band starting below the stylist's chin. Attention finds contrast, not
 * faces, and the brightest thing in that frame was a window. Framing a
 * photograph is a judgement; this makes it one somebody makes on purpose.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const WIDTH = 880;
const HEIGHT = 495;
/** Matches the existing photography: ~70-90 KB at this size. */
const QUALITY = 82;

const [source, slug, focusArg] = process.argv.slice(2);
const focus = Math.min(1, Math.max(0, focusArg === undefined ? 0.5 : Number(focusArg)));

if (!source || !slug || Number.isNaN(focus)) {
  console.error("\n  Usage: npm run photos -- <source.jpg> <slug> [focus 0-1]\n");
  process.exit(1);
}

if (!fs.existsSync(source)) {
  console.error(`\n  No such file: ${source}\n`);
  process.exit(1);
}

const out = path.join(process.cwd(), "public", "img", `${slug}.jpg`);

const meta = await sharp(source).metadata();

// Upscaling shows. Better to refuse and ask for a bigger original than to ship
// a soft hero that everybody notices and nobody can name.
if ((meta.width ?? 0) < WIDTH) {
  console.error(
    `\n  ${path.basename(source)} is only ${meta.width}px wide; the card is ${WIDTH}px.\n` +
      `  Upscaling would be visibly soft. Ask for a larger original.\n`,
  );
  process.exit(1);
}

// Take the 16:9 band explicitly, then resize it. Whichever dimension has
// slack is the one `focus` slides along.
const w = meta.width!;
const h = meta.height!;
const target = WIDTH / HEIGHT;

let band: { left: number; top: number; width: number; height: number };
if (w / h < target) {
  const bandH = Math.round(w / target);
  band = { left: 0, top: Math.round((h - bandH) * focus), width: w, height: bandH };
} else {
  const bandW = Math.round(h * target);
  band = { left: Math.round((w - bandW) * focus), top: 0, width: bandW, height: h };
}

await sharp(source)
  .extract(band)
  .resize(WIDTH, HEIGHT)
  .jpeg({ quality: QUALITY, mozjpeg: true })
  .toFile(out);

const kb = Math.round(fs.statSync(out).size / 1024);
console.log(
  `\n  ${path.basename(source)}  ${w}x${h}  focus ${focus}` +
    `  →  public/img/${slug}.jpg  ${WIDTH}x${HEIGHT}  ${kb} KB\n`,
);
