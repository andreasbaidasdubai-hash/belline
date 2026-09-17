import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";

import { selfserveEnv } from "./tests/selfserve/helpers";

/**
 * The video receptionist, in the browser, with the mock provider.
 *
 * The self-serve harness's safety — stubs on, a database that cannot exist,
 * provider keys blanked — plus video switched on for Belline's own venue with
 * the mock, which refuses to run anywhere else. No Tavus, no Daily, no model.
 *
 * The call limit is short so the warning and the end can be watched inside a
 * test. Screenshots go to VIDEO_SHOTS_DIR when it is set.
 *
 *   npx playwright test --config playwright.video.config.ts
 */
export const VIDEO_PORT = Number(process.env.VIDEO_E2E_PORT ?? 3127);
process.env.VIDEO_RUN_ID ??= `video-${Date.now()}`;

const env: Record<string, string> = {
  ...selfserveEnv(process.env.VIDEO_RUN_ID),
  PORT: String(VIDEO_PORT),
  FLAG_VIDEO_AVATAR: "on",
  VIDEO_AVATAR_PROVIDER: "mock",
  VIDEO_AVATAR_VENUES: "loc_belline",
  VIDEO_MAX_CALL_SECONDS: "45",
  VIDEO_WARN_BEFORE_SECONDS: "20",
  VIDEO_MAX_CONCURRENT_PER_VENUE: "20",
  VIDEO_MAX_SESSIONS_PER_DAY: "500",
  TAVUS_API_KEY: "",
  // The face picker spec signs an owner up; the code is read from the stub outbox.
  FLAG_EMAIL_TRANSACTIONAL: "on",
  NODE_OPTIONS: "--max-old-space-size=2048",
};
process.env.ZT_DATA_DIR = env.DATA_DIR;
process.env.VIDEO_DATA_DIR = env.DATA_DIR;
fs.mkdirSync(env.DATA_DIR, { recursive: true });

export default defineConfig({
  testDir: "./tests-video",
  globalTeardown: "./tests/selfserve/zero-touch.teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 3 * 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${VIDEO_PORT}`,
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
    launchOptions: {
      // A fake microphone, granted without a prompt. Headless Chromium on this
      // machine answers getUserMedia with NotSupportedError otherwise, whatever
      // the permission grant says, so the refusal case injects the browser's
      // own NotAllowedError instead (see the spec).
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--force-prefers-reduced-motion"],
    },
  },
  projects: [
    { name: "desktop-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    {
      name: "iphone-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: "node --import tsx server.ts",
    url: `http://localhost:${VIDEO_PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    env,
  },
});
