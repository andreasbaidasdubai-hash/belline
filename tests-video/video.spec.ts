import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test as base, type BrowserContext, type FrameLocator, type Locator, type Page, type TestInfo } from "@playwright/test";
import { blockExternal } from "../tests/selfserve/helpers";

/**
 * The video receptionist in a browser, against the mock provider.
 *
 * The greeting bubble on a venue's page and on belline.ai (open on load, no
 * session until a tap, dismissal remembered, lined up with the other buttons),
 * and the call view's states at 1280 and 390×844: microphone accepted and
 * refused, mute, captions, a lead through the model route, the warning and the
 * end, a failed start and its retry, the connection dropping, chat, a person.
 *
 * Microphone: the fake device is granted by a launch flag (headless Chromium on
 * Windows answers NotSupportedError otherwise). The refusal case replaces
 * getUserMedia with one that rejects exactly as a refused prompt does.
 *
 *   npx playwright test --config playwright.video.config.ts
 */

const KEY = "be_belline_site";
const SHOTS = process.env.VIDEO_SHOTS_DIR;
const DATA = process.env.VIDEO_DATA_DIR ?? "";
const ROOT = process.cwd();
/** The circle's grow, and the frame fading in over it, before a screenshot. */
const GROW_SETTLE_MS = 700;

const test = base.extend<{ aborted: unknown }>({
  aborted: [
    async ({ context }: { context: BrowserContext }, use: (value: unknown) => Promise<void>) => {
      const aborted = await blockExternal(context);
      // Screenshots are of the product, not of Next's dev-mode badge.
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
      expect(aborted.filter((a) => /tavus|daily\.co/.test(a.url))).toEqual([]);
    },
    { auto: true },
  ],
});

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${info.project.name}-${name}.png`) });
}

const alertIn = (page: Page) => page.locator(".bv-error, .bv-warning");

async function openPanel(page: Page) {
  await page.goto(`/embed/${KEY}/video?o=${encodeURIComponent("http://localhost:4321")}`, { referer: "http://localhost:4321/" });
  await expect(page.getByRole("heading", { name: /Talk face to face with Belle/ })).toBeVisible();
}

async function refuseMic(context: BrowserContext) {
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
}

async function startCall(page: Page) {
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/video/${KEY}/session`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Start video call" }).click();
  const res = await created;
  const body = (await res.json()) as { session: { sessionId: string; clientToken: string; greeting: string } };
  await expect(page.getByText("MOCK — not a live avatar")).toBeVisible();
  await expect(page.getByRole("button", { name: "End call" })).toBeVisible();
  expect(body.session.greeting).toMatch(/^Hi, I'm Belle, Belline's AI concierge\./);
  return body.session;
}

/** Captions are off until asked for: on, through the "…" menu. */
async function captionsOn(scope: Page | FrameLocator) {
  await scope.getByRole("button", { name: "More options" }).click();
  await scope.getByRole("menuitemcheckbox", { name: /Captions/ }).click();
}
function noHorizontalScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "element has no box").not.toBeNull();
  return b!;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Poll the mock relay until the session reports ended (410). */
async function expectEnded(page: Page, baseURL: string, session: { sessionId: string; clientToken: string }) {
  await expect
    .poll(async () =>
      (
        await page.request.post(`${baseURL}/api/video/${KEY}/mock`, {
          data: { sessionId: session.sessionId, clientToken: session.clientToken, text: "hello?" },
        })
      ).status(),
    )
    .toBe(410);
}

// ---------------------------------------------------------------------------
// The call view

test("the intro explains the microphone before anything is asked, and nothing is created on open", async ({ page }, info) => {
  const sessions: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/session") && r.method() === "POST") sessions.push(r.url());
  });
  await openPanel(page);
  await expect(page.getByText(/your browser will ask to use your microphone/)).toBeVisible();
  await expect(page.getByText(/Your camera stays off/)).toBeVisible();
  await expect(page.getByText("Calls end after 45 seconds.")).toBeVisible();
  await expect(page.getByText("AI concierge", { exact: true })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  const line = await box(page.getByText("Calls end after 45 seconds."));
  expect(line.y + line.height).toBeLessThanOrEqual(page.viewportSize()!.height - 16);
  await shot(page, info, "01-intro");
  await page.waitForTimeout(500);
  expect(sessions).toEqual([]);
});

test("microphone accepted: the round call view, mute, captions, a lead through the model route, then end", async ({ page, baseURL }, info) => {
  await openPanel(page);
  const session = await startCall(page);
  await expect(page.locator(".bv-status")).toHaveText(/Belle is (speaking|listening)/);
  await expect(page.locator(".bv-circle")).toHaveCSS("border-radius", "50%");
  await expect(page.locator(".bv-top")).toHaveCount(0);

  // Two main controls, equal, big enough to hit, centred; the small menu beside them.
  const viewport = page.viewportSize()!;
  const [mute, endBtn] = await Promise.all(["Mute microphone", "End call"].map((name) => box(page.getByRole("button", { name }))));
  expect(Math.round(mute.width)).toBe(Math.round(endBtn.width));
  expect(Math.round(mute.height)).toBe(Math.round(endBtn.height));
  expect(mute.height).toBeGreaterThanOrEqual(44);
  expect(endBtn.y + endBtn.height).toBeLessThanOrEqual(viewport.height);
  const pairCentre = (mute.x + endBtn.x + endBtn.width) / 2;
  expect(Math.abs(pairCentre - viewport.width / 2)).toBeLessThanOrEqual(4);
  await expect(page.getByRole("button", { name: "More options" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Type instead" })).toBeVisible();
  // Nothing else in the row: no captions or person buttons until the menu.
  await expect(page.getByRole("button", { name: /captions/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Talk to a person" })).toHaveCount(0);
  await expect(page.locator(".bv-caption")).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, info, "02-call-view");

  await page.getByRole("button", { name: "Mute microphone" }).click();
  await expect(page.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".bv-status")).toHaveText(/muted|Belle is speaking/);
  await shot(page, info, "03-muted");
  await page.getByRole("button", { name: "Unmute microphone" }).click();

  await captionsOn(page);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByLabel(/Say something/).fill("My name is Dana Reed, I run a salon called Glow Studio, email dana.video@glow.example");
  await page.getByRole("button", { name: "Say", exact: true }).click();
  await expect(page.locator(".bv-caption")).toHaveCount(1);
  await expect(page.locator(".bv-caption")).toHaveText(/^(You|Belle): /);
  const line = await box(page.locator(".bv-caption"));
  expect(line.height, "one line, not a box of text").toBeLessThanOrEqual(26);
  await shot(page, info, "04-lead-caption");
  await expect
    .poll(() => {
      try {
        const leads = JSON.parse(fs.readFileSync(path.join(DATA, "leads.json"), "utf8")) as { email?: string }[];
        return leads.some((l) => l.email === "dana.video@glow.example");
      } catch {
        return false;
      }
    })
    .toBe(true);

  await page.getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Captions/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemcheckbox", { name: /Captions/ }).click();
  await expect(page.locator(".bv-caption")).toHaveCount(0);

  await page.getByRole("button", { name: "End call" }).click();
  await expect(page.getByText(/The call has ended/)).toBeVisible();
  await shot(page, info, "05-ended");
  await expectEnded(page, baseURL!, session);
});

test("the controls stay clear of each other at 320px", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone-390", "a phone-width case");
  await page.setViewportSize({ width: 320, height: 640 });
  await openPanel(page);
  await startCall(page);
  expect(await noHorizontalScroll(page)).toBe(true);
  const boxes = await Promise.all(["Mute microphone", "End call", "More options"].map((name) => box(page.getByRole("button", { name }))));
  for (let i = 0; i < boxes.length; i++) {
    expect(boxes[i].x).toBeGreaterThanOrEqual(0);
    expect(boxes[i].x + boxes[i].width).toBeLessThanOrEqual(320);
    for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
  }
  await shot(page, info, "02b-call-view-320");
  await page.getByRole("button", { name: "End call" }).click();
});
test("microphone refused: an explanation, the chat offered, and a session made beside the prompt is ended at once", async ({ page, context, baseURL }, info) => {
  await refuseMic(context);
  const created: { sessionId: string; clientToken: string }[] = [];
  page.on("response", async (r) => {
    if (r.url().endsWith(`/api/video/${KEY}/session`) && r.request().method() === "POST" && r.ok()) {
      created.push(((await r.json()) as { session: { sessionId: string; clientToken: string } }).session);
    }
  });
  await openPanel(page);
  await page.getByRole("button", { name: "Start video call" }).click();
  await expect(alertIn(page)).toContainText("Your microphone is blocked");
  await expect(page.getByRole("button", { name: "Chat instead" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Voice call" })).toBeVisible();
  await shot(page, info, "06-mic-denied");
  // The session starts beside the prompt to save the wait; a refusal ends it.
  await page.waitForTimeout(1500);
  expect(created.length).toBeLessThanOrEqual(1);
  for (const session of created) await expectEnded(page, baseURL!, session);
});
test("a double click starts one session", async ({ page }) => {
  await openPanel(page);
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith(`/api/video/${KEY}/session`) && r.method() === "POST") posts.push(r.url());
  });
  await page.getByRole("button", { name: "Start video call" }).dblclick();
  await expect(page.getByRole("button", { name: "End call" })).toBeVisible();
  await page.waitForTimeout(800);
  expect(posts.length).toBe(1);
  await page.getByRole("button", { name: "End call" }).click();
});

test("a failed start offers chat, voice and a retry that works", async ({ page }, info) => {
  await openPanel(page);
  await page.route(`**/api/video/${KEY}/session`, (route) => route.abort("failed"), { times: 1 });
  await page.getByRole("button", { name: "Start video call" }).click();
  await expect(alertIn(page)).toContainText("The connection dropped");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat instead" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Voice call" })).toBeVisible();
  await shot(page, info, "07-start-failed");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "End call" })).toBeVisible();
  await page.getByRole("button", { name: "End call" }).click();
});

test("the connection drops mid-call: reconnecting is said in words, and the call carries on after", async ({ page, context }, info) => {
  await openPanel(page);
  await startCall(page);
  await context.setOffline(true);
  await page.getByLabel(/Say something/).fill("Are you there?");
  await page.getByRole("button", { name: "Say", exact: true }).click();
  await expect(page.locator(".bv-status")).toHaveText("Reconnecting…");
  await shot(page, info, "08-reconnecting");
  await context.setOffline(false);
  await page.getByLabel(/Say something/).fill("What do you do?");
  await page.getByRole("button", { name: "Say", exact: true }).click();
  await expect(page.locator(".bv-status")).toHaveText(/Belle is (speaking|listening)/);
  await page.getByRole("button", { name: "End call" }).click();
});

test("the warning comes before the limit, then the call ends cleanly", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1280", "the timing is the same at every width");
  await openPanel(page);
  await startCall(page);
  // VIDEO_MAX_CALL_SECONDS=45, VIDEO_WARN_BEFORE_SECONDS=20.
  await expect(page.locator(".bv-warning")).toContainText(/seconds left/, { timeout: 40_000 });
  await shot(page, info, "09-warning");
  await expect(page.getByText(/The call has ended/)).toBeVisible({ timeout: 40_000 });
});

test("switching to chat ends the call and opens the chat", async ({ page, baseURL }) => {
  await openPanel(page);
  const session = await startCall(page);
  await page.getByRole("button", { name: "Type instead" }).click();
  await expect(page).toHaveURL(new RegExp(`/embed/${KEY}/chat`));
  await expectEnded(page, baseURL!, session);
});

test("talk to a person: the panel says what happens next", async ({ page }, info) => {
  await openPanel(page);
  await startCall(page);
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Talk to a person" }).click();
  await expect(page.getByText(/will take your details so someone from the team can get back to you/)).toBeVisible();
  await shot(page, info, "10-person");
  await page.getByRole("button", { name: "End call" }).click();
});

test("voice still works: the spoken demo page loads its call as before", async ({ page }) => {
  await page.goto("/call");
  await expect(page.locator("body")).not.toContainText("Application error");
  await expect(page.getByRole("button").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// The greeting bubble, on pages that are not ours to style

function listen(port: number, handler: http.RequestListener): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.once("error", () => resolve(null));
    server.listen(port, "localhost", () => resolve(server));
  });
}

/** A venue's website with the widget (localhost:3000 is on Belline's venue's list). */
function venueSite(appOrigin: string) {
  return listen(3000, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
        `<body style="margin:0;font-family:sans-serif"><h1 style="padding:24px">A venue's website</h1>` +
        `<script src="${appOrigin}/embed.js" data-belline="${KEY}" data-mode="chat" async></script></body></html>`,
    );
  });
}

/** belline.ai's landing page from public/, pointed at this app instead of production (localhost:4321 is allowed). */
function landingSite(appOrigin: string) {
  const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
  return listen(4321, (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost:4321");
    const rel = url.pathname === "/" ? "landing.html" : url.pathname.slice(1);
    const file = path.join(ROOT, "public", rel);
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(file);
    let body: Buffer | string = fs.readFileSync(file);
    if (ext === ".html" || ext === ".js") body = body.toString("utf8").split("https://app.belline.ai").join(appOrigin);
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
    res.end(body);
  });
}

function countSessionPosts(context: BrowserContext): string[] {
  const posts: string[] = [];
  context.on("request", (r) => {
    if (/\/api\/video\/[^/]+\/session$/.test(r.url()) && r.method() === "POST") posts.push(r.url());
  });
  return posts;
}

/** The call frame inside the bubble, once it has loaded. */
function bubbleFrame(page: Page) {
  return page.frameLocator(".bvb iframe.bvb-frame");
}

/** Block the face's voice the way an autoplay policy does, in every frame, until `__allowAudio`. */
async function blockAudio(context: BrowserContext) {
  await context.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (this instanceof HTMLAudioElement && !(window as unknown as { __allowAudio?: boolean }).__allowAudio) {
        return Promise.reject(new DOMException("play() failed because the user didn't interact with the document first.", "NotAllowedError"));
      }
      return play.call(this);
    };
  });
}

async function expectInCall(page: Page) {
  const bubble = page.locator(".bvb");
  await expect(bubble).toHaveAttribute("data-state", "call");
  const frame = bubbleFrame(page);
  await expect(frame.getByRole("button", { name: "End call" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Mute microphone" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "More options" })).toBeVisible();
  await expect(frame.locator(".bv-status")).toHaveText(/Belle is (speaking|listening)/);
  // The call happens in the circle: no separate panel, no header.
  await expect(page.locator("iframe.belline-panel, .video-dock, .video-frame")).toHaveCount(0);
  await expect(frame.locator(".bv-top")).toHaveCount(0);
  await expect(bubble.getByText("AI concierge", { exact: true })).toBeVisible();
  await expect(frame.locator(".bv-time")).toBeVisible();
  // Grown in place to the call size, inside the screen.
  const viewport = page.viewportSize()!;
  const circle = await box(bubble.locator(".bvb-circle"));
  const iframe = await box(bubble.locator("iframe.bvb-frame"));
  if (viewport.width <= 520) {
    expect(circle.width).toBeGreaterThanOrEqual(236);
    expect(circle.width).toBeLessThanOrEqual(262);
  } else {
    expect(circle.width).toBeGreaterThanOrEqual(296);
    expect(circle.width).toBeLessThanOrEqual(344);
  }
  expect(Math.abs(iframe.width - circle.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(iframe.x - circle.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(iframe.y - circle.y)).toBeLessThanOrEqual(1);
  expect(iframe.x).toBeGreaterThanOrEqual(0);
  expect(iframe.x + iframe.width).toBeLessThanOrEqual(viewport.width);
  expect(iframe.y).toBeGreaterThanOrEqual(0);
  expect(iframe.y + iframe.height).toBeLessThanOrEqual(viewport.height);
  expect(await noHorizontalScroll(page)).toBe(true);
}

test("on a venue's page: the bubble greets with no session, a tap grows it into the call, × ends it, and it stays small", async ({ page, context, baseURL }, info) => {
  const server = await venueSite(baseURL!);
  test.skip(!server, "localhost:3000 is taken on this machine");
  const posts = countSessionPosts(context);
  try {
    await page.goto("http://localhost:3000/");
    const bubble = page.locator(".bvb");
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveAttribute("data-state", "rest");
    await expect(bubble.getByText("AI concierge", { exact: true })).toBeVisible();
    await expect(bubble.getByText("MOCK — not a live avatar")).toBeVisible();
    const viewport = page.viewportSize()!;
    if (viewport.width <= 900) await expect(bubble.locator(".bvb-caption")).toBeHidden();
    else await expect(bubble.getByText("Hi, I'm Belle — tap to talk")).toBeVisible();
    await page.waitForTimeout(2500);
    expect(posts, "a live session was created on page load").toEqual([]);

    // The launcher's own buttons fold into the one secondary button.
    await expect(page.locator(".belline-fab").filter({ visible: true })).toHaveCount(0);
    const more = bubble.getByRole("button", { name: "Other ways to reach us" });
    await expect(more).toBeVisible();
    const b = await box(bubble.locator(".bvb-circle"));
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.width).toBeGreaterThanOrEqual(viewport.width <= 520 ? 128 : 180);
    expect(b.width).toBeLessThanOrEqual(viewport.width <= 520 ? 144 : 220);
    expect(overlaps(await box(more), await box(bubble.getByRole("button", { name: "Talk to Belle", exact: true })))).toBe(false);
    await shot(page, info, "11-widget-bubble-on-load");

    // One channel here (the chat), so the secondary button opens it directly.
    await more.click();
    await expect(page.locator("iframe.belline-panel")).toBeVisible();
    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(page.locator("iframe.belline-panel")).toHaveCount(0);
    await expect(bubble).toBeVisible();

    // Tap to talk: the frame inside the bubble starts the session itself.
    const created = page.waitForResponse((r) => r.url().endsWith(`/api/video/${KEY}/session`) && r.request().method() === "POST");
    await bubble.getByRole("button", { name: "Talk to Belle", exact: true }).click();
    const { session } = (await (await created).json()) as { session: { sessionId: string; clientToken: string } };
    expect(posts.length).toBe(1);
    await expectInCall(page);
    await shot(page, info, "12-widget-call-view");

    // × during the call: the session ends on the server and the bubble rests again.
    await page.getByRole("button", { name: "Close video call" }).click();
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
    await expect(bubble).toHaveAttribute("data-state", "rest");
    await expectEnded(page, baseURL!, session);

    // Met this session: small on the next page load, one tap from the greeting.
    await page.reload();
    await expect(page.locator(".bvb")).toHaveAttribute("data-state", "mini");
    await shot(page, info, "13-widget-small");
    await page.locator(".bvb-circle").click();
    await expect(page.locator(".bvb")).toHaveAttribute("data-state", "rest");
    await page.getByRole("button", { name: "Close Belle's video greeting" }).click();
    await expect(page.locator(".bvb")).toHaveAttribute("data-state", "mini");
    expect(posts.length).toBe(1);
  } finally {
    server?.close();
  }
});

test("on belline.ai: one bubble instead of three buttons, the other ways in a menu, nothing over the hero, no session on load", async ({ page, context, baseURL }, info) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  const posts = countSessionPosts(context);
  try {
    await page.goto("http://localhost:4321/");
    const bubble = page.locator(".video-bubble");
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveAttribute("data-state", "rest");
    await page.waitForTimeout(2500);
    expect(posts).toEqual([]);

    // The three floating buttons have stepped aside for the bubble.
    for (const fab of [".bell-fab", ".chat-fab", ".wa-fab"]) await expect(page.locator(fab)).toBeHidden();

    // Nothing of the bubble covers the hero's buttons, the greeting line least of all.
    const ctas = [page.locator('.hero a[data-cta="hero"]'), page.locator(".hero a[data-call]")];
    const heroBoxes = await Promise.all(ctas.map(box));
    const caption = bubble.locator(".bvb-caption");
    const viewport = page.viewportSize()!;
    if (viewport.width <= 900) await expect(caption).toBeHidden();
    else {
      await expect(caption).toBeVisible();
      const c = await box(caption);
      expect(c.x).toBeGreaterThanOrEqual(0);
      for (const h of heroBoxes) expect(overlaps(c, h), "the greeting line covers a hero button").toBe(false);
    }
    for (const h of heroBoxes) expect(overlaps(await box(bubble), h), "the bubble covers a hero button").toBe(false);
    await shot(page, info, "14-site-rest");

    // Other ways to reach us: Chat, WhatsApp, Voice call.
    const more = bubble.getByRole("button", { name: "Other ways to reach us" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = bubble.getByRole("group", { name: "Other ways to reach us" });
    await expect(menu.getByRole("button")).toHaveText(["Chat", "WhatsApp", "Voice call"]);
    const m = await box(menu);
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(overlaps(m, await box(bubble.locator(".bvb-circle"))), "the menu covers the face").toBe(false);
    await shot(page, info, "15-site-menu");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    // Chat does what the chat button did, and the bubble steps out of its way.
    await more.click();
    await menu.getByRole("button", { name: "Chat" }).click();
    await expect(page.locator(".chat-dock")).toBeVisible();
    await expect(bubble).toBeHidden();
    await page.locator(".chat-dock .call-shut").click();
    await expect(bubble).toBeVisible();

    // The call, in the circle.
    await bubble.getByRole("button", { name: "Talk to Belle", exact: true }).click();
    await expectInCall(page);
    expect(posts.length).toBe(1);
    const frame = bubbleFrame(page);
    await expect(frame.getByRole("button", { name: "Type instead" })).toBeVisible();
    await page.waitForTimeout(GROW_SETTLE_MS);
    await shot(page, info, "16-site-in-call");

    await frame.getByRole("button", { name: "More options" }).click();
    await expect(frame.getByRole("menuitem", { name: "Talk to a person" })).toBeVisible();
    await expect(frame.getByRole("menuitemcheckbox", { name: /Captions/ })).toHaveAttribute("aria-checked", "false");
    await shot(page, info, "17-site-more-menu");
    await frame.getByRole("menuitemcheckbox", { name: /Captions/ }).click();
    const line = frame.locator(".bv-caption");
    await expect(line).toHaveText(/^Belle: /);
    expect((await box(line)).height, "one line, not a box of text").toBeLessThanOrEqual(32);
    await shot(page, info, "18-site-captions");

    // Type instead: the call ends and the page's own chat opens.
    await frame.getByRole("button", { name: "Type instead" }).click();
    await expect(page.locator(".chat-dock")).toBeVisible();
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
    await page.locator(".chat-dock .call-shut").click();
    await expect(bubble).toHaveAttribute("data-state", "rest");
  } finally {
    server?.close();
  }
});

test("on belline.ai: closing during a call cleans up — session ended, frame gone, microphone stopped", async ({ page, context, baseURL }) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  const posts = countSessionPosts(context);
  const ends: string[] = [];
  context.on("request", (r) => {
    if (/\/session\/end$/.test(r.url())) ends.push(r.url());
  });
  try {
    await page.goto("http://localhost:4321/");
    const bubble = page.locator(".video-bubble");
    const created = page.waitForResponse((r) => r.url().endsWith(`/api/video/${KEY}/session`) && r.request().method() === "POST");
    await bubble.getByRole("button", { name: "Talk to Belle", exact: true }).click();
    const { session } = (await (await created).json()) as { session: { sessionId: string; clientToken: string } };
    await expectInCall(page);
    const frame = page.frames().find((f) => f.url().includes(`/embed/${KEY}/video`))!;
    await frame.evaluate(() => {
      // Watch the microphone track from inside the frame.
      const w = window as unknown as { __micStopped?: boolean };
      const stop = MediaStreamTrack.prototype.stop;
      MediaStreamTrack.prototype.stop = function (this: MediaStreamTrack) {
        if (this.kind === "audio") w.__micStopped = true;
        return stop.call(this);
      };
    });
    const stopped = frame.waitForFunction(() => (window as unknown as { __micStopped?: boolean }).__micStopped === true);
    await page.getByRole("button", { name: "Close video call" }).click();
    await stopped;
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
    await expect(bubble).toHaveAttribute("data-state", "rest");
    await expectEnded(page, baseURL!, session);
    expect(ends.length).toBeGreaterThanOrEqual(1);
    expect(posts.length).toBe(1);
  } finally {
    server?.close();
  }
});

test("on belline.ai: a blocked voice says so — Tap to hear Belle on the circle, and a tap lets it play", async ({ page, context, baseURL }, info) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  await blockAudio(context);
  try {
    await page.goto("http://localhost:4321/");
    const bubble = page.locator(".video-bubble");
    await bubble.getByRole("button", { name: "Talk to Belle", exact: true }).click();
    await expectInCall(page);
    const frame = bubbleFrame(page);
    const pill = frame.getByRole("button", { name: "Tap to hear Belle" });
    await expect(pill).toBeVisible();
    // On the circle, not beside it.
    const p = await box(pill);
    const circle = await box(bubble.locator(".bvb-circle"));
    expect(p.x).toBeGreaterThanOrEqual(circle.x);
    expect(p.x + p.width).toBeLessThanOrEqual(circle.x + circle.width);
    expect(p.y).toBeGreaterThanOrEqual(circle.y);
    expect(p.y + p.height).toBeLessThanOrEqual(circle.y + circle.height);
    await page.waitForTimeout(GROW_SETTLE_MS);
    await shot(page, info, "19-site-tap-to-hear");
    const inner = page.frames().find((f) => f.url().includes(`/embed/${KEY}/video`))!;
    await inner.evaluate(() => {
      (window as unknown as { __allowAudio?: boolean }).__allowAudio = true;
    });
    await pill.click();
    await expect(pill).toHaveCount(0);
    await page.getByRole("button", { name: "Close video call" }).click();
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
    void baseURL;
  } finally {
    server?.close();
  }
});