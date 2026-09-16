import { expect, test } from "./helpers";
import { signUpAndReview } from "./setup-flow";

/**
 * The rules step for a business taking requests (P0-7).
 *
 * At most six inputs; a transfer number outside the UAE is refused with the
 * reason; a UAE number is accepted and the journey moves on. No input sits
 * under the confirm button on a phone.
 *
 *   npx playwright test --config playwright.selfserve.config.ts rules
 */

test("refuse a foreign transfer number, accept a UAE one, in six inputs or fewer", async ({ page }) => {
  await signUpAndReview(page, "Rules Spec");
  await page.getByRole("button", { name: "Use this" }).click();
  await page.waitForURL("**/setup/rules");

  const form = page.locator("form");
  await expect(form.locator("input:visible, select:visible, textarea:visible")).toHaveCount(5);
  const confirm = page.getByRole("button", { name: "Confirm these rules" });
  await expect(confirm).toBeInViewport();

  // Nothing overlaps the button.
  const button = (await confirm.boundingBox())!;
  for (const field of await form.locator("input:visible, select:visible, textarea:visible").all()) {
    const box = (await field.boundingBox())!;
    expect(box.y >= button.y + button.height || box.y + box.height <= button.y).toBe(true);
  }

  await page.getByLabel("Number for urgent calls").fill("+44 20 7946 0958");
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("outside United Arab Emirates");
  await expect(page).toHaveURL(/\/setup\/rules$/);

  await page.getByLabel("Number for urgent calls").fill("+971 4 555 0100");
  await confirm.click();
  await page.waitForURL("**/setup/channels");
});
