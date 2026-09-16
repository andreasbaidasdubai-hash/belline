import { defineConfig, devices } from "@playwright/test";

import { SELFSERVE_PORT, selfserveEnv } from "./tests/selfserve/helpers";

/**
 * The self-serve journey, from signup to live, in a real browser.
 *
 * Separate from the site audit (`playwright.config.ts`, which serves `site/`
 * on 4321) and the dashboard specs. The app runs with `FLAG_STUBS=on` against
 * an unreachable database and a throwaway data directory, so every provider is
 * a fake, a stray outbound request throws on the server, and the browser's
 * requests to providers are blocked by `tests/selfserve/helpers.ts`.
 *
 *   npx playwright test --config playwright.selfserve.config.ts
 */
export default defineConfig({
  testDir: "./tests/selfserve",
  // The full journey switches the pool, payments and email on: its own config.
  testIgnore: "zero-touch.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${SELFSERVE_PORT}`,
    launchOptions: { args: ["--force-prefers-reduced-motion"] },
  },
  projects: [
    {
      name: "mobile-375",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, timezoneId: "Europe/Zurich" },
    },
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Dubai" },
    },
  ],
  webServer: {
    command: "node --import tsx server.ts",
    url: `http://localhost:${SELFSERVE_PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: selfserveEnv(),
  },
});
