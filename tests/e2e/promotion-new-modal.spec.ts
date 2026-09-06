import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fieldSelectTrigger, pickFieldSelect } from "../helpers/field-select";

/**
 * Promotion UX: one unified list (text + flyer assets) and "New promotion"
 * drops straight into the picked type's form inside one modal — no
 * intermediate "Continue" step.
 *
 * Driven through /demo, which mounts the real <ManagerPromotion /> panel with
 * seeded rows and needs no auth or Supabase.
 */

const HEADLINE_PLACEHOLDER = "Modern living in the heart of the city";

const SHOT_DIR = process.env.PROMOTION_SHOT_DIR ?? path.resolve(".playwright-shots");

function headlineInput(scope: ReturnType<Page["getByRole"]>) {
  return scope.getByPlaceholder(HEADLINE_PLACEHOLDER);
}

function promotionKindTrigger(dialog: Locator) {
  return fieldSelectTrigger(dialog, "select-promotion-new-kind");
}

async function selectPromotionKind(page: Page, dialog: Locator, label: string) {
  await pickFieldSelect(page, promotionKindTrigger(dialog), label);
}

async function openPromotionSection(page: Page) {
  // Returns the demo portal frame so screenshots crop to the portal UI.
  await page.goto("/demo");
  // The demo ships both a desktop sidebar and a mobile section strip; only one
  // is visible at a given viewport.
  await page.locator('[data-attr="demo-nav-promotion"]:visible').first().click();
  if ((page.viewportSize()?.width ?? 1280) >= 768) {
    await expect(page.getByRole("heading", { name: "Promotion", exact: true })).toBeVisible();
  }
  // The mobile panel omits the desktop title band; its list and primary
  // action identify the active section at every breakpoint.
  await expect(page.locator('[data-attr="promotion-content-direct"]')).toBeVisible();
  await expect(page.locator('[data-attr="promotion-new"]')).toBeVisible();
  // Land on the top of the panel so screenshots frame the header actions.
  await page.evaluate(() => {
    document.getElementById("demo-portal-scroll")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  return page.locator(".demo-portal-frame");
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test.describe(`Promotion UX (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("shows one unified promotion list without text/image tabs", async ({ page }) => {
      const frame = await openPromotionSection(page);

      await expect(page.locator('[data-attr="promotion-filter-text"]')).toHaveCount(0);
      await expect(page.locator('[data-attr="promotion-filter-image"]')).toHaveCount(0);
      await expect(page.locator('[data-attr="promotion-content-direct"]')).toBeVisible();

      await frame.screenshot({
        path: `${SHOT_DIR}/${viewport.name}-01-promotion-list.png`,
      });
    });

    test("New promotion opens one modal whose dropdown swaps the form inline", async ({ page }) => {
      await openPromotionSection(page);
      await page.locator('[data-attr="promotion-new"]').click();

      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("New promotion", { exact: true })).toBeVisible();

      // No intermediate step: the flyer form is already there.
      await expect(dialog.getByRole("button", { name: /^continue$/i })).toHaveCount(0);
      const kind = promotionKindTrigger(dialog);
      await expect(kind).toContainText("Flyer");
      await expect(headlineInput(dialog)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Generate flyer" })).toBeVisible();
      await dialog.screenshot({
        path: `${SHOT_DIR}/${viewport.name}-03-new-modal-flyer.png`,
      });

      // Picking "Text" swaps the body in place — same modal, still titled
      // "New promotion", no Continue.
      await selectPromotionKind(page, dialog, "Text");
      await expect(dialog.getByText("New promotion", { exact: true })).toBeVisible();
      await expect(dialog.locator('[data-attr="select-promotion-text-format"]')).toBeVisible();
      await expect(headlineInput(dialog)).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: /^continue$/i })).toHaveCount(0);
      await dialog.screenshot({
        path: `${SHOT_DIR}/${viewport.name}-04-new-modal-text.png`,
      });

      // The shared modal header closes the form.
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("switching type after entering content warns before discarding", async ({ page }) => {
      await openPromotionSection(page);
      await page.locator('[data-attr="promotion-new"]').click();
      const dialog = page.getByRole("dialog");
      const kind = promotionKindTrigger(dialog);

      await headlineInput(dialog).fill("Sunlit 2BR — first month free");
      await dialog.screenshot({
        path: `${SHOT_DIR}/${viewport.name}-05-flyer-content-entered.png`,
      });

      // Dismissing the warning keeps the flyer form and the typed content.
      const dismissed = page.waitForEvent("dialog").then(async (d) => {
        const message = d.message();
        await d.dismiss();
        return message;
      });
      await selectPromotionKind(page, dialog, "Text");
      const message = await dismissed;
      expect(message).toMatch(/discard/i);
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(
        `${SHOT_DIR}/${viewport.name}-06-type-switch-confirm.txt`,
        `browser confirm() shown on type switch with entered content:\n${message}\n`,
      );
      await expect(kind).toContainText("Flyer");
      await expect(headlineInput(dialog)).toHaveValue(
        "Sunlit 2BR — first month free",
      );

      // Accepting it switches and discards.
      page.once("dialog", (d) => void d.accept());
      await selectPromotionKind(page, dialog, "Text");
      await expect(kind).toContainText("Text");
      await expect(dialog.locator('[data-attr="select-promotion-text-format"]')).toBeVisible();

      // Switching back shows a cleared flyer form (content was discarded).
      await selectPromotionKind(page, dialog, "Flyer");
      await expect(headlineInput(dialog)).toHaveValue("");

      // Close (X) still works.
      await dialog.getByRole("button", { name: /close/i }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("creates a text promotion straight from the type dropdown", async ({ page }) => {
      const frame = await openPromotionSection(page);
      const list = page.locator('[data-attr="promotion-content-direct"]');
      const beforeCount = await list.getByRole("checkbox").count();

      await page.locator('[data-attr="promotion-new"]').click();
      const dialog = page.getByRole("dialog");
      await selectPromotionKind(page, dialog, "Text");

      // Demo sandbox may have no listings — custom property is enough to generate.
      const propertyTrigger = fieldSelectTrigger(dialog, "select-promotion-text-property");
      if (await propertyTrigger.isVisible().catch(() => false)) {
        await propertyTrigger.click();
        const listingOption = page.getByRole("option").filter({ hasNotText: /^custom/i });
        if ((await listingOption.count()) > 0) {
          await listingOption.first().click();
        } else {
          await page.keyboard.press("Escape");
        }
      }
      await dialog.locator('[data-attr="promotion-text-generate-submit"]').click();

      // Success replaces the composer with the generated asset preview.
      const preview = page.getByRole("dialog");
      await expect(preview.getByRole("heading", { name: /^View · / })).toBeVisible();
      await expect(preview.getByRole("button", { name: "Copy text", exact: true })).toBeVisible();
      await preview.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(list.getByRole("checkbox")).toHaveCount(beforeCount + 1);
      await frame.screenshot({
        path: `${SHOT_DIR}/${viewport.name}-07-text-promotion-created.png`,
      });
    });
  });
}
