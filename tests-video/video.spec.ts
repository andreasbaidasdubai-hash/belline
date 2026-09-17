import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test as base, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
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

const test = base.extend<{ aborted: unknown }>({
  aborted: [
    async ({ context }, use) => {
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
  const body = (await res.json()) as { session: { sessionId: string; clientToken: string } };
  await expect(page.getByText("MOCK — not a live avatar")).toBeVisible();
  await expect(page.getByRole("button", { name: "End call" })).toBeVisible();
  await expect(page.getByText(/Hi, I'm Belle, the AI concierge for Belline/)).toBeVisible();
  return body.session;
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

  // One centred row of equal controls, big enough to hit, inside the screen.
  const names = ["Mute microphone", "End call", "Switch to chat", "Talk to a person", "Hide captions"];
  const boxes = await Promise.all(names.map((name) => box(page.getByRole("button", { name }))));
  const viewport = page.viewportSize()!;
  for (const b of boxes) {
    expect(Math.round(b.width)).toBe(Math.round(boxes[0].width));
    expect(Math.round(b.height)).toBe(Math.round(boxes[0].height));
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.y + b.height).toBeLessThanOrEqual(viewport.height);
  }
  const rowTop = Math.min(...boxes.map((b) => b.y));
  const firstRow = boxes.filter((b) => Math.abs(b.y - rowTop) < 2);
  const left = Math.min(...firstRow.map((b) => b.x));
  const right = Math.max(...firstRow.map((b) => b.x + b.width));
  expect(Math.abs(left - (viewport.width - right))).toBeLessThanOrEqual(4);
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, info, "02-call-view");

  await page.getByRole("button", { name: "Mute microphone" }).click();
  await expect(page.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".bv-status")).toHaveText(/muted|Belle is speaking/);
  await shot(page, info, "03-muted");
  await page.getByRole("button", { name: "Unmute microphone" }).click();

  await page.getByLabel(/Say something/).fill("My name is Dana Reed, I run a salon called Glow Studio, email dana.video@glow.example");
  await page.getByRole("button", { name: "Say", exact: true }).click();
  await expect(page.locator(".bv-captions")).toContainText("Glow Studio");
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

  await page.getByRole("button", { name: "Hide captions" }).click();
  await expect(page.locator(".bv-captions")).toHaveCount(0);
  await page.getByRole("button", { name: "Show captions" }).click();

  await page.getByRole("button", { name: "End call" }).click();
  await expect(page.getByText(/The call has ended/)).toBeVisible();
  await shot(page, info, "05-ended");
  await expectEnded(page, baseURL!, session);
});

test("the controls wrap cleanly at 320px", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone-390", "a phone-width case");
  await page.setViewportSize({ width: 320, height: 640 });
  await openPanel(page);
  await startCall(page);
  expect(await noHorizontalScroll(page)).toBe(true);
  const boxes = await Promise.all(
    ["Mute microphone", "End call", "Switch to chat", "Talk to a person", "Hide captions"].map((name) => box(page.getByRole("button", { name }))),
  );
  for (let i = 0; i < boxes.length; i++) {
    expect(boxes[i].x).toBeGreaterThanOrEqual(0);
    expect(boxes[i].x + boxes[i].width).toBeLessThanOrEqual(320);
    for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
  }
  await shot(page, info, "02b-call-view-320");
  await page.getByRole("button", { name: "End call" }).click();
});

test("microphone refused: an explanation, the chat offered, and no session created", async ({ page, context }, info) => {
  await refuseMic(context);
  const sessions: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/session") && r.method() === "POST") sessions.push(r.url());
  });
  await openPanel(page);
  await page.getByRole("button", { name: "Start video call" }).click();
  await expect(alertIn(page)).toContainText("Your microphone is blocked");
  await expect(page.getByRole("button", { name: "Chat instead" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Voice call" })).toBeVisible();
  await shot(page, info, "06-mic-denied");
  expect(sessions).toEqual([]);
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
  await page.getByRole("button", { name: "Switch to chat" }).click();
  await expect(page).toHaveURL(new RegExp(`/embed/${KEY}/chat`));
  await expectEnded(page, baseURL!, session);
});

test("talk to a person: the panel says what happens next", async ({ page }, info) => {
  await openPanel(page);
  await startCall(page);
  await page.getByRole("button", { name: "Talk to a person" }).click();
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

test("on a venue's page: the bubble greets on load with no session, a tap starts the call, × ends it, and it stays dismissed", async ({ page, context, baseURL }, info) => {
  const server = await venueSite(baseURL!);
  test.skip(!server, "localhost:3000 is taken on this machine");
  const posts = countSessionPosts(context);
  try {
    await page.goto("http://localhost:3000/");
    const bubble = page.locator(".bvb");
    await expect(bubble).toBeVisible();
    await expect(bubble.getByText("Hi, I'm Belle, the AI concierge. Tap to talk.")).toBeVisible();
    await expect(bubble.getByText("AI concierge", { exact: true })).toBeVisible();
    await expect(bubble.getByText("MOCK — not a live avatar")).toBeVisible();
    await page.waitForTimeout(2500);
    expect(posts, "a live session was created on page load").toEqual([]);

    // Lined up with the launcher: right edges together, nothing overlapping.
    const b = await box(bubble);
    const chat = await box(page.locator("button.belline-fab").last());
    expect(Math.abs(b.x + b.width - (chat.x + chat.width))).toBeLessThanOrEqual(2);
    expect(overlaps(b, chat)).toBe(false);
    const viewport = page.viewportSize()!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.width).toBeGreaterThanOrEqual(viewport.width <= 520 ? 120 : 180);
    expect(b.width).toBeLessThanOrEqual(viewport.width <= 520 ? 140 : 220);
    await shot(page, info, "11-widget-bubble-on-load");

    // Tap to talk: the call frame starts the session itself.
    const created = page.waitForResponse((r) => r.url().endsWith(`/api/video/${KEY}/session`) && r.request().method() === "POST");
    await bubble.getByRole("button", { name: "Talk to Belle", exact: true }).click();
    const { session } = (await (await created).json()) as { session: { sessionId: string; clientToken: string } };
    expect(posts.length).toBe(1);
    const frame = page.frameLocator("iframe.belline-panel");
    await expect(frame.getByRole("button", { name: "End call" })).toBeVisible();
    await shot(page, info, "12-widget-call-view");

    // × during the call: the session ends on the server.
    await page.getByRole("button", { name: "Close video call" }).click();
    await expect(page.locator("iframe.belline-panel")).toHaveCount(0);
    await expectEnded(page, baseURL!, session);

    // Dismissed for the session: not on the next page load, but one tap away.
    await page.reload();
    const videoFab = page.getByRole("button", { name: "Video call" });
    await expect(videoFab).toBeVisible();
    await expect(page.locator(".bvb")).toHaveCount(0);
    await shot(page, info, "13-widget-dismissed");
    await videoFab.click();
    await expect(page.locator(".bvb")).toBeVisible();
    await page.getByRole("button", { name: "Close Belle's video greeting" }).click();
    await expect(page.locator(".bvb")).toHaveCount(0);
    expect(posts.length).toBe(1);
  } finally {
    server?.close();
  }
});

test("on belline.ai: the bubble tops a tidy stack, no session on load, and closing leaves a Video button in line", async ({ page, context, baseURL }, info) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  const posts = countSessionPosts(context);
  try {
    await page.goto("http://localhost:4321/");
    const bubble = page.locator(".video-bubble");
    await expect(bubble).toBeVisible();
    await page.waitForTimeout(2500);
    expect(posts).toEqual([]);

    const fabs = [page.locator(".bell-fab"), page.locator(".chat-fab"), page.locator(".wa-fab")];
    const stack = [await box(bubble), ...(await Promise.all(fabs.map(box)))];
    for (let i = 0; i < stack.length; i++) {
      for (let j = i + 1; j < stack.length; j++) expect(overlaps(stack[i], stack[j]), `stack items ${i} and ${j} overlap`).toBe(false);
    }
    const rights = stack.map((s) => Math.round(s.x + s.width));
    expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(8);
    await shot(page, info, "14-site-bubble-on-load");

    await page.getByRole("button", { name: "Close Belle's video greeting" }).click();
    const videoFab = page.locator(".video-fab");
    await expect(videoFab).toBeVisible();
    const withFab = [await box(videoFab), ...(await Promise.all(fabs.map(box)))];
    for (let i = 1; i < withFab.length; i++) expect(overlaps(withFab[0], withFab[i])).toBe(false);
    await shot(page, info, "15-site-dismissed");

    await videoFab.click();
    await expect(bubble).toBeVisible();
    await bubble.getByRole("button", { name: "Talk to Belle", exact: true }).click();
    await expect(page.frameLocator(".video-frame").getByRole("button", { name: "End call" })).toBeVisible();
    await shot(page, info, "16-site-call-view");
    expect(posts.length).toBe(1);
    await page.locator(".video-dock .call-shut").click();
    await expect(page.locator(".video-dock")).toHaveCount(0);
  } finally {
    server?.close();
  }
});
