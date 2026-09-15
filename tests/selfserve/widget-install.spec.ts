import http from "node:http";
import type { AddressInfo } from "node:net";
import { SELFSERVE_PORT, expect, test } from "./helpers";
import { signUpAndReview } from "./setup-flow";

/**
 * Install detection for the website widget (P0-8).
 *
 * A fixture page on a second local port carries the owner's snippet. Opening
 * it makes embed.js ping /api/embed/<key>/seen, and the website page, left
 * open, flips to installed on its next 20-second poll without a click. The
 * same snippet on a port the owner did not name gets no widget.
 *
 *   npx playwright test --config playwright.selfserve.config.ts widget-install
 */

/** A local page whose snippet can be set after the server starts. */
function fixture(): Promise<{ origin: string; setSnippet: (s: string) => void; close: () => void }> {
  let snippet = "";
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><h1>Fixture salon</h1>${snippet}</body></html>`);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, setSnippet: (s) => (snippet = s), close: () => server.close() });
    });
  });
}

test("the widget loading on the named site marks it installed within 25 seconds", async ({ page, context }) => {
  test.setTimeout(90_000);
  const site = await fixture();
  const stranger = await fixture();
  try {
    await signUpAndReview(page, "Widget Spec");
    await page.goto("/website");
    await page.getByLabel("Your website addresses").fill(site.origin);
    await page.getByRole("button", { name: "Switch it on" }).click();
    const pre = page.locator("pre.widget-snippet");
    await expect(pre).toBeVisible();
    const snippet = (await pre.textContent())!.replace(/src="https?:\/\/[^/]+/, `src="http://localhost:${SELFSERVE_PORT}`);
    site.setSnippet(snippet);
    stranger.setSnippet(snippet);

    const visitor = await context.newPage();
    await visitor.goto(stranger.origin);
    await expect(visitor.locator(".belline-dock")).toHaveCount(0, { timeout: 10_000 });
    await visitor.goto(site.origin);
    await expect(visitor.locator(".belline-dock")).toBeVisible();

    await expect(page.getByText("Installed. The widget has loaded on your website.")).toBeVisible({ timeout: 25_000 });
  } finally {
    site.close();
    stranger.close();
  }
});
