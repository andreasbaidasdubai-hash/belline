import fs from "node:fs";
import path from "node:path";
import { expect, test as base, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { blockExternal } from "../tests/selfserve/helpers";

/**
 * The personalised demo page (/demo/v/<token>) as a sales page, against the
 * mock provider: Belline's logo, the blue Get started, one tap and Belle talks
 * (no session before it, and none of it waiting on the microphone prompt),
 * the packages from the catalogue, and the setup claim Belle also uses.
 *
 * A Belline staff member is written into the run's data directory, signs in,
 * and makes a link for the made-up prospect, as the console would.
 *
 * Full-page screenshots go to DEMO_SHOTS_DIR when it is set; the time from the
 * tap to Belle's first words is printed.
 *
 *   npx playwright test --config playwright.video.config.ts tests-video/demo-page.spec.ts
 */

const SHOTS = process.env.DEMO_SHOTS_DIR;
const DATA = process.env.VIDEO_DATA_DIR ?? "";
const PASSWORD = "demo-page-Staff-2026!";
const EMAIL = "demo-page-staff@belline.test";

const test = base.extend<{ aborted: unknown }>({
  aborted: [
    async ({ context }: { context: BrowserContext }, use: (value: unknown) => Promise<void>) => {
      const aborted = await blockExternal(context);
      await context.addInitScript(() => {
        const hide = () => {
          if (document.getElementById("hide-next-dev")) return;
          const style = document.createElement("style");
          style.id = "hide-next-dev";
          style.textContent = "nextjs-portal{display:none!important}";
          (document.head || document.documentElement).appendChild(style);
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hide);
        else hide();
      });
      await use(aborted);
      expect(aborted.filter((a) => /tavus|daily\.co/.test(a.url))).toEqual([]);
    },
    { auto: true },
  ],
});

async function shot(page: Page, info: TestInfo, name: string, fullPage = false) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${info.project.name}-${name}.png`), fullPage });
}

/** A staff member in Belline's own tenant, written where the server reads its users. */
async function ensureStaff() {
  process.env.DATA_DIR = DATA;
  const { createUser } = await import("../src/lib/auth");
  const { BELLINE_TENANT_ID } = await import("../src/lib/tenancy");
  const { findUserByEmail } = await import("../src/lib/store");
  if (!findUserByEmail(EMAIL)) {
    const made = createUser({ email: EMAIL, name: "Demo Page Staff", password: PASSWORD, role: "owner", tenantId: BELLINE_TENANT_ID });
    expect(made.ok, JSON.stringify(made)).toBe(true);
  }
}

async function demoLink(page: Page): Promise<string> {
  await ensureStaff();
  await expect
    .poll(async () => (await page.request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD } })).status(), { timeout: 15_000 })
    .toBe(200);
  const made = await page.request.post("/api/sales/video-demos", { data: { action: "create", leadId: 4101 } });
  const body = (await made.json()) as { link?: { url: string }; error?: string };
  expect(made.status(), JSON.stringify(body)).toBe(200);
  // Signed out again: the prospect is not a staff member.
  await page.context().clearCookies();
  return new URL(body.link!.url).pathname;
}

test("the demo page: logo, blue Get started, one tap and Belle talks, packages from the catalogue, the setup claim", async ({ page }, info) => {
  const url = await demoLink(page);
  const sessions: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/video-demo\/[^/]+\/session$/.test(new URL(r.url()).pathname) && r.method() === "POST") sessions.push(r.url());
  });

  await page.goto(url);
  const logo = page.getByRole("link", { name: "Belline home" });
  await expect(logo).toBeVisible();
  await expect(logo.locator("svg")).toHaveCount(1);
  const headerCta = page.locator('a[data-cta="header"]');
  await expect(headerCta).toHaveText("Get started");
  await expect(headerCta).toHaveCSS("background-color", "rgb(0, 113, 227)");
  await expect(page.locator('a[data-cta="closer"]')).toHaveCSS("background-color", "rgb(0, 113, 227)");
  await expect(page.getByText("Built for Harbourview Dental")).toBeVisible();

  // Packages, from the catalogue.
  const { demoPackages } = await import("../src/lib/sales/video-demo/packages");
  const packs = demoPackages("AE");
  const cards = page.locator(".dx-plan");
  await expect(cards).toHaveCount(packs.length);
  for (let i = 0; i < packs.length; i++) {
    await expect(cards.nth(i).locator("h3")).toHaveText(packs[i].name);
    await expect(cards.nth(i).locator(".dx-amt")).toHaveText(packs[i].monthly);
    expect(await cards.nth(i).getByRole("link", { name: `Get started with ${packs[i].name}` }).getAttribute("href")).toContain(`plan=${packs[i].id}`);
  }
  await expect(page.locator(".dx-plan.is-best h3")).toHaveText("Growth");
  await expect(page.locator(".dx-plan.is-best .dx-best")).toHaveText("Recommended");
  await page.getByRole("button", { name: "Annual" }).click();
  await expect(cards.nth(1).locator(".dx-amt")).toHaveText(packs[1].annualPerMonth);
  expect(await cards.nth(1).getByRole("link").getAttribute("href")).toContain("cycle=annual");
  await page.getByRole("button", { name: "Monthly" }).click();

  // The setup claim, in the words Belle uses.
  const { SETUP_CLAIM } = await import("../src/lib/seed-belline");
  await expect(page.locator("[data-setup-claim]")).toHaveText(SETUP_CLAIM);
  await expect(page.locator(".dx-faq details")).toHaveCount(3);

  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, info, "demo-page-full", true);
  await shot(page, info, "demo-page-first-screen");

  // Nothing before the tap.
  await page.waitForTimeout(1500);
  expect(sessions).toEqual([]);

  // One tap, and she talks.
  const tap = page.getByRole("button", { name: "Tap to meet Belle" });
  await expect(tap).toBeVisible();
  const t0 = Date.now();
  await tap.click();
  await expect(page.locator(".bv-status")).toHaveText(/Belle is speaking/, { timeout: 15_000 });
  const firstWordMs = Date.now() - t0;
  console.log(`[demo-page] ${info.project.name}: tap to Belle speaking ${firstWordMs} ms (mock provider)`);
  info.annotations.push({ type: "tap-to-first-word-ms", description: String(firstWordMs) });
  expect(sessions.length).toBe(1);
  await shot(page, info, "demo-page-talking");
  await page.getByRole("button", { name: "End call" }).click();
});

test("a refused microphone: Belle still starts talking, and the page offers typing instead", async ({ page, context }, info) => {
  const url = await demoLink(page);
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((_, reject) => setTimeout(() => reject(new DOMException("Permission denied", "NotAllowedError")), 1200));
  });
  await page.goto(url);
  await page.getByRole("button", { name: "Tap to meet Belle" }).click();
  // Talking before the prompt has even been answered.
  await expect(page.locator(".bv-status")).toHaveText(/Belle is speaking/, { timeout: 15_000 });
  await expect(page.locator(".bv-note")).toContainText("She'll keep talking", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Type instead" })).toBeVisible();
  await expect(page.locator(".bv-error")).toHaveCount(0);
  await shot(page, info, "demo-page-mic-refused");
  await page.getByRole("button", { name: "Type instead" }).click();
  await expect(page.getByLabel("Message Belle")).toBeVisible();
});
