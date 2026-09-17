import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { blockExternal } from "../tests/selfserve/helpers";

/**
 * belline.ai after the site review (2026-09-17), against the mock video provider:
 *
 * - choosing Annual in the pricing carries `cycle=annual` into every checkout link;
 * - Belle never covers the page: on a wide screen she rests in the hero and a
 *   compact launcher takes the corner once the hero has scrolled away; on a
 *   phone the launcher is there from the start; neither sits on the pricing,
 *   at 1280 or at 390;
 * - WhatsApp is offered only when the widget config names a connected number.
 *
 * Screenshots (desktop hero, desktop pricing, phone hero, phone pricing) go
 * to SITE_SHOTS_DIR when it is set.
 *
 *   npx playwright test --config playwright.video.config.ts tests-video/site-review.spec.ts
 */

const KEY = "be_belline_site";
const ROOT = process.cwd();
const SHOTS = process.env.SITE_SHOTS_DIR;
const SITE = "http://localhost:4321";

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

test("Belle never covers the page: she rests in the hero (a launcher on a phone), and nothing floats over the pricing", async ({ page, baseURL }) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    await withConfig(page, { whatsappLink: null });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${SITE}/`);
    const viewport = page.viewportSize()!;
    const wide = viewport.width > 900;
    const bubble = page.locator(".video-bubble");
    const launcher = page.locator(".video-launcher");
    await expect(bubble).toHaveAttribute("data-state", "rest");

    if (wide) {
      await expect(bubble).toBeVisible();
      await expect(launcher).toBeHidden();
      await expect(page.locator(".hero-video.has-bubble")).toBeVisible();
      await shot(page, "desktop-hero");
    } else {
      await expect(bubble).toBeHidden();
      await expect(launcher).toBeVisible();
    }

    // The launcher: a 40px face and "Talk to Belle · video", about 56px tall, 20-24px from the edges.
    if (!wide) {
      const main = await box(launcher.getByRole("button", { name: "Talk to Belle · video" }));
      expect(main.height).toBeGreaterThanOrEqual(52);
      expect(main.height).toBeLessThanOrEqual(60);
      const all = await box(launcher);
      expect(viewport.width - (all.x + all.width)).toBeGreaterThanOrEqual(18);
      expect(viewport.width - (all.x + all.width)).toBeLessThanOrEqual(26);
      expect(viewport.height - (all.y + all.height)).toBeGreaterThanOrEqual(18);
      const face = await box(launcher.locator(".vl-face"));
      expect(Math.round(face.width)).toBe(40);
      await shot(page, "mobile-hero");
    }

    // Past the hero on a wide screen, the corner holds the launcher and the big bubble is not over anything.
    if (wide) {
      await page.evaluate(() => window.scrollTo(0, document.querySelector("#channels")!.getBoundingClientRect().top + window.scrollY));
      await expect(launcher).toBeVisible();
      await expect(launcher).not.toHaveClass(/is-away/);
      expect(await bubble.evaluate((b) => getComputedStyle(b).position)).not.toBe("fixed");
    }

    // Through the whole pricing section, nothing of Belle overlaps its content or its buttons.
    const content = page.locator("#price .sec-head, #price .price-bar, #price .plans, #price .plan-shared, #price .price-tax, #price .compare, #price .terms, #price .btn");
    const top = await page.evaluate(() => document.querySelector("#price")!.getBoundingClientRect().top + window.scrollY);
    const height = await page.evaluate(() => document.querySelector("#price")!.getBoundingClientRect().height);
    let sawTucked = false;
    for (let y = top - viewport.height; y <= top + height; y += Math.round(viewport.height / 3)) {
      await page.evaluate((to) => window.scrollTo(0, to), Math.max(0, y));
      await page.waitForTimeout(350);
      const floating = [launcher, bubble];
      for (const thing of floating) {
        if (!(await thing.isVisible())) continue;
        if (thing === launcher && /is-away/.test((await thing.getAttribute("class")) ?? "")) continue;
        const b = await box(thing);
        if (b.y > viewport.height || b.y + b.height < 0) continue;
        for (let i = 0; i < (await content.count()); i++) {
          const c = await content.nth(i).boundingBox();
          if (!c || c.width === 0) continue;
          expect(overlaps(b, c), `at scroll ${y}, ${thing === launcher ? "the launcher" : "the bubble"} covers pricing content`).toBe(false);
        }
        if (thing === launcher && /is-tucked/.test((await thing.getAttribute("class")) ?? "")) sawTucked = true;
      }
    }
    void sawTucked;

    // A screenshot with the plans in view and the launcher where it may be.
    await page.evaluate(() => window.scrollTo(0, document.querySelector("#price .plans")!.getBoundingClientRect().top + window.scrollY - 140));
    await page.waitForTimeout(400);
    await shot(page, wide ? "desktop-pricing" : "mobile-pricing");

    // The launcher starts the call in the big circle, and comes back when it ends.
    await page.evaluate(() => window.scrollTo(0, document.querySelector("#how")!.getBoundingClientRect().top + window.scrollY));
    await expect(launcher).toBeVisible();
    await expect(launcher).not.toHaveClass(/is-away/);
    await launcher.getByRole("button", { name: "Talk to Belle · video" }).click();
    await expect(bubble).toHaveAttribute("data-state", "call");
    // Floating in the corner, where the visitor is: the page did not jump back to the hero.
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(viewport.height);
    expect(await bubble.evaluate((b) => b.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    await expect(bubble).toBeVisible();
    await expect(launcher).toBeHidden();
    const circle = await box(bubble.locator(".bvb-circle"));
    expect(circle.width).toBeGreaterThanOrEqual(228);
    expect(circle.x + circle.width).toBeLessThanOrEqual(viewport.width);
    await page.getByRole("button", { name: "Close video call" }).click();
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
    await expect(launcher).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    if (!wide) await expect(bubble).toBeHidden();
  } finally {
    server?.close();
  }
});

test("WhatsApp is offered only when the widget config names a connected number", async ({ page, baseURL }) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    const wide = page.viewportSize()!.width > 900;
    const beside = () => (wide ? page.locator(".video-bubble .bvb-act") : page.locator(".video-launcher .vl-act"));

    // Not connected: no WhatsApp beside Belle, and no floating WhatsApp button.
    await withConfig(page, { whatsappLink: null });
    await page.goto(`${SITE}/`);
    await expect(page.locator(".video-bubble")).toHaveAttribute("data-state", "rest");
    await expect(page.locator(wide ? '.video-bubble .bvb-act[data-kind="chat"]' : '.video-launcher .vl-act[data-kind="chat"]')).toHaveCount(1);
    await expect(beside()).toHaveCount(1);
    await expect(page.locator('[data-kind="whatsapp"]')).toHaveCount(0);
    await expect(page.locator(".wa-fab")).toBeHidden();

    // Video off and still not connected: the floating buttons are back, WhatsApp still is not.
    await withConfig(page, { whatsappLink: null, video: false });
    await page.goto(`${SITE}/`);
    await expect(page.locator(".chat-fab")).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator(".wa-fab")).toBeHidden();

    // Connected: WhatsApp is there, beside Belle.
    await withConfig(page, { whatsappLink: "https://wa.me/15551234567?text=Hi%20Belle" });
    await page.goto(`${SITE}/`);
    await expect(page.locator(".video-bubble")).toHaveAttribute("data-state", "rest");
    await expect(beside()).toHaveCount(2);
    await expect(page.locator(wide ? '.video-bubble [data-kind="whatsapp"]' : '.video-launcher [data-kind="whatsapp"]')).toHaveAttribute("aria-label", "WhatsApp Belle");
  } finally {
    server?.close();
  }
});
