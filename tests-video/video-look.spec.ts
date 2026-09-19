import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { blockExternal, confirmEmail } from "../tests/selfserve/helpers";

/**
 * The video face, against the mock provider.
 *
 *   - An ordinary customer venue — signed up in this spec, and never named on
 *     any list — finds the face picker on Your business → Agent, chooses from
 *     the eight curated faces with a live preview, and the choice is saved.
 *   - A call on a venue with a Phoenix-4 face and the Belline background keys
 *     the (drawn) green-screen stand-in onto the background. Kept because the
 *     machinery is: no curated face is Phoenix-4 today, so the venue's face is
 *     written straight into the control file, the way staff would for a face
 *     recorded with consent.
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

test("an ordinary customer venue gets the face picker, and an owner's choice is saved", async ({ page }, info) => {
  const run = `${Date.now()}${info.project.name.length}`;
  const name = `Look Spec Salon ${run}`;
  const email = `look+${run}@example.com`;
  await page.goto("/checkout");
  await page.getByLabel("Business name").fill(name);
  await page.getByLabel("Your email").fill(email);
  await page.getByLabel("Choose a password").fill("Correct-Horse-Battery-9");
  await page.locator("#acceptTerms").check();
  await page.getByRole("button", { name: "Get started" }).click();
  await confirmEmail(page, email);

  const locations = JSON.parse(fs.readFileSync(path.join(DATA, "locations.json"), "utf8")) as { id: string; name: string }[];
  const venue = locations.find((l) => l.name === name);
  expect(venue, "the new venue").toBeTruthy();
  // Nothing is written to the control file: this venue is on nobody's list.
  // VIDEO_AVATAR_VENUES is a star, and that alone has to be enough.

  await page.goto(`/agents?loc=${encodeURIComponent(venue!.id)}`);
  const look = page.getByRole("region", { name: "Video face and background" });
  await expect(look).toBeVisible();
  await look.scrollIntoViewIfNeeded();

  // The eight the founder chose, each with a picture rather than a letter.
  const faces = look.getByRole("radiogroup", { name: "Face" }).getByRole("radio");
  await expect(faces).toHaveCount(8);
  for (const name of ["Ruby · Office", "Priya · Office", "Dr. Adams", "Dr. Lee", "Olivia · Office", "Mateo", "Rose · Business", "Victor · Office"]) {
    await expect(look.getByText(name, { exact: true })).toBeVisible();
  }
  const thumbs = look.locator(".vl-faces .vl-thumb img");
  await expect(thumbs).toHaveCount(8);
  expect(await thumbs.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(look.getByText(/written consent/)).toBeVisible();

  // Ruby is the default, and every curated face keeps its own room, so the
  // background picker is not offered at all.
  await expect(look.locator('input[value="rf90eb925bd8"]')).toBeChecked();
  await expect(look.getByText(/keeps its own room/)).toBeVisible();
  await expect(look.getByRole("radiogroup", { name: "Background" })).toBeHidden();

  await look.locator('label:has(input[value="r340d93adc9b"])').click();
  await expect(look.locator('input[value="r340d93adc9b"]')).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await look.locator(".vl-body").scrollIntoViewIfNeeded();
  await shot(page, info, "look-01-picker");

  await look.getByRole("button", { name: "Save look" }).click();
  await expect(look.getByRole("status")).toHaveText("Saved — the next video call uses it.");
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, "video.json"), "utf8")).venues[venue!.id];
  expect(saved).toMatchObject({ faceId: "r340d93adc9b" });
  expect(saved.enabled, "saving a face must not switch video on or off for the venue").toBeUndefined();

  // An arbitrary face is refused by the server, and another venue is not this owner's to change.
  const bad = await page.request.patch("/api/agent/video", { data: { locationId: venue!.id, faceId: "r_not_curated" } });
  expect(bad.status()).toBe(422);
  const foreign = await page.request.patch("/api/agent/video", { data: { locationId: "loc_belline", faceId: "r4dc9377a68e" } });
  expect(foreign.status()).toBe(403);
});

/**
 * The other half of the background story, and the reason it is an absence.
 *
 * Every curated face is Phoenix-4.5, and Tavus cannot replace the room behind
 * one, so no call this product can place asks for a green screen. A control
 * file naming a Phoenix-4 face falls back to the venue's real face (faces.ts
 * `venueLook` offers only what is curated), and the call must then show the
 * plain stream rather than a canvas keying a background onto nothing.
 *
 * Restore the keyed-canvas assertions here the day a Phoenix-4 look goes back
 * on `CURATED_FACES`; check:video fails if one does and this is still an
 * absence.
 */
test("no call asks for a green screen while every offered face keeps its own room", async ({ page }, info) => {
  writeVenueVideo("loc_belline", { faceId: "rcc28da86847", backgroundId: "belline-light" });
  try {
    await page.goto(`/embed/${KEY}/video?o=${encodeURIComponent("http://localhost:4321")}`, { referer: "http://localhost:4321/" });
    const created = page.waitForResponse((r) => r.url().endsWith(`/api/video/${KEY}/session`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Start video call" }).click();
    const body = (await (await created).json()) as { session: { background?: { src: string } } };
    expect(body.session.background, "a background was promised to a face that cannot take one").toBeUndefined();

    // A live call showing the face's own stream — not a keyed canvas over a
    // room the face was never lifted out of.
    await expect(page.getByRole("button", { name: "End call" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("video.bv-face")).toBeAttached();
    await expect(page.locator("canvas.bv-keyed")).toHaveCount(0);
    await page.waitForTimeout(800);
    if (info.project.name === "desktop-1280") await shot(page, info, "look-02-call-own-room");
    await page.getByRole("button", { name: "End call" }).click();
  } finally {
    writeVenueVideo("loc_belline", { faceId: undefined, backgroundId: undefined });
  }
});
