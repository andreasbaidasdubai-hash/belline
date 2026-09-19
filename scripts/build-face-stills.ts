/**
 * A committed still for every curated video face.
 *
 *   node --import tsx scripts/build-face-stills.ts
 *
 * Writes square JPEGs to public/video/faces/, one per id in
 * src/lib/video/faces.ts `CURATED_FACES`, so the face picker shows faces the
 * moment the page renders — before, and without, any call to Tavus. Until now
 * the picker waited on `GET /v2/faces` for its thumbnails and showed a letter
 * in a circle when Tavus was slow, unreachable, or simply not configured
 * (the mock, a review deployment). A shipped file has none of those moods.
 *
 * The sources are Tavus's own published preview images for the stock faces,
 * from the stock face model map
 * (https://docs.tavus.io/sections/faces/stock-face-model-map) — the same
 * pictures the ids are chosen from. Tavus's live `thumbnail_image_url` still
 * wins at runtime where it is available: this is the floor, not the ceiling.
 *
 * Re-run it after changing `CURATED_FACES` and commit what it writes;
 * `check:video` fails if a curated face has no still.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { CURATED_FACES, faceStillPath } from "../src/lib/video/faces";

const OUT = path.join(process.cwd(), "public", "video", "faces");
const SIZE = 512;

/**
 * Where each still comes from, by face id. Addresses are copied from the
 * published model map's `<img src>`; the digest in the path is Tavus's, and a
 * changed digest means a re-copy rather than a guess.
 */
const SOURCES: Record<string, string> = {
  rf90eb925bd8:
    "https://mintcdn.com/tavus/gbHjR9iJ03C32KC_/images/stock-faces/rf90eb925bd8.jpg?fit=max&auto=format&n=gbHjR9iJ03C32KC_&q=85&s=6d37960444cc7ab4665ec79ea2d68399",
  r4dc9377a68e:
    "https://mintcdn.com/tavus/gbHjR9iJ03C32KC_/images/stock-faces/r4dc9377a68e.jpg?fit=max&auto=format&n=gbHjR9iJ03C32KC_&q=85&s=4ac92ade421482f5d3fe874cefb78af1",
  r340d93adc9b:
    "https://mintcdn.com/tavus/gbHjR9iJ03C32KC_/images/stock-faces/r340d93adc9b.jpg?fit=max&auto=format&n=gbHjR9iJ03C32KC_&q=85&s=a861e567db862b602395891fc2c467bf",
  r51b323e761e:
    "https://mintcdn.com/tavus/gbHjR9iJ03C32KC_/images/stock-faces/r51b323e761e.jpg?fit=max&auto=format&n=gbHjR9iJ03C32KC_&q=85&s=f83fb081901e648cb7e775a2fae1bf6c",
  rca764a6a197:
    "https://mintcdn.com/tavus/gbHjR9iJ03C32KC_/images/stock-faces/rca764a6a197.jpg?fit=max&auto=format&n=gbHjR9iJ03C32KC_&q=85&s=c512d16171a8b6d8766ad86750825f3a",
  rbb3d627a705:
    "https://mintcdn.com/tavus/gbHjR9iJ03C32KC_/images/stock-faces/rbb3d627a705.jpg?fit=max&auto=format&n=gbHjR9iJ03C32KC_&q=85&s=2fdf27ead0c960c548d77c3a0f116b17",
  rf1bd7e252de:
    "https://mintcdn.com/tavus/gbHjR9iJ03C32KC_/images/stock-faces/rf1bd7e252de.jpg?fit=max&auto=format&n=gbHjR9iJ03C32KC_&q=85&s=4751d9a4fbb9fdbed2b64c509f4f5a7f",
  rb1d65103218:
    "https://mintcdn.com/tavus/dwmLqbtIIsjxhvN1/images/stock-faces/rb1d65103218.jpg?fit=max&auto=format&n=dwmLqbtIIsjxhvN1&q=85&s=69de2298b8939040b983bf312aa6b591",
};

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  let written = 0;
  for (const face of CURATED_FACES) {
    const src = SOURCES[face.id];
    if (!src) {
      console.error(`  no source for ${face.name} (${face.id}) — add one above`);
      process.exitCode = 1;
      continue;
    }
    const res = await fetch(src);
    if (!res.ok) {
      console.error(`  ${face.id}: HTTP ${res.status}`);
      process.exitCode = 1;
      continue;
    }
    const input = Buffer.from(await res.arrayBuffer());
    // The previews are 16:9 and the picker's thumbnails are circles, so a
    // square has to come out of them. Dead centre, not `strategy.attention`:
    // the salience crop put a doorway where Ruby's face is and a plant where
    // Rose's is, because a bright corner is more "interesting" to it than a
    // person. These faces are framed centrally, so centrally is where to cut.
    const out = path.join(OUT, path.basename(faceStillPath(face.id)));
    await sharp(input)
      .resize(SIZE, SIZE, { fit: "cover", position: "centre" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(out);
    written += 1;
    console.log(`  ${face.name.padEnd(18)} ${path.relative(process.cwd(), out)}`);
  }
  console.log(`${written} still${written === 1 ? "" : "s"} in ${path.relative(process.cwd(), OUT)}`);
}

await main();
