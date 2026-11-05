import { expect, test } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

// Real authenticated dev/test rows — same pattern as portal-reliability.spec.ts.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Row-action menu surfaces", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires seeded dev/test manager");

  for (const [width, height] of [[390, 844], [375, 667]] as const) {
    test.describe(`touch ${width}x${height}`, () => {
      test.use({ hasTouch: true, isMobile: true });
      for (const position of ["first", "last"] as const) {
        test(`${position} row opens a settled sheet within the viewport`, async ({ page }) => {
          await page.setViewportSize({ width, height });
          await signInAsManager(page);
          await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
          const triggers = page.getByRole("button", { name: /^Actions for / });
          await expect(triggers.first()).toBeVisible({ timeout: 45_000 });
          const trigger = position === "first" ? triggers.first() : triggers.last();
          await trigger.scrollIntoViewIfNeeded();
          const triggerBox = (await trigger.boundingBox())!;
          expect(triggerBox.width).toBeGreaterThanOrEqual(44);
          expect(triggerBox.height).toBeGreaterThanOrEqual(44);
          await trigger.click();
          const menu = page.getByRole("menu");
          await expect(menu).toHaveAttribute("data-menu-sheet", "");
          await menu.evaluate(async (element) => {
            await Promise.all(element.getAnimations().map((animation) => animation.finished));
          });
          const box = (await menu.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
          const padding = await menu.evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom));
          expect(padding).toBeGreaterThanOrEqual(16);
          const items = menu.getByRole("menuitem");
          await expect(items.first()).toBeVisible();
          for (const item of await items.all()) {
            const itemBox = (await item.boundingBox())!;
            expect(itemBox.y).toBeGreaterThanOrEqual(0);
            expect(itemBox.y + itemBox.height).toBeLessThanOrEqual(height - padding + 1);
          }
          const menuUrl = page.url();
          await page.keyboard.press("Tab");
          expect(await menu.evaluate((element) => element.contains(document.activeElement)), "Modal menu keeps keyboard focus off background navigation").toBe(true);
          await expect(page).toHaveURL(menuUrl);
          await page.keyboard.press("Escape");
          await expect(trigger).toBeFocused();
          await trigger.click();
          await expect(menu).toBeVisible();
          await page.getByTestId("dropdown-menu-backdrop").click({ position: { x: 5, y: 5 } });
          await expect(menu).toHaveCount(0);
          await expect(trigger).toBeFocused();
        });
      }
    });
  }

  test("desktop row menu remains anchored to its trigger", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInAsManager(page);
    await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", { name: /^Actions for / }).first();
    await expect(trigger).toBeVisible({ timeout: 45_000 });
    const triggerBox = (await trigger.boundingBox())!;
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).not.toHaveAttribute("data-menu-sheet", "");
    await menu.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const box = (await menu.boundingBox())!;
    const gap = Math.min(Math.abs(box.y - (triggerBox.y + triggerBox.height)), Math.abs(triggerBox.y - (box.y + box.height)));
    expect(gap).toBeLessThanOrEqual(12);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
});

/**
 * Captain, Oct 9: on a phone the Filter opens as a bottom sheet (drag handle,
 * scrolling body, pinned footer), never an anchored popover. Desktop keeps the
 * popover. Communication's Filter (`pro-communication.tsx`) is the list used here:
 * Properties tabs render no `PortalFilterSortSheet`.
 */
test.describe("Phone Filter bottom sheet", () => {
  // The sheet-vs-popover decision reads `(pointer: fine)`, not the width alone: a
  // narrow window on a Mac deliberately keeps the anchored popover. Running this
  // block on the default desktop profile therefore asserts the sheet in the one
  // configuration the product does not promise it, and the drawer it did mount
  // settled off-screen. Emulate a touch phone so the case matches its own premise.
  test.use({ hasTouch: true, isMobile: true });
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

      // The sheet slides up from off-screen, so it is `visible` for the whole
      // ~300ms of that transform. Measuring the box the instant it appears reads
      // the START of the animation (y = viewport height) and fails a geometry
      // assertion that the settled sheet passes — poll until it comes to rest.
      await expect
        .poll(async () => {
          const box = await sheet.boundingBox();
          return box ? Math.round(box.y + box.height) : Number.POSITIVE_INFINITY;
        }, { timeout: 10_000 })
        .toBeLessThanOrEqual(height + 1);

      const sheetBox = (await sheet.boundingBox())!;
      expect(sheetBox.width).toBeGreaterThanOrEqual(width - 1);
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
