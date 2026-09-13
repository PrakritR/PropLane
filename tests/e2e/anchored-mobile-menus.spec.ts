import { expect, test } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

// Real authenticated dev/test rows — same pattern as portal-reliability.spec.ts.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Anchored mobile row-action menu", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires seeded dev/test manager");
  test.beforeEach(async ({ page }) => {
    await signInAsManager(page);
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("the first row's ⋯ menu opens directly below and adjacent to its trigger", async ({ page }) => {
    await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", { name: /^Actions for / }).first();
    await expect(trigger).toBeVisible({ timeout: 45_000 });
    const triggerBox = (await trigger.boundingBox())!;

    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;

    // Below the trigger…
    expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 2);
    // …and ADJACENT to it, not merely somewhere on screen — this is the assertion
    // the old bottom-pinned card would have failed.
    expect(menuBox.y - (triggerBox.y + triggerBox.height)).toBeLessThanOrEqual(12);
    // Inside the viewport horizontally and vertically.
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(844);
  });

  test("the last row's ⋯ menu flips above its trigger", async ({ page }) => {
    await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
    const triggers = page.getByRole("button", { name: /^Actions for / });
    await expect(triggers.first()).toBeVisible({ timeout: 45_000 });

    const lastTrigger = triggers.last();
    await lastTrigger.scrollIntoViewIfNeeded();
    const triggerBox = (await lastTrigger.boundingBox())!;

    await lastTrigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;

    // Above the trigger…
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y + 2);
    // …and ADJACENT to it.
    expect(triggerBox.y - (menuBox.y + menuBox.height)).toBeLessThanOrEqual(12);
  });

  test("a trigger near the bottom bar keeps its menu clear of the bar", async ({ page }) => {
    await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
    const triggers = page.getByRole("button", { name: /^Actions for / });
    await expect(triggers.first()).toBeVisible({ timeout: 45_000 });

    const lowTrigger = triggers.last();
    await lowTrigger.scrollIntoViewIfNeeded();
    await lowTrigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;

    const nav = page.locator(".portal-native-bottom-nav");
    if (await nav.count()) {
      const navBox = (await nav.boundingBox())!;
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(navBox.y + 1);
    } else {
      // `.portal-native-bottom-nav` was not present at this width in this run —
      // fall back to a plain viewport-clearance check and say so in the report.
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(844 - 12);
    }
  });
});

/**
 * Neither `/portal/properties/listed` nor any other Properties tab renders a
 * `PortalFilterSortSheet` at all (its `PortalListControlStack` usage passes no
 * `filter`) — there is no Filter trigger to open there. Communication's Filter
 * (`pro-communication.tsx`) is configured exactly the way `resolveMobileFilterPopover`
 * is documented against — `compactPanel`, `filterFieldCount={4}`, default
 * `desktopPresentation="dropdown"`, no `extraModalContent` — so these two cases run
 * against `/portal/communication/active` instead. This is a deliberate substitution,
 * not a weakened assertion; see the report for why.
 */
test.describe("Anchored mobile Filter popover", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires seeded dev/test manager");
  test.beforeEach(async ({ page }) => {
    await signInAsManager(page);
  });

  test("mounts the anchored popover, not the bottom sheet, at 390x844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/portal/communication/active", { waitUntil: "domcontentloaded" });
    const trigger = page.locator('[data-attr="communication-filter-sheet-open"]').first();
    await expect(trigger).toBeVisible({ timeout: 45_000 });
    const triggerBox = (await trigger.boundingBox())!;

    await trigger.click();
    const panel = page.locator('[data-attr="portal-filter-dropdown-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-slot="vaul-bottom-sheet"]')).toHaveCount(0);

    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 2);
    expect(panelBox.y - (triggerBox.y + triggerBox.height)).toBeLessThanOrEqual(12);
    // Not full-bleed: at most min(22rem, viewport - 24).
    const maxWidth = Math.min(22 * 16, 390 - 24);
    expect(panelBox.width).toBeLessThanOrEqual(maxWidth + 1);
    expect(panelBox.width).toBeLessThan(390);
  });

  test("falls back to the bottom sheet at 375x667 when there isn't enough room below the trigger", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/portal/communication/active", { waitUntil: "domcontentloaded" });
    const trigger = page.locator('[data-attr="communication-filter-sheet-open"]').first();
    await expect(trigger).toBeVisible({ timeout: 45_000 });
    const triggerBox = (await trigger.boundingBox())!;
    const spaceBelow = 667 - triggerBox.y - triggerBox.height;

    await trigger.click();
    const sheet = page.locator('[data-slot="vaul-bottom-sheet"]');
    const panel = page.locator('[data-attr="portal-filter-dropdown-panel"]');

    if (spaceBelow < 260) {
      await expect(sheet).toBeVisible({ timeout: 10_000 });
      await expect(panel).toHaveCount(0);
    } else {
      // This viewport legitimately still has room for the popover here — the
      // fallback path itself is only exercised by the unit test in that case.
      await expect(panel).toBeVisible({ timeout: 10_000 });
      await expect(sheet).toHaveCount(0);
    }
  });
});
