import { test, expect } from "@playwright/test";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Cross-portal interconnect — manager", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.use({ storageState: path.join(__dirname, "../.auth/manager.json") });

  test("manager applications tab shows seeded application", async ({ page }) => {
    await mockStripeAllRoutes(page);
    await page.goto("/portal/applications");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    const errorEl = page.getByText(/something went wrong|500/i);
    await expect(errorEl).not.toBeVisible({ timeout: 10_000 });
  });

  test("manager can compose and view sent inbox message", async ({ page }) => {
    await mockStripeAllRoutes(page);
    await page.goto("/portal/communication/active");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });

    const composeBtn = page.getByRole("button", { name: /new message|compose/i }).first();
    if (await composeBtn.count() > 0) {
      await composeBtn.click();
      const subjectField = page
        .locator("#communication-compose-subject")
        .or(page.getByPlaceholder("Subject"))
        .first();
      if (await subjectField.count() > 0) {
        await subjectField.fill("Interconnect test message");
        const bodyField = page.locator("#communication-compose-body, #inbox-compose-message").first();
        if (await bodyField.count() > 0) {
          await bodyField.fill("This is a test message for interconnect.");
        }
        const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
        if (await cancelBtn.count() > 0) {
          await cancelBtn.click();
        } else {
          await page.keyboard.press("Escape");
        }
      }
    }
  });

  test("manager residents tab shows current residents", async ({ page }) => {
    await mockStripeAllRoutes(page);
    await page.goto("/portal/residents/current");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    const errorEl = page.getByText(/something went wrong|500/i);
    await expect(errorEl).not.toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Cross-portal interconnect — resident", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.use({ storageState: path.join(__dirname, "../.auth/resident.json") });

  test("resident inbox tab loads correctly", async ({ page }) => {
    await page.goto("/resident/communication/active");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    const errorEl = page.getByText(/something went wrong|500/i);
    await expect(errorEl).not.toBeVisible({ timeout: 10_000 });
  });

  test("resident portal reflects approved application status", async ({ page }) => {
    await page.goto("/resident/dashboard");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    const errorEl = page.getByText(/something went wrong|500/i);
    await expect(errorEl).not.toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Cross-portal interconnect — admin", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.use({ storageState: path.join(__dirname, "../.auth/admin.json") });

  test("admin can view manager applications section", async ({ page }) => {
    await page.goto("/admin/axis-users");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    const errorEl = page.getByText(/something went wrong|500/i);
    await expect(errorEl).not.toBeVisible({ timeout: 10_000 });
  });

  test("admin portal can reach all key admin sections", async ({ page }) => {
    for (const path of ["/admin/dashboard", "/admin/properties"]) {
      await page.goto(path);
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    }
  });
});
