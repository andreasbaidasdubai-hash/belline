import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

/**
 * The signed-in dashboard, in a real browser.
 *
 * Runs the app itself against an empty, throwaway data directory, with no
 * database, no model key and no email provider — so a run costs nothing,
 * touches nothing real, and starts from the first-run owner setup every time.
 *
 *   npm run test:dashboard
 */
const PORT = Number(process.env.DASHBOARD_PORT ?? 3107);
const DATA_DIR = path.join(os.tmpdir(), `belline-dashboard-${Date.now()}`);

export default defineConfig({
  testDir: "./tests-dashboard",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: { args: ["--force-prefers-reduced-motion"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "node --import tsx server.ts",
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      PORT: String(PORT),
      DATA_DIR,
      DATABASE_URL: "",
      ANTHROPIC_API_KEY: "",
      RESEND_API_KEY: "",
      STRIPE_SECRET_KEY: "",
      TWILIO_ACCOUNT_SID: "",
      NODE_ENV: "development",
    },
  },
});
