import { expect, test } from "./helpers";
import { signUpAndReview } from "./setup-flow";

/**
 * Where bookings go (P0-6).
 *
 * A new owner is offered requests and a booking link; Google and Outlook show
 * their flag state (off here, so "Coming soon") and cannot be chosen; asking
 * for Fresha records the request and says so, and connects nothing.
 *
 *   npx playwright test --config playwright.selfserve.config.ts destination
 */

test("choose a booking link, see calendars as they are, and request Fresha", async ({ page }) => {
  await signUpAndReview(page, "Destination Spec");

  await expect(page.getByRole("button", { name: "Use this" })).toBeInViewport();
  await expect(page.getByRole("radio", { name: /Google Calendar/ })).toBeDisabled();
  await expect(page.getByRole("radio", { name: /Outlook/ })).toBeDisabled();
  await expect(page.getByText("Coming soon", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("radio", { name: /Belline's diary/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Request Fresha" }).click();
  await expect(page.getByText("We'll let you know when Fresha is ready.")).toBeVisible();

  await page.getByRole("radio", { name: /I have a booking link/ }).check();
  await page.getByLabel("Your booking link").fill("https://book.example-salon.test");
  await page.getByRole("button", { name: "Use this" }).click();
  await page.waitForURL("**/setup/rules");
});
