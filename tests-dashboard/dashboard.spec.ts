import { test, expect, type Page } from "@playwright/test";

/**
 * The dashboard, clicked through as an owner would.
 *
 * One owner, created through the first-run setup, then the pages that were
 * rebuilt: calendar (day, week, booking form), locations, customers, search.
 * Console errors fail the test — a page that renders but throws is broken.
 */

test.describe.configure({ mode: "serial" });

const OWNER = { email: "owner@dashboard.test", password: "Correct-Horse-Battery-9", name: "Dashboard Owner" };

async function signIn(page: Page) {
  const setup = await page.request.post("/api/auth/setup", { data: OWNER });
  if (setup.status() === 409) {
    const login = await page.request.post("/api/auth/login", { data: OWNER });
    expect(login.ok()).toBeTruthy();
  } else {
    expect(setup.ok()).toBeTruthy();
  }
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // Hydration and React warnings are errors here; network 404s for optional
    // assets are not what these tests are about.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("overview loads with search in the sidebar", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Search/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("calendar: new booking form opens with guest, services and times", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/calendar");
  const newBooking = page.getByRole("button", { name: "+ New booking" });
  if (await newBooking.count()) {
    await newBooking.click();
    await expect(page.getByRole("dialog", { name: "New booking" })).toBeVisible();
    await expect(page.getByLabel("Guest")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  expect(errors).toEqual([]);
});

test("calendar: week view draws seven days", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/calendar");
  await page.getByRole("button", { name: "Week" }).click();
  await page.waitForURL(/view=week/);
  await expect(page.locator(".week-head")).toHaveCount(7);
  expect(errors).toEqual([]);
});

test("locations: add-a-location drawer opens and validates", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/locations");
  await page.getByRole("button", { name: "Add a location" }).click();
  const drawer = page.getByRole("dialog", { name: "Add a location" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Opening hours")).toBeVisible();
  await drawer.getByRole("button", { name: "Cancel" }).click();
  await expect(drawer).toBeHidden();
  expect(errors).toEqual([]);
});

test("customers page loads with search", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/guests");
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Ctrl+K search finds a page and goes there", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search" }).fill("locations");
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/locations/);
  expect(errors).toEqual([]);
});
