import { test, expect } from "@playwright/test";
import path from "node:path";
import { mockStripeCheckoutRoutes } from "../helpers/auth";
import { gotoAppPath, pathToUrlRegExp } from "../helpers/url-match";
import { RESIDENT_PORTAL_SMOKE_PATHS } from "../../src/lib/portals/resident-sections";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.use({ storageState: path.join(__dirname, "../.auth/resident.json") });

const RESIDENT_SECTIONS = [
  ...RESIDENT_PORTAL_SMOKE_PATHS,
  { label: "Services", path: "/resident/services" },
] as const;

test.describe("Resident portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeCheckoutRoutes(page);
    await page.goto("/resident/dashboard", { waitUntil: "domcontentloaded" });
  });

  test("dashboard loads", async ({ page }) => {
    await page.goto("/resident/dashboard");
    await expect(page).toHaveURL(/\/resident\/dashboard/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("payments section loads", async ({ page }) => {
    await page.goto("/resident/payments");
    await expect(page).toHaveURL(/\/resident\/payments/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("all resident sections load via direct navigation", async ({ page }) => {
    test.setTimeout(180_000);
    for (const { path } of RESIDENT_SECTIONS) {
      try {
        await gotoAppPath(page, path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Session expired")) throw error;
        await page.goto("/resident/dashboard", { waitUntil: "domcontentloaded" });
        await gotoAppPath(page, path);
      }
      await expect(page).toHaveURL(pathToUrlRegExp(path));
      await expect(page.getByRole("heading").first().or(page.locator("main")).first()).toBeVisible({
        timeout: 30_000,
      });
    }
  });

  test("dashboard shows application status indicator", async ({ page }) => {
    await page.goto("/resident/dashboard");
    // Should show some status indicator (approved/active or checklist)
    const statusEl = page.getByText(/approved|active|welcome|dashboard/i).first();
    await expect(statusEl).toBeVisible({ timeout: 10_000 });
  });

  test("inbox tab loads and compose modal can be opened", async ({ page }) => {
    await page.goto("/resident/communication/active");
    await expect(page.getByRole("heading").first()).toBeVisible();
    const composeBtn = page.getByRole("button", { name: /new message|compose/i }).first();
    if (await composeBtn.count() > 0) {
      await composeBtn.click();
      await expect(
        page.locator("#communication-compose-subject").or(page.getByPlaceholder("Subject")),
      ).toBeVisible({ timeout: 8_000 });
      const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
      if (await cancelBtn.count() > 0) {
        await cancelBtn.click();
      } else {
        await page.keyboard.press("Escape");
      }
    }
  });

  test("services tab shows unified add-on and maintenance sections", async ({ page }) => {
    await page.goto("/resident/services");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(page.getByText("Add-on services")).toBeVisible();
    await expect(page.getByText("Maintenance")).toBeVisible();
  });

  test("legacy services sub-paths redirect to unified services", async ({ page }) => {
    await page.goto("/resident/services/requests");
    await expect(page).toHaveURL(/\/resident\/services\/?$/, { timeout: 15_000 });
    await expect(page.getByText("Add-on services")).toBeVisible();
  });

  test("documents receipts tab loads", async ({ page }) => {
    await page.goto("/resident/documents/receipts");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("legacy finances path redirects to payments", async ({ page }) => {
    await page.goto("/resident/finances/summary");
    await expect(page).toHaveURL(/\/resident\/payments/, { timeout: 15_000 });
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("move-in tab loads", async ({ page }) => {
    await page.goto("/resident/move-in");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  });
});
