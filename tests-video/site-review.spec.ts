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
 * - WhatsApp is offered only when the widget config names a number;
 * - the first painted frame is the layout the page ends in — no flash of the
 *   hero's static card or the three floating buttons before Belle arrives,
 *   however long app.belline.ai's config takes, and the hero's own
 *   demonstration back if it never comes;
 * - `prefers-reduced-motion` keeps her in the hero and steps her to the
 *   corner rather than flying her there.
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

/**
 * The parts of Belle a visitor can actually see, in viewport coordinates.
 *
 * Opacity on an ancestor, not the element: her icons are faded out by a rule
 * on their row, so asking the icon itself whether it is visible says yes.
 */
const VISIBLE_PARTS = `(() => {
  const shown = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const css = getComputedStyle(n);
      if (css.opacity === "0" || css.visibility === "hidden" || css.display === "none") return false;
    }
    return true;
  };
  return [...document.querySelectorAll(".video-bubble .bvb-circle, .video-bubble .bvb-act")]
    .filter(shown)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })
    .filter((r) => r.width > 0);
})()`;

/** Nothing of Belle covers the pricing or a button, scrolling the whole page. */
async function expectNothingCovered(page: Page) {
  const viewport = page.viewportSize()!;
  const bubble = page.locator(".video-bubble");
  const content = page.locator("#price .sec-head, #price .price-bar, #price .plans, #price .plan-shared, #price .price-tax, #price .compare, #price .terms, #price .btn");
  const end = await page.evaluate(() => document.querySelector("#price")!.getBoundingClientRect().bottom + window.scrollY);
  for (let y = 0; y <= end; y += Math.round(viewport.height / 3)) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(300);
    if (!(await bubble.isVisible())) continue;
    if (await bubble.evaluate((b) => b.classList.contains("vb-away"))) continue;
    const parts = (await page.evaluate(VISIBLE_PARTS)) as Box[];
    for (let i = 0; i < (await content.count()); i++) {
      const c = await content.nth(i).boundingBox();
      if (!c || c.width === 0) continue;
      for (const part of parts) expect(overlaps(part, c), `at scroll ${y}, Belle covers pricing content`).toBe(false);
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * One Belle, carried by the scroll.
 *
 * She rests in the hero, is carried to the corner as the hero's circle scrolls
 * out of view, and comes back up when the page does. There is never a second
 * launcher element: at every scroll position, exactly one of her.
 */
test("Belle travels from the hero to the corner and back, and is never duplicated", async ({ page, baseURL }, info) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    const sizes = info.project.name === "iphone-390" ? [{ width: 390, height: 844 }, { width: 375, height: 667 }] : [page.viewportSize()!];
    for (const size of sizes) {
      await page.setViewportSize(size);
      await withConfig(page, { whatsappLink: "https://wa.me/971501234567" });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`${SITE}/`);
      // This test measures to the pixel, so it has to measure the hero as it
      // finally renders. landing.html loads Inter from Google with
      // `display=swap`, and the hero also reflows a little as the widget sizes
      // itself. Wait for the thing actually measured to stop moving.
      await expect
        .poll(
          async () => {
            const bottom = () =>
              page.evaluate(() => document.querySelector(".hero-can")?.getBoundingClientRect().bottom ?? null);
            const first = await bottom();
            await page.waitForTimeout(150);
            return first !== null && first === (await bottom());
          },
          { timeout: 45_000 },
        )
        .toBe(true);
      const wide = size.width > 900;
      const bubble = page.locator(".video-bubble");
      await expect(bubble).toHaveAttribute("data-state", "rest");
      await expect(bubble).toBeVisible();

      // There is no second Belle anywhere in the page, at any scroll position.
      await expect(page.locator(".video-launcher")).toHaveCount(0);
      await expect(bubble).toHaveCount(1);

      // At rest: in the hero's own column, in the page's flow.
      await expect(bubble).toHaveAttribute("data-vb", "hero");
      expect(await bubble.evaluate((b) => Boolean(b.closest(".hero-video")) && getComputedStyle(b).position !== "fixed")).toBe(true);

      // Under the face: the round chat and WhatsApp icons, and the small included line.
      const face = bubble.getByRole("button", { name: "Talk to Belle on video", exact: true });
      await expect(face).toHaveCSS("cursor", "pointer");
      await expect(bubble.locator(".bvb-talk")).toHaveCount(0);
      await expect(page.locator(".hero-video .hv-title")).toBeHidden();
      await expect(page.locator(".hero-video .hv-cta")).toBeHidden();
      await expect(bubble.locator(".bvb-act")).toHaveCount(2);
      await expect(page.locator(".hero-video .hv-early")).toBeVisible();
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const circle = await box(bubble.locator(".bvb-circle"));
      const resting = circle.width;
      if (wide) {
        expect(resting).toBeGreaterThanOrEqual(296);
        const column = await page.evaluate(() => {
          const grid = document.querySelector(".hero-video")!.parentElement!;
          const r = grid.getBoundingClientRect();
          const css = getComputedStyle(grid);
          const [first, second] = css.gridTemplateColumns.split(" ").map(parseFloat);
          const left = r.left + parseFloat(css.paddingLeft) + first + (parseFloat(css.columnGap) || 0);
          return { centre: left + second / 2, right: left + second };
        });
        expect(Math.abs(circle.x + circle.width / 2 - column.centre), "Belle is not centred in her column").toBeLessThanOrEqual(12);
        await shot(page, "desktop-hero");
      } else {
        // Large, within the first screen with her icons and the included line.
        expect(resting).toBeGreaterThanOrEqual(210);
        expect(resting).toBeLessThanOrEqual(252);
        expect(circle.y).toBeGreaterThanOrEqual(0);
        const icons = await box(bubble.locator(".bvb-row"));
        const line = await box(page.locator(".hero-video .hv-early"));
        expect(icons.y + icons.height, "Belle's icons are below the first screen").toBeLessThanOrEqual(size.height);
        expect(line.y + line.height, "the included line is below the first screen").toBeLessThanOrEqual(size.height);
        const lead = await box(page.locator(".hero .lead"));
        expect(lead.y).toBeGreaterThan(circle.y + circle.height);
        expect((await box(page.locator(".hero h1"))).y).toBeLessThan(circle.y);
        await shot(page, `mobile-hero-${size.width}x${size.height}`);
      }

      // In flight: part way through the trip she is smaller than she was,
      // bigger than she will be, and fixed to the screen rather than the page.
      const heroBottom = await page.evaluate(() => {
        const slot = document.querySelector(".hv-slot")!.getBoundingClientRect();
        return slot.top + window.scrollY + slot.height;
      });
      await page.evaluate((to) => window.scrollTo(0, to), Math.round(heroBottom * 0.55));
      await page.waitForTimeout(250);
      await expect.poll(async () => bubble.getAttribute("data-vb")).toBe("flight");
      await expect(bubble).toHaveCSS("position", "fixed");
      const midway = await box(bubble.locator(".bvb-circle"));
      expect(midway.width, "she did not shrink on the way").toBeLessThan(resting - 10);
      expect(midway.width, "she was already the landed face").toBeGreaterThan(70);
      // Still exactly one of her.
      await expect(page.locator(".video-bubble")).toHaveCount(1);
      await shot(page, `${wide ? "desktop" : "mobile"}-in-flight`);

      // Landed: 64px, bottom right, her icons beside her.
      await page.evaluate(() => window.scrollTo(0, document.querySelector("#channels")!.getBoundingClientRect().top + window.scrollY + 400));
      await page.waitForTimeout(400);
      await expect.poll(async () => bubble.getAttribute("data-vb")).toBe("corner");
      const small = await box(bubble.locator(".bvb-circle"));
      expect(Math.round(small.width)).toBe(64);
      expect(size.width - (small.x + small.width)).toBeLessThanOrEqual(26);
      expect(size.height - (small.y + small.height)).toBeLessThanOrEqual(26);
      await expect(page.locator(".video-bubble")).toHaveCount(1);
      await shot(page, `${wide ? "desktop" : "mobile"}-landed`);

      // And home again: scrolling back up carries her to the hero, full size.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);
      await expect.poll(async () => bubble.getAttribute("data-vb")).toBe("hero");
      await expect(bubble).not.toHaveCSS("position", "fixed");
      expect(Math.round((await box(bubble.locator(".bvb-circle"))).width)).toBe(Math.round(resting));

      // Keyboard: the face takes focus and shows a ring.
      await face.focus();
      expect(await face.evaluate((el) => document.activeElement === el && getComputedStyle(el).outlineStyle !== "none")).toBe(true);

      // Scrolling the whole page: she covers nothing on the way or at rest.
      await expectNothingCovered(page);

      // ×: she stays landed in the corner for the session, wherever the page is.
      await bubble.getByRole("button", { name: "Close Belle's video greeting" }).click();
      await page.waitForTimeout(400);
      await expect(page.locator(".hero-video")).toBeHidden();
      await expect(bubble).toHaveAttribute("data-vb", "corner");
      const after = await box(bubble.locator(".bvb-circle"));
      expect(Math.round(after.width)).toBe(64);
      await expect(bubble.locator(".bvb-act")).toHaveCount(2);
      await expect(bubble.locator('[data-kind="whatsapp"]')).toHaveAttribute("aria-label", "WhatsApp Belle");
      // She sits on none of the hero's words: every rendered line, not the boxes.
      const covered = await page.evaluate(() => {
        const visible = (el: HTMLElement) => {
          for (let n: HTMLElement | null = el; n; n = n.parentElement) {
            const css = getComputedStyle(n);
            if (css.opacity === "0" || css.visibility === "hidden" || css.display === "none") return false;
          }
          return true;
        };
        const shown = [...document.querySelectorAll<HTMLElement>(".video-bubble .bvb-circle, .video-bubble .bvb-act")]
          .filter(visible)
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0);
        const hits: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(".hero h1, .hero-can, .hero .lead, .hero-note, .hero .btn")) {
          const range = document.createRange();
          range.selectNodeContents(el);
          for (const line of range.getClientRects()) {
            for (const r of shown) {
              if (line.left < r.right && r.left < line.right && line.top < r.bottom && r.top < line.bottom) hits.push(el.className);
            }
          }
        }
        return [...new Set(hits)];
      });
      expect(covered, `at ${size.width}x${size.height}, after ×, Belle covers the hero's text`).toEqual([]);
      if (!wide) await shot(page, `mobile-after-close-${size.width}x${size.height}`);

      // Still landed after a reload in the same session.
      await page.reload();
      await expect(bubble).toHaveAttribute("data-vb", "corner");
      await expect(page.locator(".hero-video")).toBeHidden();
      await page.evaluate(() => sessionStorage.clear());
    }
  } finally {
    server?.close();
  }
});

/**
 * Reduced motion: she steps, she does not fly — and she is still in the hero.
 *
 * She used to be cornered from the first paint here: a 64px face bottom right
 * and a still portrait where the demonstration should be. Windows 11 reports
 * `prefers-reduced-motion` whenever "Animation effects" is off, so that was
 * every desktop visitor with that setting — including the founder, in Edge,
 * who reported that Belle "didn't move with the scroll on desktop" while she
 * worked perfectly on his phone (2026-09-19). She never moved because she was
 * never in the hero to move from. Reduced motion means less animation, not
 * less product: she rests in the hero, and the trip becomes one step.
 */
test("prefers-reduced-motion: Belle rests in the hero and steps to the corner, without a frame in between", async ({ page, baseURL }, info) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    await withConfig(page, { whatsappLink: null });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${SITE}/`);
    const bubble = page.locator(".video-bubble");
    const wide = info.project.name !== "iphone-390";

    // At the top: in the hero's column, in the page's flow, at the call's own
    // size — exactly where every other visitor meets her.
    await expect(bubble).toHaveAttribute("data-vb", "hero");
    await expect(page.locator(".video-launcher")).toHaveCount(0);
    expect(await bubble.evaluate((b) => Boolean(b.closest(".hero-video")) && getComputedStyle(b).position !== "fixed")).toBe(true);
    const resting = (await box(bubble.locator(".bvb-circle"))).width;
    expect(resting, "she is not at the call's size in the hero").toBeGreaterThanOrEqual(wide ? 296 : 210);
    await expect(page.locator(".hero-video")).toBeVisible();
    await shot(page, "reduced-motion-hero");

    // Every size she is painted at while the page scrolls the whole trip, a
    // small step at a time. With the flight on this is a smooth ramp; stepped,
    // there are exactly two: the hero's size, and the landed 64.
    const heroBottom = await page.evaluate(() => {
      const slot = document.querySelector(".hv-slot")!.getBoundingClientRect();
      return slot.top + window.scrollY + slot.height;
    });
    const widths = new Set<number>();
    for (let y = 0; y <= Math.round(heroBottom * 1.4); y += 20) {
      await page.evaluate((to) => window.scrollTo(0, to), y);
      await page.waitForTimeout(40);
      widths.add(Math.round((await bubble.locator(".bvb-circle").boundingBox())!.width));
    }
    expect([...widths].sort((a, b) => a - b), "she was painted at a size between the two: that is a flight, not a step").toEqual(
      [64, Math.round(resting)].sort((a, b) => a - b),
    );
    await expect(bubble).toHaveAttribute("data-vb", "corner");
    await expect(bubble).toHaveCSS("position", "fixed");
    // Nothing animates the step: the landing transition is off under the query.
    expect(await bubble.evaluate((b) => getComputedStyle(b).transitionDuration)).toMatch(/^0s(?:, 0s)*$/);
    await shot(page, "reduced-motion-corner");

    // And back: the same two sizes the other way, ending in the hero.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await expect(bubble).toHaveAttribute("data-vb", "hero");
    expect(Math.round((await box(bubble.locator(".bvb-circle"))).width)).toBe(Math.round(resting));
  } finally {
    server?.close();
  }
});

/**
 * The page is finished from the first painted frame.
 *
 * The hero's static card ("Belle on video", its paragraph and "Talk to
 * Belle") and the three floating buttons used to be painted first and taken
 * away when the widget arrived: measured at 97 ms with a fast config and
 * 1.6 s with a slow one, with the hero's slot jumping 356→438 on a desktop
 * and 296→340 on a phone. The founder reported seeing it on both
 * (2026-09-19).
 *
 * A requestAnimationFrame loop installed before the document runs records the
 * layout of every frame the browser paints, so what it collects is what a
 * visitor sees rather than what the DOM happened to hold when a test asked.
 * There must be exactly two layouts: the page before Belle is in it, and the
 * page with her — identical but for her. Same reserved height, same circle,
 * and nothing she replaces ever on screen.
 */
const FRAME_RECORDER = `
  window.__frames = [];
  (function tick() {
    requestAnimationFrame(function () {
      try {
        var on = function (sel) {
          var el = document.querySelector(sel);
          if (!el) return 0;
          for (var n = el; n; n = n.parentElement) {
            var css = getComputedStyle(n);
            if (css.opacity === "0" || css.visibility === "hidden" || css.display === "none") return 0;
          }
          return el.getClientRects().length ? 1 : 0;
        };
        var slot = document.querySelector(".hv-slot");
        var big = document.querySelector(".video-bubble .bvb-circle") || document.querySelector(".hv-face");
        window.__frames.push({
          t: Math.round(performance.now()),
          bubble: document.querySelector(".video-bubble") ? 1 : 0,
          replaced: [on(".hero-video .hv-title"), on(".hero-video .hv-text"), on(".hero-video .hv-cta"), on(".bell-fab"), on(".chat-fab"), on(".wa-fab")].join(""),
          slot: slot ? Math.round(slot.getBoundingClientRect().height) : -1,
          circle: big ? Math.round(big.getBoundingClientRect().width) : -1,
        });
      } catch (e) {}
      tick();
    });
  })();
`;

interface Frame {
  t: number;
  bubble: number;
  replaced: string;
  slot: number;
  circle: number;
}

for (const configMs of [0, 900]) {
  test(`no flash of the old layout on first paint, with the widget config ${configMs ? "slow" : "fast"}`, async ({ page, baseURL }, info) => {
    const server = await landingSite(baseURL!);
    test.skip(!server, "localhost:4321 is taken on this machine");
    try {
      // The config comes from app.belline.ai, so it can take a moment, and the
      // page has to look finished for the whole of it. `mock: false` is not
      // cosmetic here: the mock provider's "MOCK — not a live avatar" badge
      // sits between the circle and her icons and pushes the row 6px further
      // down, which no customer's page and no production build ever paints.
      await page.route(`**/api/embed/${KEY}/config`, async (route) => {
        const response = await route.fetch();
        const json = (await response.json()) as Record<string, unknown>;
        if (configMs) await new Promise((r) => setTimeout(r, configMs));
        await route.fulfill({
          response,
          json: { ...json, whatsappLink: "https://wa.me/971501234567", videoBubble: { ...((json.videoBubble as object) ?? {}), mock: false } },
        });
      });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.addInitScript(FRAME_RECORDER);
      await page.goto(`${SITE}/`);
      await expect(page.locator(".video-bubble")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(800);

      const frames = (await page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames)) as Frame[];
      expect(frames.length, "nothing was painted").toBeGreaterThan(10);
      const key = (f: Frame) => `${f.bubble}|${f.replaced}|${f.slot}|${f.circle}`;
      const layouts: Frame[] = [];
      for (const f of frames) if (!layouts.length || key(layouts[layouts.length - 1]) !== key(f)) layouts.push(f);
      const shown = layouts.map((l) => `+${l.t}ms bubble=${l.bubble} replaced=${l.replaced} slot=${l.slot} circle=${l.circle}`).join("\n");

      // Nothing the bubble replaces is ever painted: not the hero's heading,
      // its paragraph or its button, and not one of the three floating buttons.
      for (const f of frames) expect(f.replaced, `an old-layout frame was painted at +${f.t}ms\n${shown}`).toBe("000000");
      // Two layouts, and the second differs only by Belle being in it.
      expect(layouts.length, `the layout changed more than once\n${shown}`).toBe(2);
      expect(layouts[0].bubble).toBe(0);
      expect(layouts[1].bubble).toBe(1);
      expect(layouts[1].slot, `the hero's slot moved as Belle landed\n${shown}`).toBe(layouts[0].slot);
      expect(layouts[1].circle, `Belle changed size as she landed\n${shown}`).toBe(layouts[0].circle);
      await shot(page, `${info.project.name === "iphone-390" ? "mobile" : "desktop"}-first-paint-${configMs}ms`);
    } finally {
      server?.close();
    }
  });
}

/**
 * And when the config never comes at all.
 *
 * Belle's place is held by the markup, so a page that never hears from
 * app.belline.ai has to give it back rather than sit on a promise nothing
 * will keep: the hero's own heading, paragraph and "Talk to Belle" return,
 * and so do the floating buttons, which are then the only way in. WhatsApp is
 * not among them — no config, no number.
 */
test("the widget config never answers: the hero's own demonstration and the floating buttons come back", async ({ page, baseURL }) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    await page.route(`**/api/embed/${KEY}/config`, (route) => route.abort("failed"));
    await page.goto(`${SITE}/`);
    await expect(page.locator(".hero-video .hv-cta")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".hero-video .hv-title")).toBeVisible();
    await expect(page.locator(".hero-video .hv-face")).toBeVisible();
    await expect(page.locator(".bell-fab")).toBeVisible();
    await expect(page.locator(".chat-fab")).toBeVisible();
    await expect(page.locator(".wa-fab")).toBeHidden();
    await expect(page.locator(".video-bubble")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.classList.contains("video-pending"))).toBe(false);
    await shot(page, "no-config-hero");
  } finally {
    server?.close();
  }
});

test("a call started from the hero grows where Belle is; one started from the corner floats there", async ({ page, baseURL }, info) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    const wide = info.project.name !== "iphone-390";
    await withConfig(page, { whatsappLink: null });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${SITE}/`);
    const bubble = page.locator(".video-bubble");
    await expect(bubble).toHaveAttribute("data-state", "rest");
    await bubble.getByRole("button", { name: "Talk to Belle on video", exact: true }).click();
    await expect(bubble).toHaveAttribute("data-state", "call");
    expect(await bubble.evaluate((b) => b.classList.contains("vb-float"))).toBe(false);
    // She is never carried away mid-call: the flight is off while a call runs.
    await expect(bubble).toHaveAttribute("data-vb", "hero");
    await shot(page, `${wide ? "desktop" : "mobile"}-call`);

    // The timer, in the call's circle, big enough to read and clear of a thumb.
    const time = page.frameLocator("iframe.bvb-frame").locator(".bv-time");
    await expect(time).toBeVisible({ timeout: 30_000 });
    await expect(time).toHaveText(/^\d+:\d\d$/);
    const size = await time.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, "the call timer is too small to read").toBeGreaterThanOrEqual(13);
    const where = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe.bvb-frame")!.getBoundingClientRect();
      const circle = document.querySelector(".video-bubble .bvb-circle")!.getBoundingClientRect();
      return { frameTop: frame.top, circleTop: circle.top, circleBottom: circle.bottom };
    });
    const pill = await box(time);
    // Inside the circle, in its top half: never on the edge (every small state
    // clips the frame to the circle) and never where the thumb rests.
    expect(pill.y).toBeGreaterThan(where.circleTop);
    expect(pill.y + pill.height).toBeLessThan(where.circleTop + (where.circleBottom - where.circleTop) / 2);
    await shot(page, `${wide ? "desktop" : "mobile"}-call-timer`);

    await page.getByRole("button", { name: "Close video call" }).click();
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
    await expect(bubble).toHaveAttribute("data-state", "rest");
    await expect(bubble).toHaveAttribute("data-vb", "hero");

    // From the corner: she has travelled, so the call grows where the visitor is.
    await page.evaluate(() => window.scrollTo(0, document.querySelector("#channels")!.getBoundingClientRect().top + window.scrollY + 400));
    await page.waitForTimeout(400);
    await expect(bubble).toHaveAttribute("data-vb", "corner");
    await bubble.getByRole("button", { name: "Talk to Belle on video", exact: true }).click();
    await expect(bubble).toHaveAttribute("data-state", "call");
    expect(await bubble.evaluate((b) => b.classList.contains("vb-float"))).toBe(true);
    // Full size, not a button, and on screen.
    const call = await box(bubble.locator(".bvb-circle"));
    expect(call.width).toBeGreaterThanOrEqual(180);
    expect(call.x + call.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    await shot(page, `${wide ? "desktop" : "mobile"}-call-corner`);
    await page.getByRole("button", { name: "Close video call" }).click();
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
  } finally {
    server?.close();
  }
});

/** A call on a phone stays large while the page moves under it, until × (founder, 2026-09-18). */
test("on a phone a call is carried at full size while the page scrolls, and never shrinks to a button", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "iphone-390", "this is the phone's rule");
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    await withConfig(page, { whatsappLink: null });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${SITE}/`);
    const bubble = page.locator(".video-bubble");
    await bubble.getByRole("button", { name: "Talk to Belle on video", exact: true }).click();
    await expect(bubble).toHaveAttribute("data-state", "call");
    const before = await box(bubble.locator(".bvb-circle"));
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(500);
    await expect(bubble).toHaveAttribute("data-pip", "big");
    const after = await box(bubble.locator(".bvb-circle"));
    expect(after.width, "the call shrank to a button while somebody was talking to her").toBeGreaterThanOrEqual(before.width - 1);
    expect(after.y).toBeGreaterThanOrEqual(0);
    expect(after.y + after.height).toBeLessThanOrEqual(844);
    // Mute, end, and the × are all there while she is carried.
    await expect(bubble.locator(".bvb-pipbar .bvb-pipend")).toBeVisible();
    await expect(page.getByRole("button", { name: "Close video call" })).toBeVisible();
    // And the clock is still readable: the frame is clipped to the circle here,
    // so a timer on the circle's edge would simply not be there.
    const carriedTime = page.frameLocator("iframe.bvb-frame").locator(".bv-time");
    await expect(carriedTime).toBeVisible({ timeout: 30_000 });
    const timeBox = await box(carriedTime);
    expect(timeBox.y).toBeGreaterThan(after.y);
    expect(timeBox.y + timeBox.height).toBeLessThan(after.y + after.height / 2);
    await shot(page, "mobile-call-carried");
    await page.getByRole("button", { name: "Close video call" }).click();
    await expect(page.locator("iframe.bvb-frame")).toHaveCount(0);
  } finally {
    server?.close();
  }
});

/** The chat opens inside the page on a phone: a sheet, not a second window. */
test("the chat is a sheet on a phone and a window on a desktop, and the page stays where it was", async ({ page, baseURL }, info) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    const phone = info.project.name === "iphone-390";
    await withConfig(page, { whatsappLink: null });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${SITE}/`);
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(400);
    const was = await page.evaluate(() => window.scrollY);
    await page.locator(".video-bubble .bvb-act[data-kind='chat']").click();
    const dock = page.locator(".chat-dock");
    await expect(dock).toBeVisible();
    // It slides up: measure it where it comes to rest, not on its way.
    await page.waitForTimeout(500);
    const viewport = page.viewportSize()!;
    const sheet = await box(dock);
    if (phone) {
      // A sheet: along the bottom, over the page, leaving the page above it.
      expect(Math.round(sheet.x)).toBe(0);
      expect(Math.round(sheet.width)).toBe(viewport.width);
      expect(Math.round(sheet.y + sheet.height)).toBe(viewport.height);
      expect(sheet.y, "the chat still takes the whole screen").toBeGreaterThanOrEqual(40);
      await expect(page.locator(".chat-veil")).toBeVisible();
      await expect(page.locator(".chat-grab")).toBeVisible();
      await expect(dock).toHaveCSS("border-top-left-radius", "18px");
      // The visitor is where they were, and the page is still behind it.
      expect(await page.evaluate(() => window.scrollY)).toBe(was);
      await shot(page, "mobile-chat-sheet");
      // A tap beside it puts it away, and they are still where they were.
      await page.locator(".chat-veil").click({ position: { x: 20, y: 20 } });
      await expect(dock).toHaveCount(0);
      await expect(page.locator(".chat-veil")).toHaveCount(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(was);
    } else {
      // A window in the corner, as it was.
      expect(sheet.x).toBeGreaterThan(0);
      expect(sheet.width).toBeLessThanOrEqual(400);
      await expect(page.locator(".chat-veil")).toBeHidden();
      await shot(page, "desktop-chat-window");
      await page.keyboard.press("Escape");
      await expect(dock).toHaveCount(0);
    }
  } finally {
    server?.close();
  }
});

test("WhatsApp is offered only when the widget config names a number, beside Belle in the hero and in the corner", async ({ page, baseURL }) => {
  const server = await landingSite(baseURL!);
  test.skip(!server, "localhost:4321 is taken on this machine");
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
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

    // A number: WhatsApp beside Belle in the hero, and beside her in the corner.
    await withConfig(page, { whatsappLink: "https://wa.me/971501234567" });
    await page.goto(`${SITE}/`);
    await expect(page.locator(".video-bubble")).toHaveAttribute("data-state", "rest");
    await expect(page.locator(".video-bubble .bvb-act")).toHaveCount(2);
    await expect(page.locator('.video-bubble [data-kind="whatsapp"]')).toHaveAttribute("aria-label", "WhatsApp Belle");
    await page.getByRole("button", { name: "Close Belle's video greeting" }).click();
    await page.waitForTimeout(400);
    await expect(page.locator('.video-bubble [data-kind="whatsapp"]')).toBeVisible();
    await page.evaluate(() => sessionStorage.clear());
  } finally {
    server?.close();
  }
});
