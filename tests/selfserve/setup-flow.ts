import type { Page } from "@playwright/test";
import { confirmEmail } from "./helpers";

/**
 * Sign up and set the business up by hand, stopping on the bookings step.
 * Shared by the specs that start there; a spec file must not import another.
 */
export async function signUpAndReview(page: Page, label: string) {
  const run = Date.now();
  await page.goto("/checkout");
  await page.getByLabel("Business name").fill(`${label} ${run}`);
  const email = `owner+${label.toLowerCase().replace(/\W+/g, "")}${run}@example.com`;
  await page.getByLabel("Your email").fill(email);
  await page.getByLabel("Choose a password").fill("Correct-Horse-Battery-9");
  await page.locator("#acceptTerms").check();
  await page.getByRole("button", { name: "Get started" }).click();
  await confirmEmail(page, email);
  await page.getByRole("button", { name: "Set it up by hand" }).first().click();
  await page.getByLabel("Address").fill("Shop 4, Jumeirah Beach Road, Dubai");
  await page.getByRole("button", { name: "Add a question" }).click();
  await page.getByLabel("Question 1").fill("Is there parking?");
  await page.getByLabel("Answer 1").fill("Yes, behind the building.");
  await page.getByRole("button", { name: "That's right — save it" }).click();
  await page.waitForURL("**/setup/bookings");
}
