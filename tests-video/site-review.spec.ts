import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { blockExternal } from "../tests/selfserve/helpers";
import { applySiteFlags } from "../src/lib/site-flags";

/**
 * belline.ai after the site review (2026-09-17), against the mock video provider:
 *
 * - choosing Annual in the pricing carries `cycle=annual` into every checkout link;
 * - Belle is large in the hero on load, on a phone too (within the first
 *   screen, at 390x844 and 375x667); × makes her a small face bottom right for
 *   the session; the small face never floats over the big one, nor over the
 *   pricing;
 * - WhatsApp is offered only when the widget config names a number.
 *
 * The pages are served as the app's server serves them with video.avatar on
 * (src/lib/site-flags.ts). Screenshots (desktop hero, phone hero, phone after
 * ×) go to SITE_SHOTS_DIR when it is set.
 *
 *   npx playwright test --config playwright.video.config.ts tests-video/site-review.spec.ts
 */

const KEY = "be_belline_site";
const ROOT = process.cwd();
const SHOTS = process.env.SITE_SHOTS_DIR;
const SITE = "http://localhost:4321";
/** The flag as staging has it, for the pages' own copy. */
const VIDEO_ON = { FLAG_VIDEO_AVATAR: "on", TAVUS_API_KEY: "x", TAVUS_FACE_ID: "x", VIDEO_LLM_SECRET: "x".repeat(40) };

const test = base.extend<{ aborted: unknown }>({
  aborted: [
    async ({ context }: { context: BrowserContext }, use: (value: unknown) => Promise<void>) => {
      const aborted = await blockExternal(context);
      await use(aborted);
      expect(aborted.filter((a) => /tavus|daily\.co/.test(a.url))).toEqual([]);
    },
    { auto: true },
  ],
});

/** belline.ai's pages from public/, pointed at this app instead of production (localhost:4321 is allowed to frame it). */
function landingSite(appOrigin: string): Promise<http.Server | null> {
  const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", SITE);
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
      if (ext === ".html") body = applySiteFlags(rel, body as string, VIDEO_ON);
      res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
      res.end(body);
    });
    server.once("error", () => resolve(null));
    server.listen(4321, "localhost", () => resolve(server));
  });
}

/** The widget config as the app serves it, with these fields changed. */
async function withConfig(page: Page, patch: Record<string, unknown>) {
  await page.unroute(`**/api/embed/${KEY}/config`).catch(() => {});
  await page.route(`**/api/embed/${KEY}/config`, async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...json, ...patch } });
  });
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "element has no box").not.toBeNull();
  return b!;
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Every checkout link on the page, as it is now. */
const checkoutLinks = (page: Page) =>
  page.locator('a[href*="/checkout"]').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href));

test("choosing Annual carries cycle=annual into every plan and Get started link, and Monthly takes it out again", async ({ page, baseURL }) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    await page.goto(`${SITE}/`);
    const before = await checkoutLinks(page);
    expect(before.length).toBeGreaterThanOrEqual(8); // nav, hero, booking, steps, closer, three plans
    expect(before.every((href) => !/[?&]cycle=/.test(href))).toBe(true);

    await page.locator("#price").getByRole("button", { name: /Annual/ }).click();
    await expect(page.locator('.plan .amt').first()).toHaveText("AED 228");
    const annual = await checkoutLinks(page);
    expect(annual.length).toBe(before.length);
    for (const href of annual) expect(new URL(href).searchParams.get("cycle"), href).toBe("annual");
    // The plan links keep their plan and market.
    const growth = new URL(annual.find((h) => h.includes("products=v2_growth"))!);
    expect(growth.searchParams.get("products")).toBe("v2_growth");
    expect(growth.searchParams.get("market")).toBe("AE");

    await page.locator("#price").getByRole("button", { name: "Monthly" }).click();
    expect((await checkoutLinks(page)).every((href) => !/[?&]cycle=/.test(href))).toBe(true);

    // The German pages sell nothing: the switch works and no link goes to a checkout.
    await page.goto(`${SITE}/landing.de.html`);
    await page.locator("#price").getByRole("button", { name: /Jährlich/ }).click();
    await expect(page.locator('.plan .amt').first()).toHaveText("63 €");
    expect(await checkoutLinks(page)).toEqual([]);
  } finally {
    server?.close();
  }
});

/** The launcher never sits on the big face, and nothing of Belle covers the pricing, scrolling the whole page. */
async function expectNothingCovered(page: Page) {
  const viewport = page.viewportSize()!;
  const bubble = page.locator(".video-bubble");
  const launcher = page.locator(".video-launcher");
  const content = page.locator("#price .sec-head, #price .price-bar, #price .plans, #price .plan-shared, #price .price-tax, #price .compare, #price .terms, #price .btn");
  const end = await page.evaluate(() => document.querySelector("#price")!.getBoundingClientRect().bottom + window.scrollY);
  for (let y = 0; y <= end; y += Math.round(viewport.height / 3)) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(300);
    if (!(await launcher.isVisible()) || /is-away/.test((await launcher.getAttribute("class")) ?? "")) continue;
    const l = await box(launcher);
    if (await bubble.isVisible()) {
      const face = await bubble.locator(".bvb-circle").boundingBox();
      if (face && face.y + face.height > 0 && face.y < viewport.height) expect(overlaps(l, face), `at scroll ${y}, the small face floats over Belle's big face`).toBe(false);
    }
    for (let i = 0; i < (await content.count()); i++) {
      const c = await content.nth(i).boundingBox();
      if (!c || c.width === 0) continue;
      expect(overlaps(l, c), `at scroll ${y}, the small face covers pricing content`).toBe(false);
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

test("Belle is large in the hero on load, on a phone within the first screen, and the small face never floats over her", async ({ page, baseURL }, info) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    const sizes = info.project.name === "iphone-390" ? [{ width: 390, height: 844 }, { width: 375, height: 667 }] : [page.viewportSize()!];
    for (const size of sizes) {
      await page.setViewportSize(size);
      await withConfig(page, { whatsappLink: "https://wa.me/971501234567" });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`${SITE}/`);
      const wide = size.width > 900;
      const bubble = page.locator(".video-bubble");
      const launcher = page.locator(".video-launcher");
      await expect(bubble).toHaveAttribute("data-state", "rest");
      await expect(bubble).toBeVisible();
      await expect(launcher).toBeHidden();
      expect(await bubble.evaluate((b) => Boolean(b.closest(".hero-video")) && getComputedStyle(b).position !== "fixed")).toBe(true);

      // Under the face: the round chat and WhatsApp icons, and the small included line. No button, no heading, no paragraph.
      const face = bubble.getByRole("button", { name: "Talk to Belle on video", exact: true });
      await expect(face).toHaveCSS("cursor", "pointer");
      await expect(bubble.locator(".bvb-talk")).toHaveCount(0);
      await expect(page.getByText("Try Belle on video")).toHaveCount(0);
      await expect(page.locator(".hero-video .hv-title")).toBeHidden();
      await expect(page.locator(".hero-video .hv-text")).toBeHidden();
      await expect(page.locator(".hero-video .hv-cta")).toBeHidden();
      await expect(bubble.locator(".bvb-act")).toHaveCount(2);
      await expect(page.locator(".hero-video .hv-early")).toHaveText("Included in every plan. Each video minute uses 2.5 voice minutes.");
      await expect(page.locator(".hero-video .hv-early")).toBeVisible();
      await expect(bubble.locator(".bvb-caption")).toBeVisible();
      await expect(bubble.locator(".bvb-caption")).toHaveText("Hi, I'm Belle — tap to talk");
      // As the page loads, before any scrolling.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const circle = await box(bubble.locator(".bvb-circle"));
      if (wide) {
        expect(circle.width).toBeGreaterThanOrEqual(296);
        await shot(page, "desktop-hero");
      } else {
        // Large, within the first screen with her icons and the included line: under the headline and the pills, before the paragraph.
        // About 220-240px: 240 on a 390x844 phone, a little less on a short one (375x667) so her icons and the line fit too.
        expect(circle.width).toBeGreaterThanOrEqual(210);
        expect(circle.width).toBeLessThanOrEqual(252);
        expect(circle.y).toBeGreaterThanOrEqual(0);
        const icons = await box(bubble.locator(".bvb-row"));
        const line = await box(page.locator(".hero-video .hv-early"));
        expect(icons.y + icons.height, "Belle's icons are below the first screen").toBeLessThanOrEqual(size.height);
        expect(line.y + line.height, "the included line is below the first screen").toBeLessThanOrEqual(size.height);
        const pills = await box(page.locator(".hero-can"));
        const lead = await box(page.locator(".hero .lead"));
        expect((await box(bubble.locator(".bvb-caption"))).y).toBeGreaterThanOrEqual(pills.y + pills.height);
        expect(lead.y).toBeGreaterThan(circle.y + circle.height);
        expect((await box(page.locator(".hero h1"))).y).toBeLessThan(circle.y);
        await shot(page, `mobile-hero-${size.width}x${size.height}`);
      }

      // Keyboard: the face takes focus and shows a ring.
      await face.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      expect(await face.evaluate((el) => document.activeElement === el && getComputedStyle(el).outlineStyle !== "none")).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));

      // Scrolling the whole page: the small face shows only once the big one is out of view, and covers nothing.
      await expectNothingCovered(page);
      if (wide) {
        await page.evaluate(() => window.scrollTo(0, document.querySelector("#channels")!.getBoundingClientRect().top + window.scrollY));
        await expect(launcher).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(launcher).toBeHidden();
      }

      // ×: Belle becomes the small face, bottom right, with the chat and WhatsApp, for the session.
      await bubble.getByRole("button", { name: "Close Belle's video greeting" }).click();
      await expect(page.locator(".hero-video")).toBeHidden();
      await expect(launcher).toBeVisible();
      const small = await box(launcher.getByRole("button", { name: "Talk to Belle on video" }));
      expect(Math.round(small.width)).toBe(64);
      expect(Math.round(small.height)).toBe(64);
      expect(size.width - (small.x + small.width)).toBeLessThanOrEqual(26);
      expect(size.height - (small.y + small.height)).toBeLessThanOrEqual(26);
      await expect(launcher.locator(".vl-act")).toHaveCount(2);
      await expect(launcher.locator('[data-kind="whatsapp"]')).toHaveAttribute("aria-label", "WhatsApp Belle");
      if (!wide) await shot(page, `mobile-after-close-${size.width}x${size.height}`);
      // Still small after a reload in the same session.
      await page.reload();
      await expect(launcher).toBeVisible();
      await expect(page.locator(".hero-video")).toBeHidden();

      // The small face starts the call in the big circle; when it ends she is small again.
      await launcher.getByRole("button", { name: "Talk to Belle on video" }).click();
      await expect(bubble).toHaveAttribute("data-state", "call");
      await expect(bubble).toBeVisible();
      await expect(launcher).toBeHidden();
      // Grown from the small face (the circle animates to the call's size).
      await expect.poll(async () => (await box(bubble.locator(".bvb-circle"))).width).toBeGreaterThanOrEqual(228);
      const call = await box(bubble.locator(".bvb-circle"));
      expect(call.x + call.width).toBeLessThanOrEqual(size.width);
      await page.getByRole("button", { name: "Close video call" }).click();
      await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
      await expect(launcher).toBeVisible();
      await expect(page.locator(".hero-video")).toBeHidden();

      // A fresh session: large again.
      await page.evaluate(() => sessionStorage.clear());
    }
  } finally {
    server?.close();
  }
});

test("a call started from the hero grows where Belle is, and the small face stays away while she is on screen", async ({ page, baseURL }) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    await withConfig(page, { whatsappLink: null });
    await page.goto(`${SITE}/`);
    const bubble = page.locator(".video-bubble");
    const launcher = page.locator(".video-launcher");
    await expect(bubble).toHaveAttribute("data-state", "rest");
    await bubble.getByRole("button", { name: "Talk to Belle on video", exact: true }).click();
    await expect(bubble).toHaveAttribute("data-state", "call");
    expect(await bubble.evaluate((b) => b.classList.contains("vb-float"))).toBe(false);
    await expect(launcher).toBeHidden();
    await page.getByRole("button", { name: "Close video call" }).click();
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
    await expect(bubble).toHaveAttribute("data-state", "rest");
    await expect(bubble).toBeVisible();
    await expect(launcher).toBeHidden();
  } finally {
    server?.close();
  }
});

test("WhatsApp is offered only when the widget config names a number, beside Belle and on the small face", async ({ page, baseURL }) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    // No number: no WhatsApp beside Belle, and no floating WhatsApp button.
    await withConfig(page, { whatsappLink: null });
    await page.goto(`${SITE}/`);
    await expect(page.locator(".video-bubble")).toHaveAttribute("data-state", "rest");
    await expect(page.locator('.video-bubble .bvb-act[data-kind="chat"]')).toHaveCount(1);
    await expect(page.locator(".video-bubble .bvb-act")).toHaveCount(1);
    await expect(page.locator('[data-kind="whatsapp"]')).toHaveCount(0);
    await expect(page.locator(".wa-fab")).toBeHidden();

    // Video off and no number: the floating buttons are back, WhatsApp still is not.
    await withConfig(page, { whatsappLink: null, video: false });
    await page.goto(`${SITE}/`);
    await expect(page.locator(".chat-fab")).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator(".wa-fab")).toBeHidden();

    // Video off with a number (belline.ai's own, SITE_WHATSAPP_NUMBER): the floating button goes straight to it.
    await withConfig(page, { whatsappLink: "https://wa.me/971501234567", video: false });
    await page.goto(`${SITE}/`);
    await expect(page.locator(".wa-fab")).toBeVisible();
    await expect(page.locator(".wa-fab")).toHaveAttribute("href", "https://wa.me/971501234567");

    // A number: WhatsApp beside Belle, and on the small face after ×.
    await withConfig(page, { whatsappLink: "https://wa.me/971501234567" });
    await page.goto(`${SITE}/`);
    await expect(page.locator(".video-bubble")).toHaveAttribute("data-state", "rest");
    await expect(page.locator(".video-bubble .bvb-act")).toHaveCount(2);
    await expect(page.locator('.video-bubble [data-kind="whatsapp"]')).toHaveAttribute("aria-label", "WhatsApp Belle");
    await page.getByRole("button", { name: "Close Belle's video greeting" }).click();
    await expect(page.locator('.video-launcher [data-kind="whatsapp"]')).toBeVisible();
    await page.evaluate(() => sessionStorage.clear());
  } finally {
    server?.close();
  }
});
