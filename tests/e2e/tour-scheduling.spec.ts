import { test, expect } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";
import { e2eToursContactUrl } from "../helpers/public-urls";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Tour scheduling", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test("tours-contact page loads with form fields", async ({ page }) => {
    await page.goto(e2eToursContactUrl());
    await expect(page.getByRole("heading", { name: /schedule tour/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^continue$/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("searchbox").first()).toBeVisible({ timeout: 10_000 });
  });

  test("tours-contact page has message or topic input", async ({ page }) => {
    await page.goto(e2eToursContactUrl({ tab: "message" }));
    await expect(page.getByRole("heading", { name: /message proplane/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/what do you need help with/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder("Tell us more so we can help…")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-attr="property-lead-message-send"]')).toBeVisible({ timeout: 10_000 });
  });

  test("manager calendar page shows calendar controls", async ({ page }) => {
    await signInAsManager(page);
    await page.goto("/portal/calendar/tours");
    await expect(page).toHaveURL(/\/portal\/calendar\/tours/);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Previous week" }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("manager calendar shows upcoming events section", async ({ page }) => {
    await signInAsManager(page);
    await page.goto("/portal/calendar/tours");
    await expect(page).toHaveURL(/\/portal\/calendar\/tours/);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    // Calendar grid or schedule view should be present
    const calEl = page
      .locator("table, .calendar, .fc, [data-testid='calendar']")
      .or(page.getByText(/schedule|upcoming|tour/i))
      .first();
    await expect(calEl).toBeVisible({ timeout: 15_000 });
  });

  test("public tours page renders", async ({ page }) => {
    await page.goto(e2eToursContactUrl());
    // Should not crash
    const errorEl = page.getByText(/something went wrong|500/i);
    await expect(errorEl).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
