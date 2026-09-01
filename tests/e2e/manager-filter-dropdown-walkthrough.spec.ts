import { test, expect, type Page, type Locator } from "@playwright/test";
import { signIn, mockStripeAllRoutes } from "../helpers/auth";
import { E2E_ACCOUNTS } from "../fixtures";

/**
 * Manager portal filter dropdown walkthrough.
 * Run:
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3011 \
 *     E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/manager-filter-dropdown-walkthrough.spec.ts --workers=1
 */

const FILTER_SECTIONS: { path: string; label: string; fieldMatchers: RegExp[]; inline?: boolean }[] = [
  { path: "/portal/applications/pending", label: "Applications", fieldMatchers: [/Property/i] },
  { path: "/portal/residents/current", label: "Residents", fieldMatchers: [/Property/i] },
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
  const triggerBox = await fieldTrigger.boundingBox();
  expect(triggerBox).toBeTruthy();
  await fieldTrigger.click();
  const listbox = page.getByRole("listbox").first();
  await expect(listbox).toBeVisible({ timeout: 8_000 });
  const listboxBox = await listbox.boundingBox();
  expect(listboxBox).toBeTruthy();
  if (triggerBox && listboxBox) {
    expect(listboxBox.y).toBeGreaterThanOrEqual(triggerBox.y - 4);
  }
  await expect(listbox).toHaveCSS("overflow-y", "auto");
  const optionCount = await listbox.getByRole("option").count();
  expect(optionCount).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

test.describe("Manager portal filter dropdowns (demo)", () => {
  test("demo applications filter opens property menu below trigger", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/demo", { waitUntil: "domcontentloaded" });
    await page.locator('[data-attr="demo-nav-applications"]').click();
    await expect(page.getByRole("heading", { name: /Applications/i })).toBeVisible({ timeout: 20_000 });
    await openFilterPanel(page);
    await exerciseFieldDropdown(
      page,
      page.locator('[data-slot="portal-filter-dropdown-panel"]'),
      /Property/i,
    );
  });
});

test.describe("Manager portal filter dropdowns", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Set E2E_TESTS_ENABLED=1 after npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password, "/portal/dashboard");
    await page.waitForURL(/\/portal\//, { timeout: 60_000 });
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
