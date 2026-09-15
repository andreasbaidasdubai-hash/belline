import { expect, test } from "./helpers";

/**
 * Setup keeps what the owner typed (P0-3), and a failed import says so in
 * plain words with a way forward (P0-4).
 *
 * Runs on stubs with no model switched on, which is exactly the import
 * failure path: reading the website is refused honestly, and the owner sets
 * it up by hand on the same review form. Then the edits must survive a reload.
 *
 *   npx playwright test --config playwright.selfserve.config.ts setup-review
 */

test("a failed import offers the form, and edited hours and prices survive a reload", async ({ page }) => {
  const run = Date.now();
  await page.goto("/checkout");
  await page.getByLabel("Business name").fill(`Review Spec Salon ${run}`);
  await page.getByLabel("Your email").fill(`owner+${run}@example.com`);
  await page.getByLabel("Choose a password").fill("Correct-Horse-Battery-9");
  await page.locator("#acceptTerms").check();
  await page.getByRole("button", { name: "Start free trial" }).click();
  await page.waitForURL("**/setup/import");

  // Import failure: the mapped sentence and the button, never vendor text.
  await page.getByLabel("Your website address").fill("example.ae");
  await page.getByRole("button", { name: "Read my website" }).click();
  await expect(page.getByRole("alert")).toContainText("being prepared");
  await expect(page.locator("body")).not.toContainText(/API_KEY|ECONN|Expected one of/);
  await expect(page.getByRole("button", { name: "Set it up by hand" }).last()).toBeVisible();
  expect(await page.locator('a[href^="mailto:hello@"]').count()).toBe(0);

  await page.getByRole("button", { name: "Set it up by hand" }).last().click();
  await page.getByLabel("Opening hours").fill("12:00–23:30 every day");
  await expect(page.getByTestId("hours-preview")).toContainText("12:00–23:30");
  await page.getByLabel("Address").fill("Shop 4, Jumeirah Beach Road, Dubai");

  await page.getByRole("button", { name: "Add a service" }).click();
  await page.getByLabel("Service 1 name").fill("Cut");
  await page.getByLabel("Service 1 minutes").fill("45");
  await page.getByLabel("Service 1 price").fill("120");
  await page.locator("#review-staff").fill("Layla");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add a question" }).click();
  await page.getByLabel("Question 1").fill("Is there parking?");
  await page.getByLabel("Answer 1").fill("Yes, behind the building.");

  await page.getByRole("button", { name: "That's right — save it" }).click();
  // Saved, and on to the next step of the journey.
  await page.waitForURL("**/setup/bookings");

  // Reload the form and edit a price and the hours again.
  await page.goto("/setup?manual=1");
  await expect(page.getByLabel("Opening hours")).toHaveValue("Every day 12:00-23:30");
  await expect(page.getByLabel("Service 1 price")).toHaveValue("120");
  await page.getByLabel("Service 1 price").fill("150");
  await page.getByLabel("Opening hours").fill("Sat–Thu 10–10");
  await page.getByRole("button", { name: "That's right — save it" }).click();
  await page.waitForURL("**/setup/bookings");

  await page.reload();
  await page.goto("/setup?manual=1");
  await expect(page.getByLabel("Service 1 price")).toHaveValue("150");
  await expect(page.getByLabel("Opening hours")).toHaveValue("Mon-Thu 10:00-22:00; Fri closed; Sat-Sun 10:00-22:00");
  await expect(page.locator("ul[aria-label='Staff']")).toContainText("Layla");
});
