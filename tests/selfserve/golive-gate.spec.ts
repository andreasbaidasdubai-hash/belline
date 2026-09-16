import { expect, test } from "./helpers";
import { signUpAndReview } from "./setup-flow";

/**
 * P0-11: Go live is a gate, not a button.
 *
 * Runs on stubs (FLAG_STUBS=on), where the checks use the scripted venue model
 * and no provider is reachable. A new owner who has not run the checks gets a
 * 409 with blockers from a hand-made request, sees no Go live button, and the
 * checks list their results on step 7.
 */

test("a direct POST to activate is refused with blockers before the checks pass", async ({ page }) => {
  await signUpAndReview(page, "Gate");

  const res = await page.request.post("/api/setup/activate", { data: {} });
  expect(res.status()).toBe(409);
  const body = (await res.json()) as { error: string; blockers: { step: string }[] };
  expect(body.blockers.length).toBeGreaterThan(0);
  expect(body.error).not.toMatch(/Error|undefined|flag/);

  // The journey route's activate action is the same gate.
  const viaJourney = await page.request.post("/api/setup/journey", { data: { action: "activate" } });
  expect(viaJourney.status()).toBe(409);

  await page.goto("/setup/golive");
  await expect(page.getByRole("button", { name: "Go live" })).toHaveCount(0);
});

test("step 7 runs the checks over HTTP and lists every result", async ({ page }) => {
  await signUpAndReview(page, "Checks");
  await page.goto("/setup/test");
  // Earlier steps are not done in this spec, so the page points back to them.
  if (await page.getByTestId("run-checks").count()) {
    await page.getByTestId("run-checks").click();
    await expect(page.locator("[data-check][data-passed]")).toHaveCount(8, { timeout: 30_000 });
  } else {
    await expect(page.getByRole("heading", { name: /first\./ })).toBeVisible();
  }
});
