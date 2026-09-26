import { test, expect } from "@playwright/test";
import { signInAsManager, mockStripeAllRoutes } from "../helpers/auth";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Payment detail routing", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInAsManager(page);
  });

  test("opens payment detail without double /payments in URL", async ({ page }) => {
    await page.goto("/portal/payments/incoming/pending", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /payments/i }).first()).toBeVisible({ timeout: 30_000 });

    // Wait for the seeded live ledger row; the initial sample row is replaced
    // during hydration and its detail ID is not a persisted charge.
    const seededRow = page.locator('[data-attr="payment-list-row"]').filter({ hasText: "Ava Nguyen" }).first();
    await expect(seededRow).toBeVisible({ timeout: 30_000 });
    await seededRow.click();

    await expect(page).toHaveURL(/\/portal\/payments\/incoming\/pending\/[^/]+$/);
    expect(page.url()).not.toContain("/payments/payments/");
    expect(page.url()).not.toContain("_axis_");

    await expect(page.locator('[data-attr="payment-detail-back"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("text=Due date").first()).toBeVisible();
  });
});
