import { expect, test } from "./helpers";
import { signUpAndReview } from "./setup-flow";

/**
 * Billing (P0-15) with `billing.stripe` off, as the stubbed server runs by
 * default: the usage choice can be made during the trial and is saved, and the
 * checkout says payments open soon rather than offering an email address or
 * a button that fails. The flag-on checkout (fake Stripe, the webhook
 * delivered twice, one subscription) runs in check:billing.
 *
 *   npx playwright test --config playwright.selfserve.config.ts billing
 */

test("trial: choose Stop at the allowance, and it is saved", async ({ page }) => {
  await signUpAndReview(page, "Billing Spec");
  await page.goto("/billing");
  const panel = page.locator(".panel", { has: page.getByText("When an allowance runs out") });
  await expect(panel.getByText("applies from your first plan")).toBeVisible();
  await panel.getByLabel(/Stop at the allowance/).check();
  await panel.getByRole("button", { name: "Save choice" }).click();
  await expect(panel.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.locator(".panel", { has: page.getByText("When an allowance runs out") }).getByLabel(/Stop at the allowance/)).toBeChecked();
});

test("payments closed: Payments open soon, no email address, no checkout call", async ({ page }) => {
  await signUpAndReview(page, "Billing Closed Spec");
  const checkoutCalls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/checkout")) checkoutCalls.push(req.url());
  });
  await page.goto("/checkout");
  await expect(page.getByRole("button", { name: "Payments open soon" })).toBeDisabled();
  await expect(page.locator("body")).not.toContainText(/hello@|Pay and go live/);
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
  expect(checkoutCalls).toEqual([]);
});
