import { test, expect } from "@playwright/test";
import { signInAsManager, mockStripeAllRoutes } from "../helpers/auth";
import { E2E_ACCOUNTS } from "../fixtures";
import type { HouseholdCharge } from "@/lib/household-charges";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Payment detail routing", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInAsManager(page);
  });

  test("opens payment detail without double /payments in URL", async ({ page }) => {
    const ledgerRead = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/portal-household-charges" && response.request().method() === "GET" && response.ok(),
    );
    // Seeded settled charges are persisted. Pending may also contain a newly
    // projected next-month rent row which is not in the read snapshot yet.
    await page.goto("/portal/payments/incoming/paid", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /payments/i }).first()).toBeVisible({ timeout: 30_000 });

    // Wait for the seeded live ledger row; the initial sample row is replaced
    // during hydration and its detail ID is not a persisted charge.
    const { charges } = await (await ledgerRead).json() as { charges: HouseholdCharge[] };
    const residentCharges = charges.filter((charge) => charge.status === "paid" && charge.residentEmail?.toLowerCase() === E2E_ACCOUNTS.resident.email.toLowerCase());
    expect(residentCharges.length, "Persisted QA resident charges must be present").toBeGreaterThan(0);
    let persistedCharge: HouseholdCharge | undefined;
    await expect.poll(async () => {
      for (const charge of residentCharges) {
        const row = page.locator('[data-attr="payment-list-row"]').filter({ hasText: charge.residentName }).filter({ hasText: charge.title }).first();
        if (await row.isVisible()) {
          persistedCharge = charge;
          return true;
        }
      }
      return false;
    }, { timeout: 30_000, message: "A persisted QA resident charge must render in the paid list" }).toBe(true);
    const seededRow = page.locator('[data-attr="payment-list-row"]').filter({ hasText: persistedCharge!.residentName }).filter({ hasText: persistedCharge!.title }).first();
    await expect(seededRow).toBeVisible({ timeout: 30_000 });
    await seededRow.click();

    await expect(page).toHaveURL(/\/portal\/payments\/incoming\/paid\/[^/]+$/);
    expect(page.url()).not.toContain("/payments/payments/");
    expect(page.url()).not.toContain("_axis_");
    const openedChargeId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
    const openedPersistedCharge = residentCharges.find((charge) => charge.id === openedChargeId);
    expect(openedPersistedCharge, "Payment detail must resolve a charge returned by the persisted ledger API").toBeDefined();

    await expect(page.locator('[data-attr="payment-detail-back"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("text=Due date").first()).toBeVisible();
    // Recurring rent adds its billing period to the stored base title (e.g.
    // "Rent" becomes "Rent — November 2026"). Verify the exact record above
    // and the persisted resident/title inside its Details card.
    const details = page.locator('[data-attr="payment-overview-card-details"]');
    await expect(details.getByText(openedPersistedCharge!.residentName, { exact: true })).toBeVisible();
    await expect(details).toContainText(openedPersistedCharge!.title);
    const detailUrl = page.url();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(detailUrl);
    await expect(page.locator('[data-attr="payment-detail-back"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-attr="payment-overview-card-details"]')).toContainText(openedPersistedCharge!.residentName);
  });
});
