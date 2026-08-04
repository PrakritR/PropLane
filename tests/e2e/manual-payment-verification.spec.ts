import { test, expect } from "@playwright/test";
import { signInAsManager, signInAsResident, mockStripeAllRoutes } from "../helpers/auth";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Manual payment verification UI", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test("manager can open Zelle setup with notification and Gmail filter steps", async ({ page }) => {
    await signInAsManager(page);
    await page.goto("/portal/payments");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-attr="payments-setup"]').click();
    await expect(page.getByRole("heading", { name: /choose properties for payment setup/i })).toBeVisible();
    await expect(page.locator('[data-attr="manager-payment-all-properties"]')).toBeVisible();
    await page.locator('[data-attr="manager-payment-properties-continue"]').click();
    await expect(page.getByRole("heading", { name: /payment setup/i })).toBeVisible();
    await page.getByRole("button", { name: /link zelle/i }).click();

    await expect(page.getByRole("heading", { name: /link zelle/i })).toBeVisible();
    await expect(page.getByText(/step 2 — turn on zelle email notifications/i)).toBeVisible();
    await expect(page.getByText(/step 3 — link gmail/i)).toBeVisible();
    await expect(page.getByText(/step 4 — forward zelle receipts/i)).toBeVisible();
    await expect(page.getByText(/forward it to/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^copy$/i }).first()).toBeVisible();
  });

  test("resident payments page exposes check payment for manual methods", async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInAsResident(page);
    await page.goto("/resident/payments");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });

    const zelleMethod = page.locator('[data-attr="resident-payments-method-zelle"]');
    if (await zelleMethod.isVisible().catch(() => false)) {
      await zelleMethod.click();
      const payButton = page.getByRole("button", { name: /^pay /i }).first();
      if (await payButton.isVisible().catch(() => false)) {
        await payButton.click();
        await expect(page.getByRole("button", { name: /check payment/i })).toBeVisible();
      }
    }
  });

  test("application fee check API returns not-paid for unknown listing", async ({ request }) => {
    const res = await request.post("/api/public/application-fee-check-payment", {
      data: {
        propertyId: "e2e-unknown-property",
        residentEmail: "e2e-check@example.com",
        channel: "zelle",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { paid?: boolean; message?: string };
    expect(body.paid).toBe(false);
    expect(body.message).toMatch(/haven't received|not paid/i);
  });
});
