/**
 * Make the video bubble's greeting clip, once, with Tavus's video generation.
 *
 * OWNER-RUN ONLY. It spends Tavus credits, so it never runs in the checks, on
 * boot or on deploy, and it refuses to run without `--yes`.
 *
 *   node --import tsx --env-file=.env scripts/video-greeting-clip.ts \
 *     --agent Belle --business Belline --yes [--download public/video]
 *
 * What it does, per the current API (docs.tavus.io/api-reference, "Generate
 * Video" and "Get Video"):
 *
 *   1. POST https://tavusapi.com/v2/videos  { replica_id: TAVUS_FACE_ID, script, video_name }
 *      (`replica_id` is the face id; that endpoint still takes the old name.)
 *   2. GET /v2/videos/{video_id} every 15 s until `status` is `ready` or `error`.
 *   3. Prints `download_url`, `stream_url` and `still_image_thumbnail_url`, and with
 *      `--download <dir>` saves `greeting-<face>.mp4` and `greeting-<face>.jpg` there.
 *
 * **The clip for `rf90eb925bd8` is already made and committed**, and is the
 * default (`src/lib/video/config.ts`). This is only for a deployment on another
 * face. The words are `GREETING_CLIP_SCRIPT` and are not a choice: the live
 * greeting is shortened against them (`src/lib/video/greeting-clip.ts`).
 *
 * Afterwards, and this matters — the visitor hears this file on a tap, so it
 * has to be ready before one:
 *
 *   1. Re-encode small. 640×360 is ample for a circle:
 *      `ffmpeg -i in.mp4 -vf scale=640:360 -c:v libx264 -crf 26 -preset slow \
 *         -c:a aac -b:a 64k -ac 1 -movflags +faststart out.mp4`
 *      (1.2 MB → ~110 KB, and `+faststart` is what lets it play before it has
 *      finished downloading).
 *   2. Take the poster from the clip's **own last frame**, not from Tavus's
 *      thumbnail: `ffmpeg -sseof -0.12 -i out.mp4 -update 1 -frames:v 1 out.jpg`.
 *      That frame is the one held during the handover and the one the resting
 *      bubble shows, so there is nothing to flash, and it is the only frame
 *      where she is neither mid-word nor mid-blink.
 *   3. Commit both under `public/video/` and point VIDEO_GREETING_CLIP_URL and
 *      VIDEO_GREETING_POSTER_URL at them (or leave them for the defaults).
 */

import fs from "node:fs";
import path from "node:path";
import { GREETING_CLIP_SCRIPT } from "../src/lib/video/greeting-clip";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const apiKey = (process.env.TAVUS_API_KEY ?? "").trim();
const faceId = (value("face") || process.env.TAVUS_FACE_ID || "").trim();
const agent = value("agent", "Belle");
const business = value("business", "Belline");
// The words belong to the product, not to this script: `GREETING_CLIP_SCRIPT`
// is what the app assumes has been said, what the live greeting is shortened
// against, and what `check:video` pins. Regenerating for another face has to
// reproduce it exactly, so it is the default rather than something to remember.
const script = value("script") || GREETING_CLIP_SCRIPT;
const base = (process.env.TAVUS_API_BASE ?? "https://tavusapi.com").replace(/\/+$/, "");
const downloadDir = value("download");

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (process.env.FLAG_STUBS === "on") fail("Refusing to run under FLAG_STUBS=on: this calls the real Tavus API.");
if (!apiKey) fail("TAVUS_API_KEY is not set.");
if (!faceId) fail("No face: set TAVUS_FACE_ID or pass --face <id>.");
if (!flag("yes")) {
  console.log(`
  This generates a video with Tavus and uses credits on the account.

    face:   ${faceId}
    script: "${script}"

  Run again with --yes to go ahead.
`);
  process.exit(0);
}

async function tavus<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { "x-api-key": apiKey, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) fail(`Tavus ${method} ${route} failed with ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function save(url: string, file: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) fail(`Download failed with ${res.status}: ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`  saved ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}

type Video = {
  video_id?: string;
  status?: string;
  download_url?: string;
  stream_url?: string;
  hosted_url?: string;
  still_image_thumbnail_url?: string;
  error_details?: string;
};

const created = await tavus<Video>("POST", "/v2/videos", {
  replica_id: faceId,
  script,
  video_name: `belline-greeting-${faceId}`,
});
if (!created.video_id) fail("Tavus returned no video_id.");
console.log(`  generating ${created.video_id} …`);

const deadline = Date.now() + 30 * 60 * 1000;
let video: Video = created;
while (video.status !== "ready") {
  if (video.status === "error") fail(`Tavus could not make the video: ${video.error_details ?? "no details"}`);
  if (Date.now() > deadline) fail(`Still not ready after 30 minutes. Check ${created.video_id} in the Tavus dashboard.`);
  await new Promise((r) => setTimeout(r, 15_000));
  video = await tavus<Video>("GET", `/v2/videos/${encodeURIComponent(created.video_id)}?verbose=true`);
  console.log(`  ${video.status}`);
}

console.log(`
  ready: ${created.video_id}
  download_url:              ${video.download_url ?? "—"}
  stream_url:                ${video.stream_url ?? "—"}
  still_image_thumbnail_url: ${video.still_image_thumbnail_url ?? "—"}
`);

if (downloadDir) {
  if (video.download_url) await save(video.download_url, path.join(downloadDir, `greeting-${faceId}.mp4`));
  if (video.still_image_thumbnail_url) await save(video.still_image_thumbnail_url, path.join(downloadDir, `greeting-${faceId}.jpg`));
  console.log(`
  Next: serve them, then set
    VIDEO_GREETING_CLIP_URL=/video/greeting-${faceId}.mp4
    VIDEO_GREETING_POSTER_URL=/video/greeting-${faceId}.jpg
  (paths work when the files are in public/video; otherwise use their https URLs).
  Check the clip's size first: re-encode to a few hundred KB if it is large.
`);
}
