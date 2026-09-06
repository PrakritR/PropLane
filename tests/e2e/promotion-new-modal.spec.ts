import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";
import { fieldSelectTrigger, pickFieldSelect } from "../helpers/field-select";

/**
 * Promotion UX: one unified list (text + flyer assets) and "New promotion"
 * drops straight into the picked type's form inside one modal — no
 * intermediate "Continue" step.
 *
 * Driven through the signed-in manager portal at /portal/promotion.
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
  await page.goto("/portal/promotion", { waitUntil: "domcontentloaded" });
  if ((page.viewportSize()?.width ?? 1280) >= 768) {
    await expect(page.getByRole("heading", { name: "Promotion", exact: true })).toBeVisible({
      timeout: 20_000,
    });
  }
  await expect(page.locator('[data-attr="promotion-content-direct"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('[data-attr="promotion-new"]')).toBeVisible();
  await page.evaluate(() => {
    document.getElementById("portal-main-content")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  return page.locator('[data-slot="portal-page-shell"]').first();
}

test.describe("Promotion UX", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Set E2E_TESTS_ENABLED=1 after npm run test:seed");

  test.use({ storageState: path.join(__dirname, "../.auth/manager.json") });

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
  });

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

        await expect(dialog.getByRole("button", { name: /^continue$/i })).toHaveCount(0);
        const kind = promotionKindTrigger(dialog);
        await expect(kind).toContainText("Flyer");
        await expect(headlineInput(dialog)).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Generate flyer" })).toBeVisible();
        await dialog.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-03-new-modal-flyer.png`,
        });

        await selectPromotionKind(page, dialog, "Text");
        await expect(dialog.getByText("New promotion", { exact: true })).toBeVisible();
        await expect(dialog.locator('[data-attr="select-promotion-text-format"]')).toBeVisible();
        await expect(headlineInput(dialog)).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: /^continue$/i })).toHaveCount(0);
        await dialog.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-04-new-modal-text.png`,
        });

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
        await expect(headlineInput(dialog)).toHaveValue("Sunlit 2BR — first month free");

        page.once("dialog", (d) => void d.accept());
        await selectPromotionKind(page, dialog, "Text");
        await expect(kind).toContainText("Text");
        await expect(dialog.locator('[data-attr="select-promotion-text-format"]')).toBeVisible();

        await selectPromotionKind(page, dialog, "Flyer");
        await expect(headlineInput(dialog)).toHaveValue("");

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
});
