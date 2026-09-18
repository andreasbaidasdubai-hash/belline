import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test as base, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { blockExternal } from "../tests/selfserve/helpers";

/**
 * Belle starts talking on the tap.
 *
 * The thing being tested is a join between two videos: a pre-rendered clip of
 * the same face, played out of the visitor's own tap, and the live session
 * connecting underneath it. Three properties matter and all three are easy to
 * break by accident, which is why they are pinned here rather than left to the
 * source greps in `check:video`:
 *
 *   **One greeting.** The clip says hello, so the live session must not. The
 *   session's own reply carries the greeting it was created with, so the test
 *   reads it off the wire rather than guessing from the captions.
 *
 *   **No jump cut.** The live face may not appear while the clip is still
 *   speaking, however quickly the session connects.
 *
 *   **The fallback is the old behaviour, exactly.** With the clip gone — a
 *   404, which is the realest version of "it failed" — the greeting comes back
 *   whole and the call runs as it always did.
 *
 * It also prints tap-to-first-word at both widths. A number from the mock
 * provider is not the number a visitor gets (there is no Tavus room to join),
 * so it is reported and never asserted: what it is good for is catching the
 * day the clip stops starting on the tap.
 *
 * Reduced motion is forced for the rest of this suite, and the clip is hidden
 * under it by design (`greeting.ts`: she only speaks if she can be seen), so
 * these tests ask for `no-preference` explicitly.
 *
 *   npx playwright test --config playwright.video.config.ts greeting-clip
 */

const KEY = "be_belline_site";
const SHOTS = process.env.VIDEO_SHOTS_DIR;
const CLIP = "/video/greeting-rf90eb925bd8.mp4";

const test = base.extend<{ aborted: unknown }>({
  aborted: [
    async ({ context }: { context: BrowserContext }, use: (value: unknown) => Promise<void>) => {
      const aborted = await blockExternal(context);
      await context.addInitScript(() => {
        const hide = () => {
          if (document.getElementById("hide-next-dev")) return;
          const style = document.createElement("style");
          style.id = "hide-next-dev";
          style.textContent = "nextjs-portal{display:none!important}";
          (document.head || document.documentElement).appendChild(style);
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hide);
        else hide();
      });
      await use(aborted);
      // The clip is ours, from our own origin. Nothing here may reach the provider.
      expect(aborted.filter((a) => /tavus|daily\.co/.test(a.url))).toEqual([]);
    },
    { auto: true },
  ],
});

// The clip is motion, and the panel hides it under `prefers-reduced-motion`.
test.use({ reducedMotion: "no-preference" });

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${info.project.name}-${name}.png`) });
}

async function openPanel(page: Page) {
  await page.goto(`/embed/${KEY}/video?o=${encodeURIComponent("http://localhost:4321")}`, { referer: "http://localhost:4321/" });
  await expect(page.getByRole("heading", { name: /Talk face to face with Belle/ })).toBeVisible();
}

const clipEl = (page: Page) => page.locator("video.bv-preview-clip");
const faceEl = (page: Page) => page.locator("video.bv-face");

/** Catch the session the tap creates, and the greeting it was made with. */
function sessionGreeting(page: Page): Promise<string> {
  return page
    .waitForResponse((r) => r.url().endsWith(`/api/video/${KEY}/session`) && r.request().method() === "POST")
    .then(async (res) => ((await res.json()) as { session?: { greeting?: string } }).session?.greeting ?? "");
}

// ---------------------------------------------------------------------------

test("the clip is the same face, ours to serve, and waiting before the tap", async ({ page }, info) => {
  await openPanel(page);
  const clip = clipEl(page);
  await expect(clip).toBeVisible();
  // Our own origin, not the provider's CDN.
  await expect(clip).toHaveAttribute("src", CLIP);
  // Resting: silent and looping, as it has always been.
  expect(await clip.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  expect(await clip.evaluate((v: HTMLVideoElement) => v.loop)).toBe(true);
  // Inline, or a phone plays it full screen over the page.
  expect(await clip.evaluate((v: HTMLVideoElement) => v.playsInline)).toBe(true);
  // A poster under it, so the circle is her face and not a blank square even
  // before a frame has decoded.
  await expect(clip).toHaveAttribute("poster", /\/video\/greeting-.*\.jpg$/);
  // Buffered before anybody taps: that is what makes the first word instant.
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await shot(page, info, "20-greeting-clip-first-frame");
});

test("the tap gives her a voice, and the live session then does not say hello twice", async ({ page }, info) => {
  await openPanel(page);
  const clip = clipEl(page);
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);

  const greeting = sessionGreeting(page);
  const tappedAt = Date.now();
  await page.getByRole("button", { name: "Start video call" }).click();

  // Unmuted, from the top, and no longer looping: these are her opening words now.
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.muted), { timeout: 5_000 }).toBe(false);
  expect(await clip.evaluate((v: HTMLVideoElement) => v.loop)).toBe(false);
  expect(await clip.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  // The pill agrees with the picture: she is visibly talking, so it does not
  // say "Connecting…" underneath her.
  await expect(page.locator(".bv-status")).toHaveText(/Belle is speaking/);
  const firstWordMs = Date.now() - tappedAt;
  console.log(`[greeting] ${info.project.name}: tap to first word ${firstWordMs} ms (clip, mock provider)`);
  info.annotations.push({ type: "tap-to-first-word-ms", description: String(firstWordMs) });

  // The live session was told she has already been heard, so it drops its own
  // hello and keeps everything after it. Belline's greeting introduces the
  // product in its second sentence, and that must survive.
  const said = await greeting;
  expect(said).not.toMatch(/^Hi, I'm Belle/);
  expect(said).toMatch(/Belline answers your business's calls/);

  await shot(page, info, "21-greeting-speaking");
});

/**
 * The handover, as far as this harness can see it.
 *
 * The mock provider never attaches a stream, so `video.bv-face` never paints
 * and never earns `is-on` — which means the cross-fade itself cannot be
 * watched here, and `check:video` pins it from the source instead. What *can*
 * be watched is the half that matters most and would be silent if it broke:
 * the live face is held back for exactly as long as she is speaking, and the
 * hold then lets go on its own.
 */
test("the live face is held while she speaks, and the hold lets go by itself", async ({ page }) => {
  await openPanel(page);
  const clip = clipEl(page);
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Start video call" }).click();
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.muted), { timeout: 5_000 }).toBe(false);

  const duration = await clip.evaluate((v: HTMLVideoElement) => v.duration);
  expect(duration).toBeGreaterThan(1);

  // While she is talking the face is held back, however fast the session came
  // up. This is the jump cut, and it must not happen.
  await expect(faceEl(page)).not.toHaveClass(/is-on/);
  await expect(clip).toBeVisible();
  await expect(clip).not.toHaveClass(/is-gone/);
  await expect(page.locator(".bv-status")).toHaveText(/Belle is speaking/);

  // Her last word releases it: the panel stops calling her the speaker and the
  // call is the live one underneath. Nothing had to be pressed.
  await expect(page.locator(".bv-status")).toHaveText(/Belle is listening/, { timeout: (duration + 8) * 1000 });
  await expect(page.getByRole("button", { name: "End call" })).toBeVisible();

  // "Start again" is a whole new opening, clip and all: the element is still
  // there to speak with, which is why it is faded rather than unmounted.
  await page.getByRole("button", { name: "End call" }).click();
  await page.getByRole("button", { name: "Start again" }).click();
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.muted), { timeout: 5_000 }).toBe(false);
  await expect(clip).not.toHaveClass(/is-gone/);
});

test("no clip, no change: a greeting that cannot load leaves the call exactly as it was", async ({ page }) => {
  // The realest version of "the clip is missing": the file 404s.
  await page.route(`**${CLIP}`, (route) => route.fulfill({ status: 404, body: "" }));
  await openPanel(page);

  const greeting = sessionGreeting(page);
  await page.getByRole("button", { name: "Start video call" }).click();

  // The whole greeting, with its hello: nobody heard one.
  expect(await greeting).toMatch(/^Hi, I'm Belle, Belline's AI concierge\./);
  // Nothing was unmuted, and nothing waited for a clip that never loaded: the
  // call reaches its live state as directly as it always did.
  expect(await clipEl(page).evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await expect(page.getByRole("button", { name: "End call" })).toBeVisible();
  await expect(page.locator(".bv-status")).toHaveText(/Belle is listening/, { timeout: 15_000 });
});

test("under reduced motion she does not speak from a face nobody can see", async ({ browser, baseURL }) => {
  // The panel hides the clip under reduced motion. A voice with no face is
  // worse than the wait, so the greeting stands down and stays whole.
  const context = await browser.newContext({ baseURL, reducedMotion: "reduce", permissions: ["microphone"] });
  const page = await context.newPage();
  try {
    await openPanel(page);
    const greeting = sessionGreeting(page);
    await page.getByRole("button", { name: "Start video call" }).click();
    expect(await greeting).toMatch(/^Hi, I'm Belle, Belline's AI concierge\./);
    expect(await clipEl(page).evaluate((v: HTMLVideoElement) => v.muted).catch(() => true)).toBe(true);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// The website bubble: the one surface where the tap is in another origin's page.

/** A venue's own page on :3000 with the widget — the same one `video.spec.ts` serves. */
function venueSite(appOrigin: string): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
          `<body style="margin:0;font-family:sans-serif"><h1 style="padding:24px">A venue's website</h1>` +
          `<script src="${appOrigin}/embed.js" data-belline="${KEY}" data-mode="chat" async></script></body></html>`,
      );
    });
    server.once("error", () => resolve(null));
    server.listen(3000, "localhost", () => resolve(server));
  });
}

test("in the bubble the page speaks, because the frame cannot borrow its tap", async ({ page, baseURL }, info) => {
  const server = await venueSite(baseURL!);
  test.skip(!server, "localhost:3000 is taken on this machine");
  try {
    await page.goto("http://localhost:3000/");
    const bubble = page.locator(".bvb");
    await expect(bubble).toBeVisible();
    const clip = bubble.locator("video.bvb-media");
    await expect(clip).toBeVisible();
    await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    expect(await clip.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
    await shot(page, info, "22-bubble-clip-first-frame");

    const greeting = sessionGreeting(page);
    await bubble.getByRole("button", { name: "Talk to Belle", exact: true }).click();

    // The sound comes out of the venue's own page — the gesture is there, and a
    // cross-origin frame cannot have it. This is the mobile Safari case.
    await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.muted), { timeout: 5_000 }).toBe(false);
    expect(await clip.evaluate((v: HTMLVideoElement) => v.loop)).toBe(false);

    // The frame is told how long she will be, in its URL, before its first render.
    await expect(page.locator("iframe.bvb-frame")).toHaveAttribute("src", /[?&]greeting=\d+/);
    // And the session it creates does not greet her audience a second time.
    expect(await greeting).not.toMatch(/^Hi, I'm Belle/);
  } finally {
    server?.close();
  }
});
