import { expect, test } from "./helpers";
import { signUpAndReview } from "./setup-flow";

/**
 * The phone channel on Go live (P0-9), with the stubbed server's default flags:
 * `numbers.pool` is off, so the owner sees "being prepared" and no code or
 * placeholder anywhere. The pool-on path (Get my number, signed test call) is
 * covered by check:pool and check:channel; running it here needs
 * FLAG_NUMBERS_POOL=on added to selfserveEnv.
 *
 *   npx playwright test --config playwright.selfserve.config.ts phone
 */

test("no number yet: being prepared, no codes, no placeholder, no mailto", async ({ page }) => {
  await signUpAndReview(page, "Phone Spec");
  await page.goto("/golive");
  await expect(page.getByText("Your number is being prepared")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get my number" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("<your Belline number>");
  await expect(page.locator("body")).not.toContainText("**61*");
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
});
