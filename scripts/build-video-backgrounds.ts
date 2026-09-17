/**
 * The video receptionist's backgrounds, generated — no stock photography.
 *
 *   node --import tsx scripts/build-video-backgrounds.ts
 *
 * Writes square JPEGs to public/video/backgrounds/ (the call view is a circle,
 * and the standalone page letterboxes the same square). Soft, Apple-light
 * gradients on the brand palette (public/brand/tokens.css); the Belline one
 * carries the bell mark, faint, where a face's shoulders will not cover it.
 * Ids and names live in src/lib/video/backgrounds.ts.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "public", "video", "backgrounds");
const SIZE = 1024;

/** The bell from public/brand/belline-mark.svg, on a 48-unit grid. */
const BELL = `<circle cx="24" cy="10" r="4.2"/><path d="M8.5 32a15.5 15.5 0 0 1 31 0Z"/><rect x="5" y="34.5" width="38" height="7" rx="3.5"/>`;

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;

const BACKGROUNDS: Record<string, string> = {
  "belline-light": svg(`
    <defs>
      <radialGradient id="g" cx="50%" cy="38%" r="75%">
        <stop offset="0" stop-color="#FFFFFF"/>
        <stop offset=".55" stop-color="#F3F7FD"/>
        <stop offset="1" stop-color="#DCE8F8"/>
      </radialGradient>
      <radialGradient id="glow" cx="80%" cy="85%" r="45%">
        <stop offset="0" stop-color="#0071E3" stop-opacity=".10"/>
        <stop offset="1" stop-color="#0071E3" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#glow)"/>
    <g transform="translate(206 250) scale(2.4)" fill="#0071E3" fill-opacity=".13">${BELL}</g>`),

  "studio-grey": svg(`
    <defs>
      <radialGradient id="g" cx="50%" cy="42%" r="70%">
        <stop offset="0" stop-color="#F5F5F7"/>
        <stop offset=".6" stop-color="#E4E4E9"/>
        <stop offset="1" stop-color="#C9C9D0"/>
      </radialGradient>
    </defs>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>`),

  "warm-lounge": svg(`
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#F6EEE6"/>
        <stop offset="1" stop-color="#E7D6C6"/>
      </linearGradient>
      <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="46"/></filter>
    </defs>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>
    <g filter="url(#blur)">
      <circle cx="170" cy="260" r="120" fill="#F2C38F" fill-opacity=".55"/>
      <circle cx="860" cy="210" r="95" fill="#FBE3B8" fill-opacity=".7"/>
      <rect x="600" y="620" width="380" height="300" rx="60" fill="#C9A184" fill-opacity=".45"/>
      <rect x="40" y="640" width="330" height="330" rx="80" fill="#B98C6E" fill-opacity=".35"/>
      <circle cx="760" cy="470" r="70" fill="#FFF4DD" fill-opacity=".8"/>
    </g>`),

  "evening-navy": svg(`
    <defs>
      <radialGradient id="g" cx="50%" cy="35%" r="80%">
        <stop offset="0" stop-color="#2E3A52"/>
        <stop offset=".6" stop-color="#1F2433"/>
        <stop offset="1" stop-color="#15171E"/>
      </radialGradient>
      <radialGradient id="glow" cx="50%" cy="100%" r="60%">
        <stop offset="0" stop-color="#0071E3" stop-opacity=".22"/>
        <stop offset="1" stop-color="#0071E3" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#glow)"/>`),

  "plain-white": svg(`<rect width="${SIZE}" height="${SIZE}" fill="#FFFFFF"/>`),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [id, source] of Object.entries(BACKGROUNDS)) {
  const file = path.join(OUT, `${id}.jpg`);
  await sharp(Buffer.from(source)).jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: "4:4:4" }).toFile(file);
  console.log(`  ${path.relative(process.cwd(), file)}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}
