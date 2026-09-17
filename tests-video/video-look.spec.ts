import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { blockExternal, confirmEmail } from "../tests/selfserve/helpers";

/**
 * The video face and background, against the mock provider.
 *
 *   - An owner picks a face and a background in Your business → Agent, with a
 *     live preview, and the choice is saved for their venue.
 *   - A call on a venue with a Phoenix-4 face and the Belline background keys
 *     the (drawn) green-screen stand-in onto the background.
 *
 * Screenshots go to VIDEO_SHOTS_DIR when set.
 *
 *   npx playwright test --config playwright.video.config.ts video-look
 */

const SHOTS = process.env.VIDEO_SHOTS_DIR;
const DATA = process.env.VIDEO_DATA_DIR ?? "";
const KEY = "be_belline_site";

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${info.project.name}-${name}.png`), fullPage: false });
}

function writeVenueVideo(locationId: string, settings: Record<string, unknown>) {
  const file = path.join(DATA, "video.json");
  const control = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { killSwitch: { on: false }, venues: {} };
  control.venues ??= {};
  control.venues[locationId] = { ...(control.venues[locationId] ?? {}), ...settings };
  fs.writeFileSync(file, JSON.stringify(control, null, 2));
}

test.beforeEach(async ({ context }) => {
  await blockExternal(context);
});

test("an owner picks the video face and background, with a live preview, and it is saved for their venue", async ({ page }, info) => {
  const run = `${Date.now()}${info.project.name.length}`;
  const name = `Look Spec Salon ${run}`;
  const email = `look+${run}@example.com`;
  await page.goto("/checkout");
  await page.getByLabel("Business name").fill(name);
  await page.getByLabel("Your email").fill(email);
  await page.getByLabel("Choose a password").fill("Correct-Horse-Battery-9");
  await page.locator("#acceptTerms").check();
  await page.getByRole("button", { name: "Start free trial" }).click();
  await confirmEmail(page, email);

  const locations = JSON.parse(fs.readFileSync(path.join(DATA, "locations.json"), "utf8")) as { id: string; name: string }[];
  const venue = locations.find((l) => l.name === name);
  expect(venue, "the new venue").toBeTruthy();
  // Video is switched on for the venue by staff.
  writeVenueVideo(venue!.id, { enabled: true });

  await page.goto(`/agents?loc=${encodeURIComponent(venue!.id)}`);
  const look = page.getByRole("region", { name: "Video face and background" });
  await expect(look).toBeVisible();
  await look.scrollIntoViewIfNeeded();

  const faces = look.getByRole("radiogroup", { name: "Face" }).getByRole("radio");
  expect(await faces.count()).toBeGreaterThanOrEqual(8);
  await expect(look.getByText(/written consent/)).toBeVisible();

  // A Phoenix-4.5 face keeps its room, whatever background is picked.
  await look.locator('label:has(input[value="rf90eb925bd8"])').click();
  await expect(look.locator('input[value="rf90eb925bd8"]')).toBeChecked();
  await expect(look.getByText(/keeps its own room/)).toBeVisible();

  // Choose Ruby · Office on Phoenix-4 (marked Backgrounds) and Evening navy.
  await look.locator('label:has(input[value="rcc28da86847"])').click();
  await expect(look.locator('input[value="rcc28da86847"]')).toBeChecked();
  await look.locator('label:has(input[value="evening-navy"])').click();
  await expect(look.locator('input[value="evening-navy"]')).toBeChecked();
  await expect(look.locator(".vl-circle.has-bg")).toHaveCSS("background-image", /evening-navy\.jpg/);
  await expect(look.getByText(/evening navy replaces the room/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await look.locator(".vl-body").scrollIntoViewIfNeeded();
  await shot(page, info, "look-01-picker");

  await look.getByRole("button", { name: "Save look" }).click();
  await expect(look.getByRole("status")).toHaveText("Saved — the next video call uses it.");
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, "video.json"), "utf8")).venues[venue!.id];
  expect(saved).toMatchObject({ enabled: true, faceId: "rcc28da86847", backgroundId: "evening-navy" });

  // An arbitrary face is refused by the server, and another venue is not this owner's to change.
  const bad = await page.request.patch("/api/agent/video", { data: { locationId: venue!.id, faceId: "r_not_curated" } });
  expect(bad.status()).toBe(422);
  const foreign = await page.request.patch("/api/agent/video", { data: { locationId: "loc_belline", faceId: "rcc28da86847" } });
  expect(foreign.status()).toBe(403);
});

test("a call with a Phoenix-4 face keys the green screen onto the Belline background", async ({ page }, info) => {
  writeVenueVideo("loc_belline", { faceId: "rcc28da86847", backgroundId: "belline-light" });
  try {
    await page.goto(`/embed/${KEY}/video?o=${encodeURIComponent("http://localhost:4321")}`, { referer: "http://localhost:4321/" });
    const created = page.waitForResponse((r) => r.url().endsWith(`/api/video/${KEY}/session`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Start video call" }).click();
    const body = (await (await created).json()) as { session: { background?: { src: string } } };
    expect(body.session.background?.src).toBe("/video/backgrounds/belline-light.jpg");

    const canvas = page.locator("canvas.bv-keyed");
    await expect(canvas).toHaveAttribute("data-chroma", /^(webgl|2d|raw)$/, { timeout: 20_000 });
    const mode = await canvas.getAttribute("data-chroma");
    if (mode === "raw") {
      // A headless GPU too slow to key is the documented fallback: the plain stream shows.
      await expect(page.locator("video.bv-face")).toHaveClass(/is-on/);
      test.info().annotations.push({ type: "chroma", description: `fell back: ${await canvas.getAttribute("data-chroma-reason")}` });
    } else {
      await expect(canvas).toHaveClass(/is-on/);
      await expect(page.locator("video.bv-face")).not.toHaveClass(/is-on/);
    }
    await page.waitForTimeout(800);
    if (info.project.name === "desktop-1280") await shot(page, info, `look-02-call-${mode}`);
    await page.getByRole("button", { name: "End call" }).click();
  } finally {
    writeVenueVideo("loc_belline", { faceId: undefined, backgroundId: undefined });
  }
});
