import { test, expect } from "@playwright/test";
import { signInAsManager, signInAsResident } from "../helpers/auth";
import { ownedPublicProperty } from "../helpers/owned-public-property-e2e";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Tour scheduling", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test("tours-contact page loads with account gate (no guest path)", async ({ page, request }) => {
    const property = await ownedPublicProperty(request);
    await page.context().clearCookies();
    await page.goto(`/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}`);
    await expect(page.getByRole("heading", { name: "Create your resident account", exact: true })).toBeVisible();
    await expect(page.locator('[data-attr="prospect-tour-create-account"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /schedule as a guest/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^continue$/i })).toHaveCount(0);
    await expect(page.getByText(property.title, { exact: true }).first()).toBeVisible();
  });

  test("tours-contact message requires an account and opens the resident composer after sign-in", async ({ page, request }) => {
    const property = await ownedPublicProperty(request);
    const target = `/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}&tab=message`;
    await page.context().clearCookies();
    await page.goto(target);
    await expect(page.getByRole("heading", { name: "Create your resident account", exact: true })).toBeVisible();
    await expect(page.locator('[data-attr="prospect-message-create-account"]')).toBeVisible();
    await expect(page.locator('[data-attr="property-lead-message-send"]')).toHaveCount(0);
    await signInAsResident(page);
    await page.goto(target);
    await expect(page).toHaveURL(/\/resident\/communication\/active/);
    const composer = page.getByRole("dialog", { name: "New message", exact: true });
    await expect(composer).toBeVisible();
    await expect(composer.getByPlaceholder("Write your message…")).toBeVisible();
    await composer.getByPlaceholder("Write your message…").fill("Question about this home's availability.");
    await expect(composer.locator('[data-attr="communication-compose-send"]')).toBeVisible();
  });

  test("signed-in resident reaches the valid listing tour form", async ({ page, request }) => {
    const property = await ownedPublicProperty(request);
    await signInAsResident(page);
    await page.goto(`/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}`);
    await expect(page).toHaveURL((url) => url.pathname === "/resident/tour/schedule" && url.searchParams.get("propertyId") === property.id);
    await expect(page.getByRole("heading", { name: "Schedule tour", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    await expect(page.getByText("This listing is not available to tour right now.", { exact: true })).toHaveCount(0);
  });

  test("an invalid public property link refuses tour and message entry", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/rent/tours-contact?propertyId=e2e-missing-public-property");
    await expect(page.getByText("Manager link required", { exact: true })).toBeVisible();
    await expect(page.locator('[data-attr="prospect-tour-create-account"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^continue$/i })).toHaveCount(0);
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

  test("public tours page renders", async ({ page, request }) => {
    const property = await ownedPublicProperty(request);
    await page.goto(`/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}`);
    // Should not crash
    const errorEl = page.getByText(/something went wrong|500/i);
    await expect(errorEl).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
