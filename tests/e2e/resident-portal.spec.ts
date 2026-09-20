import { test, expect } from "./authenticated-test";
import { mockStripeCheckoutRoutes } from "../helpers/auth";
import { gotoAppPath, pathToUrlRegExp } from "../helpers/url-match";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.use({ authRole: "resident" });

const PRE_LEASE_RESIDENT_SECTIONS = [
  { label: "Dashboard", path: "/resident/dashboard" },
  { label: "Tour", path: "/resident/tour" },
  { label: "Applications", path: "/resident/applications" },
  { label: "Lease", path: "/resident/lease" },
  { label: "Payments", path: "/resident/payments" },
  { label: "Inbox", path: "/resident/communication/active" },
  { label: "Documents", path: "/resident/documents/application" },
] as const;

async function expectSignedLeaseLock(page: import("@playwright/test").Page, label: string) {
  await expect(page).toHaveURL(/\/resident\/dashboard\/?$/, { timeout: 15_000 });
  await expect(
    page.getByRole("link", {
      name: new RegExp(`${label}: Available after your lease is signed`, "i"),
    }),
  ).toBeVisible();
}

test.describe("Resident portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeCheckoutRoutes(page);
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

  test("all pre-lease resident sections load via direct navigation", async ({ page }) => {
    test.setTimeout(180_000);
    for (const { path } of PRE_LEASE_RESIDENT_SECTIONS) {
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

  test("services stays locked until the approved resident signs a lease", async ({ page }) => {
    await page.goto("/resident/services");
    await expectSignedLeaseLock(page, "Services");
  });

  test("legacy services sub-paths preserve the signed-lease stage guard", async ({ page }) => {
    await page.goto("/resident/services/requests");
    await expectSignedLeaseLock(page, "Services");
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

  test("my home stays locked until the approved resident signs a lease", async ({ page }) => {
    await page.goto("/resident/move-in");
    await expectSignedLeaseLock(page, "My home");
  });
});
