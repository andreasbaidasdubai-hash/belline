import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { BREAKPOINTS } from "../playwright.config";

/**
 * The evidence loop.
 *
 * Design quality is judged from rendered pixels, never from source — so this
 * captures every page at every width into `audit/`, and in the same pass
 * checks the things a screenshot cannot show: console errors, horizontal
 * overflow, and WCAG violations.
 *
 *   npm run audit
 */

const PAGES = [
  { slug: "home", url: "/" },
  { slug: "dental", url: "/dental/" },
  { slug: "clinics", url: "/clinics/" },
  { slug: "salons", url: "/salons/" },
  { slug: "restaurants", url: "/restaurants/" },
  { slug: "plan", url: "/plan.html" },
  { slug: "market", url: "/market.html" },
  { slug: "golive", url: "/golive.html" },
];

const OUT = "audit";

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

for (const page of PAGES) {
  for (const bp of BREAKPOINTS) {
    test(`${page.slug} @ ${bp.name} (${bp.width}px)`, async ({ page: browser }, testInfo) => {
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];
      browser.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      browser.on("requestfailed", (r) =>
        failedRequests.push(`${r.url()} — ${r.failure()?.errorText ?? "failed"}`),
      );

      await browser.setViewportSize({ width: bp.width, height: bp.height });
      await browser.goto(page.url, { waitUntil: "networkidle" });

      await browser.screenshot({
        path: path.join(OUT, `${page.slug}-${bp.name}.png`),
        fullPage: true,
      });

      // A page that scrolls sideways on a phone reads as broken before
      // anyone has judged a single design decision.
      const overflow = await browser.evaluate(() => {
        const de = document.documentElement;
        return {
          scrollWidth: de.scrollWidth,
          clientWidth: de.clientWidth,
          culprits: [...document.querySelectorAll<HTMLElement>("body *")]
            .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className || "(no class)"}`),
        };
      });

      testInfo.attach("diagnostics", {
        body: JSON.stringify({ overflow, consoleErrors, failedRequests }, null, 2),
        contentType: "application/json",
      });

      expect(consoleErrors, `console errors on ${page.slug}`).toEqual([]);
      expect(failedRequests, `failed requests on ${page.slug}`).toEqual([]);
      expect(
        overflow.scrollWidth,
        `${page.slug} scrolls sideways at ${bp.width}px — ${overflow.culprits.join(", ")}`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
  }

  test(`${page.slug} — WCAG 2.2 AA`, async ({ page: browser }) => {
    await browser.setViewportSize({ width: 1280, height: 800 });
    await browser.goto(page.url, { waitUntil: "networkidle" });

    const results = await new AxeBuilder({ page: browser })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();

    const summary = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 4).map((n) => n.target.join(" ")),
    }));

    fs.writeFileSync(
      path.join(OUT, `${page.slug}-a11y.json`),
      JSON.stringify(summary, null, 2),
      "utf8",
    );

    expect(summary, `accessibility violations on ${page.slug}`).toEqual([]);
  });
}
