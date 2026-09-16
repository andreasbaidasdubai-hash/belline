import { expect, test } from "./helpers";
import { signUpAndReview } from "./setup-flow";

/**
 * The WhatsApp card (P0-10) with `channel.whatsapp.selfserve` off, as the
 * stubbed server runs by default: "Coming soon" with a notify-me button, no
 * email address, and Go live never waiting on it. The flag-on states run
 * against the fake Graph in check:whatsapp.
 *
 *   npx playwright test --config playwright.selfserve.config.ts whatsapp
 */

test("flag off: Coming soon, notify me, and no dead end", async ({ page }) => {
  await signUpAndReview(page, "WhatsApp Spec");
  await page.goto("/integrations");
  const card = page.locator(".panel", { has: page.getByText("WhatsApp", { exact: true }) });
  await expect(card.getByText("Coming soon")).toBeVisible();
  await expect(card).not.toContainText(/hello@|Email us|Reload this page/);
  await card.getByRole("button", { name: "Tell me when it's ready" }).click();
  await expect(card.getByText("Noted. We'll let you know when it is ready.")).toBeVisible();
});
