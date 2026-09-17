import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";

import { SELFSERVE_PORT, selfserveEnv } from "./tests/selfserve/helpers";

/**
 * The whole self-serve journey, signup to live, in one run (plan section 5).
 *
 * Its own config because it switches on what the other self-serve specs test
 * switched off: the number pool, card payments and transactional email, all
 * against their fakes. Everything else is `playwright.selfserve.config.ts`:
 * stubs on, a database that cannot exist, provider keys blanked, provider
 * hosts blocked in the browser.
 *
 * The data directory is new for every run and deleted afterwards. The run id
 * goes into the environment once, so the runner and its worker (which loads
 * this file again) agree on the directory.
 *
 *   npx playwright test --config playwright.zero-touch.config.ts
 */
process.env.ZT_RUN_ID ??= `zt-${Date.now()}`;
const env: Record<string, string> = {
  ...selfserveEnv(process.env.ZT_RUN_ID),
  FLAG_NUMBERS_POOL: "on",
  FLAG_BILLING_STRIPE: "on",
  FLAG_EMAIL_TRANSACTIONAL: "on",
  FLAG_LIFECYCLE_SEND: "off",
  STUB_POOL: "+97140000001,+97140000002",
  // Compiling every route on demand in one process runs the default heap out,
  // and a server that dies mid-request looks like a product bug from the test.
  // Asking for more than the machine can commit fails the same way, so this is
  // a ceiling a laptop with a couple of gigabytes free can actually give.
  NODE_OPTIONS: "--max-old-space-size=3072",
};
process.env.ZT_DATA_DIR = env.DATA_DIR;
fs.mkdirSync(env.DATA_DIR, { recursive: true });

export default defineConfig({
  testDir: "./tests/selfserve",
  testMatch: "zero-touch.spec.ts",
  globalTeardown: "./tests/selfserve/zero-touch.teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 10 * 60_000,
  // The server compiles each route on its first request, which is slower than
  // the five seconds an assertion waits by default.
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${SELFSERVE_PORT}`,
    launchOptions: { args: ["--force-prefers-reduced-motion"] },
    // Without these an element that never appears waits out the whole test.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
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
    env,
  },
});
