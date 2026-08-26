import { test, expect } from "@playwright/test";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";
import { gotoAppPath, pathToUrlRegExp } from "../helpers/url-match";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.use({ storageState: path.join(__dirname, "../.auth/manager.json") });

const PAID_MANAGER_NAV = [
  { label: "Dashboard", path: "/portal/dashboard" },
  { label: "Properties", path: "/portal/properties" },
  { label: "Calendar", path: "/portal/calendar/tours" },
  { label: "Applications", path: "/portal/applications/pending" },
  { label: "Leases", path: "/portal/leases" },
  { label: "Residents", path: "/portal/residents/current" },
  { label: "Payments", path: "/portal/payments" },
  { label: "Services", path: "/portal/services/requests" },
  { label: "Task list", path: "/portal/task-list" },
  { label: "Communication", path: "/portal/communication/active" },
  { label: "Feedback", path: "/portal/bugs-feedback" },
  { label: "Team", path: "/portal/relationships" },
  { label: "Settings", path: "/portal/profile" },
] as const;

test.describe("Manager portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
    await page.goto("/portal/dashboard", { waitUntil: "domcontentloaded" });
  });

  test("dashboard loads", async ({ page }) => {
    await expect(page).toHaveURL(/\/portal\/dashboard/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("all manager sections load via direct navigation", async ({ page }) => {
    test.setTimeout(180_000);
    for (const { path, label } of PAID_MANAGER_NAV) {
      try {
        await gotoAppPath(page, path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Session expired")) throw error;
        await page.goto("/portal/dashboard", { waitUntil: "domcontentloaded" });
        await gotoAppPath(page, path);
      }
      await expect(page, `${label} should land on ${path}`).toHaveURL(pathToUrlRegExp(path));
      await expect(
        page.getByRole("heading").first().or(page.locator("main")).first(),
        `${label} should render a heading or main landmark`,
      ).toBeVisible({ timeout: 30_000 });
    }
  });

  test("legacy manager and work-orders paths redirect", async ({ page }) => {
    try {
      await page.goto("/manager/properties", { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED")) throw error;
    }
    await expect(page).toHaveURL(/\/portal\/properties/, { timeout: 30_000 });

    try {
      await page.goto("/portal/work-orders", { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED")) throw error;
    }
    await expect(page).toHaveURL(/\/portal\/services\/work-orders/, { timeout: 30_000 });
  });

  test("properties tab shows listing and create button", async ({ page }) => {
    await gotoAppPath(page, "/portal/properties");
    await expect(page.getByRole("heading").first()).toBeVisible();
    const createBtn = page
      .locator('[data-attr="manager-properties-create"]')
      .or(page.getByRole("button", { name: /^Add$/i }))
      .first();
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
  });

  test("applications tab loads with list heading", async ({ page }) => {
    await page.goto("/portal/applications");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("residents tab loads with list heading", async ({ page }) => {
    await page.goto("/portal/residents/current");
    await expect(page).toHaveURL(/residents\/current/);
    await expect(page.getByRole("heading", { name: /residents/i }).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: /previous/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /previous/i })).toHaveCount(0);
  });

  test("services tab switches between sub-tabs", async ({ page }) => {
    await page.goto("/portal/services/requests");
    await expect(page).toHaveURL(/services\/requests/);
    const workOrdersTab = page.getByRole("tab", { name: /work order/i }).or(page.getByRole("link", { name: /work order/i }));
    if (await workOrdersTab.count() > 0) {
      await workOrdersTab.first().click();
      await expect(page).toHaveURL(/services\/work-orders/, { timeout: 10_000 });
    }
  });

  test("inbox tab loads and compose modal appears", async ({ page }) => {
    await page.goto("/portal/communication/active");
    await expect(page.getByRole("heading").first()).toBeVisible();
    const composeBtn = page.getByRole("button", { name: /new message|compose/i }).first();
    if (await composeBtn.count() > 0) {
      await composeBtn.click();
      // Modal should appear with Subject field
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

  test("Communication adds a phone contact and opens its empty thread", async ({ page }) => {
    let created = false;
    const contact = {
      residentUserId: null,
      residentEmail: null,
      name: "Jordan E2E",
      directoryName: null,
      savedContactName: "Jordan E2E",
      phone: "+12065550123",
      propertyLabel: null,
      counterpartyRole: "unknown",
      conversationKey: "e2e-manager:unknown:+12065550123",
      memberKeys: ["e2e-manager:unknown:+12065550123"],
      ownerManagerUserId: "e2e-manager",
      messages: [],
    };
    await page.route("**/api/manager/sms-conversations", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workNumber: "+12065550999",
          personalPhone: null,
          phoneVerified: false,
          forwardInbound: true,
          smsConfigured: true,
          residents: created ? [contact] : [],
        }),
      });
    });
    await page.route("**/api/manager/sms-contacts", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      expect(route.request().postDataJSON()).toEqual({
        displayName: "Jordan E2E",
        phone: "(206) 555-0123",
      });
      created = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          contact: {
            conversationKey: contact.conversationKey,
            displayName: contact.savedContactName,
            phone: contact.phone,
          },
        }),
      });
    });

    await page.goto("/portal/communication/active");
    await page.locator('[data-attr="communication-add-phone-contact"]').click();
    await page.getByLabel("Name").fill("Jordan E2E");
    await page.getByLabel("Phone number").fill("(206) 555-0123");
    await page.locator('[data-attr="sms-contact-create-save"]').click();

    await expect(page).toHaveURL(/\/portal\/communication\/active\/e2e-manager%3Aunknown%3A%2B12065550123/);
    await expect(page.getByText("Jordan E2E").first()).toBeVisible();
    await expect(page.getByText("No messages in this conversation.")).toBeVisible();
  });

  test("documents tab loads with sub-tabs", async ({ page }) => {
    await page.goto("/portal/documents/income-documents");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("finances tab loads with income view", async ({ page }) => {
    await page.goto("/portal/finances/income");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("settings shows plan tier", async ({ page }) => {
    await page.goto("/portal/profile");
    await expect(page.getByRole("heading", { name: /settings/i })).toBeVisible();
    const tierLabel = page.getByText(/free|pro|business/i).first();
    await expect(tierLabel).toBeVisible({ timeout: 10_000 });
  });

  test("legacy plan path redirects to settings", async ({ page }) => {
    try {
      await page.goto("/portal/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED")) throw error;
    }
    await expect(page).toHaveURL(/\/portal\/profile/, { timeout: 15_000 });
  });

  test("team (relationships) tab loads", async ({ page }) => {
    await page.goto("/portal/relationships");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("calendar tab loads and a house week view exposes navigation", async ({ page }) => {
    await page.goto("/portal/calendar/tours", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/portal\/calendar\/tours/);
    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Previous week" }).first()).toBeVisible({
      timeout: 15_000,
    });
    const propertyFilter = page.getByRole("button", { name: /^properties$/i });
    if (await propertyFilter.isVisible().catch(() => false)) {
      await propertyFilter.click();
      const firstProperty = page.getByRole("option").nth(1);
      if (await firstProperty.isVisible().catch(() => false)) {
        await firstProperty.click();
        await expect(page.getByRole("button", { name: "Previous week" }).first()).toBeVisible({
          timeout: 15_000,
        });
      }
    }
  });
});
