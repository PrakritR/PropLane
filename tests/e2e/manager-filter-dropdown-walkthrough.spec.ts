import { test, expect, type Page, type Locator } from "@playwright/test";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";

/**
 * Manager portal filter dropdown walkthrough.
 * Run:
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3011 \
 *     E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/manager-filter-dropdown-walkthrough.spec.ts --workers=1
 */

const FILTER_SECTIONS: { path: string; label: string; fieldMatchers: RegExp[]; inline?: boolean }[] = [
  { path: "/portal/applications/pending", label: "Applications", fieldMatchers: [/^House:/i] },
  { path: "/portal/residents/current", label: "Residents", fieldMatchers: [/^House:/i] },
  { path: "/portal/leases/manager", label: "Leases", fieldMatchers: [/Property/i] },
  { path: "/portal/communication/active", label: "Communication", fieldMatchers: [/House/i, /Role/i, /Sort/i] },
  {
    path: "/portal/payments/incoming/pending",
    label: "Payments",
    fieldMatchers: [/Property/i, /Resident/i, /Sort/i],
  },
  { path: "/portal/financials/income", label: "Finances income", fieldMatchers: [/Property/i] },
  { path: "/portal/calendar/tours", label: "Calendar", fieldMatchers: [/Property/i] },
];

async function openFilterPanel(page: Page) {
  const filterBtn = page.getByRole("button", { name: /^Filter/i }).first();
  await expect(filterBtn).toBeVisible({ timeout: 20_000 });
  await filterBtn.click();
  await expect(page.locator('[data-slot="portal-filter-dropdown-panel"]')).toBeVisible({ timeout: 10_000 });
}

async function exerciseFieldDropdown(page: Page, scope: Locator, fieldMatcher: RegExp) {
  const fieldTrigger = scope.getByRole("button", { name: fieldMatcher }).first();
  await expect(fieldTrigger).toBeVisible({ timeout: 8_000 });
  await fieldTrigger.click();
  const listbox = page.getByRole("listbox").first();
  await expect(listbox).toBeVisible({ timeout: 8_000 });
  const menu = listbox.locator('xpath=ancestor::*[@data-field-select-menu][1]');
  // Position is computed after mount. Filter-panel menus open below the trigger;
  // wait for the complete menu to settle inside the viewport.
  await expect.poll(async () => {
    const trigger = await fieldTrigger.boundingBox();
    const popup = await menu.boundingBox();
    const viewport = page.viewportSize();
    if (!trigger || !popup || !viewport || popup.width <= 0 || popup.height <= 0) return false;
    const verticalGap = popup.y - (trigger.y + trigger.height);
    return verticalGap >= -1 && verticalGap <= 12 && popup.x < trigger.x + trigger.width && popup.x + popup.width > trigger.x &&
      popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= viewport.width && popup.y + popup.height <= viewport.height;
  }, { timeout: 8_000 }).toBe(true);
  await expect(listbox).toHaveCSS("overflow-y", "auto");
  const optionCount = await listbox.getByRole("option").count();
  expect(optionCount).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
}

test.describe("Manager portal filter dropdowns", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Set E2E_TESTS_ENABLED=1 after npm run test:seed");

  test.use({ storageState: path.join(__dirname, "../.auth/manager.json") });

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
  });

  test("Applications filter panel stays right of the sidebar at 1440px", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/portal/applications/pending", { waitUntil: "domcontentloaded" });
    await openFilterPanel(page);
    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeVisible({ timeout: 20_000 });
    const sidebarBox = await sidebar.boundingBox();
    const panel = page.locator('[data-slot="portal-filter-dropdown-panel"]');
    const panelBox = await panel.boundingBox();
    expect(sidebarBox).toBeTruthy();
    expect(panelBox).toBeTruthy();
    if (sidebarBox && panelBox) {
      expect(panelBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 2);
    }
  });

  for (const section of FILTER_SECTIONS) {
    test(`${section.label}: filter fields open down and scroll`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(section.path, { waitUntil: "domcontentloaded" });
      const scope = section.inline
        ? page.locator('[data-slot="portal-page-title-band"], main').first()
        : await (async () => {
            await openFilterPanel(page);
            return page.locator('[data-slot="portal-filter-dropdown-panel"]');
          })();
      for (const matcher of section.fieldMatchers) {
        await exerciseFieldDropdown(page, scope, matcher);
      }
      if (!section.inline) {
        const close = page.locator('[data-attr="portal-filter-close"]').first();
        if (await close.isVisible().catch(() => false)) {
          await close.click();
        }
      }
    });
  }
});
