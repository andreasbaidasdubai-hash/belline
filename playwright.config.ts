import { defineConfig, devices } from "@playwright/test";

/**
 * The marketing site under test.
 *
 * `npm run site` builds `public/` into `site/`, and the suites drive the
 * built output rather than the source — the build renames the landing page,
 * rewrites cross-page links and copies assets, and every one of those is a
 * step that has already shipped a broken page once.
 */
const PORT = Number(process.env.SITE_PORT ?? 4321);

/**
 * The widths the design is actually held to. Not arbitrary: 390 is an iPhone
 * 15/16, 768 an iPad portrait, 1280 the commonest laptop, 1440 the commonest
 * desktop, and 1728 a 16" MacBook Pro — the width a design that only ever
 * gets checked at 1280 tends to fall apart at.
 */
export const BREAKPOINTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1440, height: 1000 },
  { name: "wide", width: 1728, height: 1080 },
] as const;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  /**
   * 60s, not the default 30.
   *
   * `serve:site` is a twenty-line static server and the suite points eight
   * workers at it, each pulling a page plus its images and twenty-eight audio
   * clips. Under that it occasionally takes longer than thirty seconds to
   * answer one navigation — a different page each run, and the same page
   * passes alone in a second, which is the tell that it is the harness rather
   * than the site.
   *
   * Raised rather than papered over with retries: a retry would also hide a
   * page that had genuinely become slow, and slow is a real defect here.
   */
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // A screenshot the critic is meant to judge has to be deterministic:
    // no caret blink, no half-finished transition.
    launchOptions: { args: ["--force-prefers-reduced-motion"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run site && npm run serve:site -- ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
