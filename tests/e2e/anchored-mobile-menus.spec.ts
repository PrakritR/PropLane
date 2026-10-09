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
 * Captain, Oct 9: on a phone the Filter opens as a bottom sheet (drag handle,
 * scrolling body, pinned footer), never an anchored popover. Desktop keeps the
 * popover. Communication's Filter (`pro-communication.tsx`) is the list used here:
 * Properties tabs render no `PortalFilterSortSheet`.
 */
test.describe("Phone Filter bottom sheet", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires seeded dev/test manager");
  test.beforeEach(async ({ page }) => {
    await signInAsManager(page);
  });

  for (const [width, height] of [
    [390, 844],
    [375, 667],
  ] as const) {
    test(`opens a bottom sheet with a pinned footer at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/portal/communication/active", { waitUntil: "domcontentloaded" });
      const trigger = page.locator('[data-attr="communication-filter-sheet-open"]').first();
      await expect(trigger).toBeVisible({ timeout: 45_000 });

      await trigger.click();
      const sheet = page.locator('[data-slot="vaul-bottom-sheet"]');
      await expect(sheet).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-attr="portal-filter-dropdown-panel"]')).toHaveCount(0);

      const sheetBox = (await sheet.boundingBox())!;
      expect(sheetBox.width).toBeGreaterThanOrEqual(width - 1);
      expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(height + 1);
      const save = sheet.locator('[data-attr="portal-filter-save"]');
      await expect(save).toBeVisible();
      const saveBox = (await save.boundingBox())!;
      expect(saveBox.height).toBeGreaterThanOrEqual(44);
      expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(height + 1);

      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    });
  }
});
