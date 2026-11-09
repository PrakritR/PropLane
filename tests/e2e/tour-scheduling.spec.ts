import { test, expect, type Page } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";
import { e2eToursContactUrl } from "../helpers/public-urls";
import { cleanupSyntheticPublicTourManager, createSyntheticPublicTourManager, type SyntheticPublicTourManager } from "../helpers/synthetic-public-tour-manager";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Tour scheduling", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  const publicFixtureByPage = new WeakMap<object, SyntheticPublicTourManager>();
  async function openOwnedPublicTourLink(browser: import("@playwright/test").Browser, page: Page, tab?: "message") {
    test.setTimeout(180_000);
    const manager = await createSyntheticPublicTourManager(browser);
    publicFixtureByPage.set(page, manager);
    // Keep the public surface signed out so these assertions exercise its
    // intended prospect gate while the linked property is a valid owned row.
    await page.context().clearCookies();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    const query = new URLSearchParams({ propertyId: manager.property.id });
    if (tab) query.set("tab", tab);
    await page.goto(`/rent/tours-contact?${query.toString()}`);
  }

  test.afterEach(async ({ page }) => {
    const fixture = publicFixtureByPage.get(page);
    if (!fixture) return;
    await cleanupSyntheticPublicTourManager(fixture);
    publicFixtureByPage.delete(page);
  });

  test("tours-contact page requires a resident account before submitting", async ({ browser, page }) => {
    await openOwnedPublicTourLink(browser, page);
    await expect(page.getByRole("heading", { name: "Book a tour", exact: true })).toBeVisible({ timeout: 15_000 });
    const openDays = page.getByRole("group", { name: "Open days" });
    await expect(openDays.getByRole("button").first()).toBeVisible({ timeout: 25_000 });
    await openDays.getByRole("button").first().click();
    const firstTime = page.locator(".ps-j-times button").first();
    await expect(firstTime).toBeVisible({ timeout: 10_000 });
    await firstTime.click();
    await page.getByRole("button", { name: "Continue", exact: true }).last().click();
    await expect(page.locator('[data-attr="tour-account-step"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-attr="tour-account-email"]')).toHaveAttribute("href", /\/auth\/create-account/);
    await expect(page.getByRole("link", { name: "Continue with email", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /schedule as a guest/i })).toHaveCount(0);
    await expect(page.locator('[data-attr="tour-book-submit"]')).toHaveCount(0);
  });

  test("tours-contact page has message or topic input", async ({ browser, page }) => {
    await openOwnedPublicTourLink(browser, page, "message");
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
