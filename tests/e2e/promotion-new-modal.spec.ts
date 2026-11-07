import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { signInWritableSoftwareManager } from "../helpers/owned-manager-workspace-e2e";
import { mockStripeAllRoutes } from "../helpers/auth";
import { fieldSelectTrigger, pickFieldSelect } from "../helpers/field-select";

/** Exercise the current Kind → Content → Preview workspace on desktop and phone.
 * Preserve generation and dirty-content protection while using the shipped step controls.
 */

const HEADLINE_PLACEHOLDER = "Modern living in the heart of the city";

const SHOT_DIR = process.env.PROMOTION_SHOT_DIR ?? path.resolve(".playwright-shots");

function headlineInput(scope: ReturnType<Page["getByRole"]>) {
  return scope.getByPlaceholder(HEADLINE_PLACEHOLDER);
}

function promotionKindTrigger(dialog: Locator) {
  return fieldSelectTrigger(dialog, "promotion-new-kind");
}

async function selectPromotionKind(page: Page, dialog: Locator, label: string) {
  await pickFieldSelect(page, promotionKindTrigger(dialog), label);
}

async function openPromotionStep(dialog: Locator, name: "Kind" | "Content" | "Preview") {
  const step = dialog.getByRole("button", { name, exact: true })
    .or(dialog.getByRole("tab", { name, exact: true })).filter({ visible: true });
  await step.click();
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

  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInWritableSoftwareManager(page);
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ] as const) {
    test.describe(`Promotion UX (${viewport.name})`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("shows All / Text / Image sections and search", async ({ page }) => {
        const frame = await openPromotionSection(page);

        await expect(page.locator('[data-attr="promotion-kind-all"]')).toBeVisible();
        await expect(page.locator('[data-attr="promotion-kind-text"]')).toBeVisible();
        await expect(page.locator('[data-attr="promotion-kind-image"]')).toBeVisible();
        await expect(page.locator('[data-attr="promotion-search"]')).toBeVisible();
        await expect(page.locator('[data-attr="promotion-content-direct"]')).toBeVisible();

        await frame.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-01-promotion-list.png`,
        });
      });

      test("New promotion keeps Kind, Content and Preview in one workspace", async ({ page }) => {
        await openPromotionSection(page);
        await page.locator('[data-attr="promotion-new"]').click();

        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("New promotion", { exact: true })).toBeVisible();

        const kind = promotionKindTrigger(dialog);
        await expect(kind).toContainText("Flyer");
        await expect(dialog.getByRole("button", { name: "Next: Content", exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Next: Content", exact: true }).click();
        await expect(headlineInput(dialog)).toBeVisible();
        await dialog.getByRole("button", { name: "Next: Preview", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Generate flyer" })).toBeVisible();
        await dialog.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-03-new-modal-flyer.png`,
        });

        await openPromotionStep(dialog, "Kind");
        await selectPromotionKind(page, dialog, "Post or blurb");
        await expect(dialog.getByText("New promotion", { exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Next: Content", exact: true }).click();
        await expect(dialog.getByLabel("Channel / format", { exact: true })).toBeVisible();
        await expect(headlineInput(dialog)).toHaveCount(0);
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

        await dialog.getByRole("button", { name: "Next: Content", exact: true }).click();
        await headlineInput(dialog).fill("Sunlit 2BR — first month free");
        await dialog.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-05-flyer-content-entered.png`,
        });

        await openPromotionStep(dialog, "Kind");
        await selectPromotionKind(page, dialog, "Post or blurb");
        const confirm = page.getByRole("dialog", { name: "Switch type", exact: true });
        await expect(confirm.getByText("Switch promotion type?", { exact: true })).toBeVisible();
        await expect(confirm.getByText("The content you've entered will be discarded.", { exact: true })).toBeVisible();
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await confirm.screenshot({ path: `${SHOT_DIR}/${viewport.name}-06-type-switch-confirm.png` });
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(kind).toContainText("Flyer");
        await openPromotionStep(dialog, "Content");
        await expect(headlineInput(dialog)).toHaveValue("Sunlit 2BR — first month free");

        await openPromotionStep(dialog, "Kind");
        await selectPromotionKind(page, dialog, "Post or blurb");
        await page.getByRole("dialog", { name: "Switch type", exact: true }).getByRole("button", { name: "Switch", exact: true }).click();
        await expect(kind).toContainText("Post or blurb");
        await openPromotionStep(dialog, "Content");
        await expect(dialog.getByLabel("Channel / format", { exact: true })).toBeVisible();

        await openPromotionStep(dialog, "Kind");
        await selectPromotionKind(page, dialog, "Flyer");
        await openPromotionStep(dialog, "Content");
        await expect(headlineInput(dialog)).toHaveValue("");

        await dialog.getByRole("button", { name: /close/i }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
      });

      test("generates and retains a text promotion through the workspace steps", async ({ page }) => {
        const frame = await openPromotionSection(page);
        const list = page.locator('[data-attr="promotion-content-direct"]');
        const rows = list.locator('[data-attr^="promotion-row-"]');
        const beforeIds = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-attr")));
        const beforeCount = beforeIds.length;

        await page.locator('[data-attr="promotion-new"]').click();
        const dialog = page.getByRole("dialog");
        await selectPromotionKind(page, dialog, "Post or blurb");

        const propertyTrigger = fieldSelectTrigger(dialog, "promotion-new-property");
        if (await propertyTrigger.isVisible().catch(() => false)) {
          await propertyTrigger.click();
          const listingOption = page.getByRole("option").filter({ hasNotText: /^custom/i });
          if ((await listingOption.count()) > 0) {
            await listingOption.first().click();
          } else {
            await page.keyboard.press("Escape");
          }
        }
        await dialog.getByRole("button", { name: "Next: Content", exact: true }).click();
        await expect(dialog.getByLabel("Channel / format", { exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Next: Preview", exact: true }).click();
        const savedPromotion = page.waitForResponse((response) => {
          if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/portal-promotions") return false;
          const body = response.request().postDataJSON() as { action?: string; row?: { id?: string; status?: string; textCopies?: unknown[] } };
          return body.action === "upsert" && body.row?.status === "generated" && typeof body.row.id === "string"
            && Array.isArray(body.row.textCopies) && body.row.textCopies.length === 1
            && !beforeIds.some((id) => id?.startsWith(`promotion-row-${body.row?.id}::`));
        });
        await dialog.getByRole("button", { name: "Generate promotion text", exact: true }).click();
        const saveResponse = await savedPromotion;
        expect(saveResponse.ok(), "The generated promotion must be saved by the server").toBe(true);
        const savedBody = saveResponse.request().postDataJSON() as {
          row?: { id?: string; textCopies?: { id?: string }[] };
        };
        const savedRecordId = savedBody.row?.id;
        const savedEntryId = savedBody.row?.textCopies?.[0]?.id;
        if (typeof savedRecordId !== "string" || !savedRecordId.trim() || typeof savedEntryId !== "string" || !savedEntryId.trim()) {
          throw new Error("Promotion upsert must identify the generated record and text entry.");
        }
        const savedRowAttr = `promotion-row-${savedRecordId}::text::${savedEntryId}`;

        const preview = page.getByRole("dialog");
        await expect(preview.getByRole("heading", { name: /^View · / })).toBeVisible();
        await expect(preview.getByRole("button", { name: "Copy text", exact: true })).toBeVisible();
        await preview.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(rows).toHaveCount(beforeCount + 1);
        const createdId = await rows.evaluateAll((elements, previous) => elements
          .map((element) => element.getAttribute("data-attr")).find((id) => id && !previous.includes(id)), beforeIds);
        expect(createdId, "The new list row must match the server-accepted upsert").toBe(savedRowAttr);
        await page.evaluate(() => sessionStorage.removeItem("axis:manager-promotions:v1"));
        const reloadedPromotions = page.waitForResponse((response) =>
          response.request().method() === "GET" && new URL(response.url()).pathname === "/api/portal-promotions",
        );
        await page.reload();
        const loadResponse = await reloadedPromotions;
        expect(loadResponse.ok(), "Reload must read promotions successfully from the server").toBe(true);
        const serverRows = await loadResponse.json() as { rows?: { id?: string; textCopies?: { id?: string }[] }[] };
        expect(serverRows.rows?.some((row) => row.id === savedRecordId && row.textCopies?.some((entry) => entry.id === savedEntryId)),
          "The server read must contain the exact generated record and text entry").toBe(true);
        await expect(list.locator(`[data-attr="${createdId}"]`)).toBeVisible();
        await frame.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-07-text-promotion-created.png`,
        });
      });
    });
  }
});
