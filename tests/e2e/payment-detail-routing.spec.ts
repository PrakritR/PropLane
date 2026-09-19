import { test, expect } from "@playwright/test";
import { signInAsManager, mockStripeAllRoutes } from "../helpers/auth";
import { withOwnedPortalRecordFixture } from "../helpers/owned-portal-record-fixture";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Payment detail routing", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInAsManager(page);
  });

  test("opens payment detail without double /payments in URL", async ({ page }) => {
    await withOwnedPortalRecordFixture(page, { propertyCount: 1, pendingCharge: true }, async (fixture) => {
      await page.goto("/portal/payments/incoming/pending", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: /payments/i }).first()).toBeVisible({ timeout: 30_000 });

      const row = page
        .locator('[data-slot="data-list-desktop-row"]')
        .filter({ hasText: fixture.chargeTitle! });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await row.getByRole("button", { name: fixture.chargeTitle!, exact: true }).click();

      await expect(page).toHaveURL(/\/portal\/payments\/incoming\/pending\/[^/]+$/);
      expect(page.url()).toContain(fixture.chargeId!);
      expect(page.url()).not.toContain("/payments/payments/");
      expect(page.url()).not.toContain("_axis_");

      await expect(page.getByRole("button", { name: /back to payments/i })).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("text=Due date").first()).toBeVisible();
    });
  });
});
