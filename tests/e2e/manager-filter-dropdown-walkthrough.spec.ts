import { test, expect, type Page, type Locator } from "@playwright/test";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";
import { expectOwnedWorkspaceReady, selectOwnedManagerWorkspace } from "../helpers/owned-manager-workspace-e2e";
import type { PortalWorkspace } from "../../src/lib/workspaces/types";

/**
 * Manager portal filter dropdown walkthrough.
 * Run:
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3011 \
 *     E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/manager-filter-dropdown-walkthrough.spec.ts --workers=1
 */

const FILTER_SECTIONS: { path: string; label: string; fieldMatchers: RegExp[]; inline?: boolean }[] = [
  { path: "/portal/applications/pending", label: "Applications", fieldMatchers: [/House/i] },
  { path: "/portal/residents/current", label: "Residents", fieldMatchers: [/House/i] },
  { path: "/portal/leases/manager", label: "Leases", fieldMatchers: [/Property/i] },
  { path: "/portal/communication/active", label: "Communication", fieldMatchers: [/House/i, /Role/i, /Sort/i] },
  {
    path: "/portal/payments/incoming/pending",
    label: "Payments",
    fieldMatchers: [/Property/i, /Resident/i, /Sort/i],
  },
  { path: "/portal/financials/general-ledger", label: "Finances general ledger", fieldMatchers: [/Property/i] },
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
  const listId = await fieldTrigger.getAttribute("aria-controls");
  expect(listId).toBeTruthy();
  const listbox = page.locator(`[id="${listId}"]`).getByRole("listbox");
  await expect(listbox).toBeVisible({ timeout: 8_000 });
  const listboxBox = await listbox.boundingBox();
  expect(listboxBox).toBeTruthy();
  if (triggerBox && listboxBox) {
    expect(listboxBox.y).toBeGreaterThanOrEqual(triggerBox.y - 4);
  }
  await expect(listbox).toHaveCSS("overflow-y", "auto");
  await expect(listbox.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
}

test.describe("Manager portal filter dropdowns", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Set E2E_TESTS_ENABLED=1 after npm run test:seed");

  test.use({ storageState: path.join(__dirname, "../.auth/manager.json") });

  let workspace: PortalWorkspace;
  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
    workspace = await selectOwnedManagerWorkspace(page);
  });

  test("Applications filter panel stays right of the sidebar at 1440px", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/portal/applications/pending", { waitUntil: "domcontentloaded" });
    await expectOwnedWorkspaceReady(page, workspace);
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


  test("Applications house filter changes real rows and reset restores them", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/portal/applications/pending", { waitUntil: "domcontentloaded" });
    await expectOwnedWorkspaceReady(page, workspace);
    // House grouping deliberately omits the house from each row. Use the
    // real flat sort so the row itself proves the selected house.
    await openFilterPanel(page);
    const initialPanel = page.locator('[data-slot="portal-filter-dropdown-panel"]');
    await initialPanel.getByRole("button", { name: /^Sort by:/ }).click();
    await page.getByRole("option", { name: "Recently updated", exact: true }).click();
    await initialPanel.locator('[data-attr="portal-filter-save"]').click();
    const rows = page.locator('[data-attr="application-list-row"]');
    await expect(rows.first()).toBeVisible();
    const before = await rows.allTextContents();
    await openFilterPanel(page);
    const panel = page.locator('[data-slot="portal-filter-dropdown-panel"]');
    const house = panel.getByRole("button", { name: /^House:/ });
    await house.click();
    const listId = await house.getAttribute("aria-controls");
    expect(listId).toBeTruthy();
    const listbox = page.locator(`[id="${listId}"]`).getByRole("listbox");
    const options = listbox.getByRole("option");
    await expect(options.first()).toBeVisible();
    const labels = await options.allTextContents();
    const index = labels.findIndex((label) => {
      const name = label.trim().toLowerCase();
      const matching = before.filter((row) => row.toLowerCase().includes(name)).length;
      return name.length > 0 && matching > 0 && matching < before.length;
    });
    expect(index, "Pending applications need rows from at least two named houses").toBeGreaterThanOrEqual(0);
    const chosen = labels[index]!.trim();
    await options.nth(index).click();
    await expect(options.nth(index)).toHaveAttribute("aria-selected", "true");
    await panel.locator('[data-attr="portal-filter-save"]').click();
    await expect.poll(async () => rows.count()).toBeLessThan(before.length);
    const filtered = await rows.allTextContents();
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((row) => row.toLowerCase().includes(chosen.toLowerCase()))).toBe(true);
    await openFilterPanel(page);
    await panel.locator('[data-attr="portal-filter-reset"]').click();
    await panel.getByRole("button", { name: /^Sort by:/ }).click();
    await page.getByRole("option", { name: "Recently updated", exact: true }).click();
    await panel.locator('[data-attr="portal-filter-save"]').click();
    await expect.poll(async () => rows.allTextContents()).toEqual(before);
  });

  for (const section of FILTER_SECTIONS) {
    test(`${section.label}: filter fields open down and scroll`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(section.path, { waitUntil: "domcontentloaded" });
      await expectOwnedWorkspaceReady(page, workspace);
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
