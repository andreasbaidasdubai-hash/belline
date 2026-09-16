import { expect, test } from "./helpers";

/**
 * Setup resumes where the owner left it (P0-5).
 *
 * Sign up, set the business up by hand, choose where bookings go, and stop on
 * step five. A refresh stays on step five; signing out and in again lands on
 * the dashboard, whose full menu is there and whose checklist points at step five.
 * At 375px the step's primary button is on screen without scrolling.
 *
 *   npx playwright test --config playwright.selfserve.config.ts journey-resume
 */

test("close at step five, sign in again, and land on step five", async ({ page, context }) => {
  const run = Date.now();
  const email = `owner+journey${run}@example.com`;
  const password = "Correct-Horse-Battery-9";

  await page.goto("/checkout");
  await page.getByLabel("Business name").fill(`Journey Spec Studio ${run}`);
  await page.getByLabel("Your email").fill(email);
  await page.getByLabel("Choose a password").fill(password);
  await page.locator("#acceptTerms").check();
  await page.getByRole("button", { name: "Start free trial" }).click();
  await page.waitForURL("**/setup/import");

  await page.getByRole("button", { name: "Set it up by hand" }).first().click();
  await expect(page).toHaveURL(/\/setup\/review$/);
  await page.getByLabel("Address").fill("Shop 4, Jumeirah Beach Road, Dubai");
  await page.getByRole("button", { name: "Add a service" }).click();
  await page.getByLabel("Service 1 name").fill("Cut");
  await page.getByLabel("Service 1 minutes").fill("45");
  await page.locator("#review-staff").fill("Layla");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add a question" }).click();
  await page.getByLabel("Question 1").fill("Is there parking?");
  await page.getByLabel("Answer 1").fill("Yes, behind the building.");
  await page.getByRole("button", { name: "That's right — save it" }).click();

  await page.waitForURL("**/setup/bookings");
  await expect(page.getByRole("button", { name: "Use this" })).toBeInViewport();
  // Options that are not built are shown as they are, and cannot be chosen.
  await expect(page.getByRole("radio", { name: /Google Calendar/ })).toBeDisabled();
  await page.getByRole("button", { name: "Use this" }).click();

  await page.waitForURL("**/setup/rules");
  await expect(page.getByText("Step 5 · Your rules")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm these rules" })).toBeInViewport();

  await page.reload();
  await expect(page).toHaveURL(/\/setup\/rules$/);

  // The dashboard, before going live: the full menu, and a checklist whose next item is step five.
  // (Before 2026-09-16 the menu collapsed to Setup and Account until Go live.)
  await page.goto("/");
  await expect(page.getByTestId("journey-next")).toHaveText("Next: Your rules");
  await expect(page.getByTestId("setup-checklist")).toContainText("4 of 7 done");
  await expect(page.locator("nav.nav")).toContainText("Today");

  // Go live cannot be reached ahead of the steps before it.
  await page.goto("/setup/golive");
  await expect(page.getByRole("button", { name: "Go live" })).toHaveCount(0);

  await context.clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Signing in lands on the dashboard, and its checklist resumes on step five.
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.getByTestId("journey-next")).toHaveAttribute("href", "/setup/rules");
});
