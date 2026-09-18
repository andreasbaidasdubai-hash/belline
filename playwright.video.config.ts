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
  // These specs all run on loc_belline, which takes the Belline ceiling now,
  // and every ceiling is clamped to what the account is configured to allow.
  VIDEO_MAX_CONCURRENT_BELLINE: "20",
  VIDEO_PROVIDER_MAX_CONCURRENT: "50",
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
  /**
   * A production build, deliberately — do not put this back on dev.
   *
   * The embed page re-derives who is framing it from the Origin/Referer header
   * on every render (src/app/embed/[key]/video/page.tsx). In dev, Next
   * re-renders server components over HMR, and an RSC re-render carries the
   * page's *own* Referer rather than the embedding site's, so the origin check
   * refuses a page it had already allowed: mid-call the live call was replaced
   * by "This page can only be opened from the website it belongs to", and
   * video-look failed on a chroma canvas that never settled because the whole
   * tree had gone. Nothing re-fetches this route in a built app, so it is a
   * dev-only path — and a built app is what a customer actually runs.
   * docs/video/README.md has the latent fragility written down.
   *
   * The build is its own process because it must not inherit the harness's
   * `NODE_ENV=development` (scripts/build-e2e.ts). The server keeps that env
   * and is switched over with `--prod`: FLAG_STUBS refuses to boot under
   * `NODE_ENV=production` (lib/flags.ts), which is what that flag is for.
   */
  webServer: {
    command: "node --import tsx scripts/build-e2e.ts && node --import tsx server.ts --prod",
    url: `http://localhost:${VIDEO_PORT}/login`,
    reuseExistingServer: false,
    // The build runs inside this command, so the window has to cover it.
    timeout: 600_000,
    env,
  },
});
