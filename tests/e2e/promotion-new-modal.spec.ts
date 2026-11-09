import { test, expect, type Page, type Locator } from "@playwright/test";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";
import { cleanupSyntheticProperties, createSyntheticProperty, syntheticFixtureActorId } from "../helpers/synthetic-property-e2e";
import { fieldSelectTrigger, pickFieldSelect } from "../helpers/field-select";

/**
 * Promotion UX: All / Text / Image command-bar sections plus search, and
 * "New promotion" moves through Kind, Content and Preview in one workspace.
 *
 * Driven through the signed-in manager portal at /portal/promotion.
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

type PromotionFixture = { id: string; propertyId: string; actorId: string };
const createdPromotions = new WeakMap<Page, PromotionFixture[]>();
type PromotionRow = { id: string; propertyId: string | null; managerUserId: string };
async function promotionRows(page: Page): Promise<PromotionRow[]> {
  const response = await page.request.get("/api/portal-promotions");
  if (!response.ok()) throw new Error("Promotion fixture read failed.");
  const body = await response.json() as { rows?: PromotionRow[] };
  if (!Array.isArray(body.rows)) throw new Error("Promotion fixture read is invalid.");
  return body.rows;
}

test.afterEach(async ({ page }) => {
  const tracked = createdPromotions.get(page) ?? [];
  if (tracked.length) {
    const actor = await syntheticFixtureActorId(page);
    for (const fixture of tracked) {
      const matches = (await promotionRows(page)).filter((row) => row.id === fixture.id);
      if (actor !== fixture.actorId || matches.length !== 1 || matches[0].managerUserId !== actor || matches[0].propertyId !== fixture.propertyId) throw new Error("Promotion cleanup ownership mismatch.");
      const response = await page.request.post("/api/portal-promotions", { data: { action: "delete", id: fixture.id } });
      if (!response.ok() || (await promotionRows(page)).some((row) => row.id === fixture.id)) throw new Error("Promotion cleanup was not confirmed.");
    }
    createdPromotions.delete(page);
  }
  await cleanupSyntheticProperties(page);
});

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

      test("New promotion offers each kind and its content step", async ({ page }) => {
        await openPromotionSection(page);
        await page.locator('[data-attr="promotion-new"]').click();
        const dialog = page.getByRole("dialog");
        await expect(promotionKindTrigger(dialog)).toContainText("Flyer");
        await dialog.getByRole("button", { name: "Next: Content" }).click();
        await expect(headlineInput(dialog)).toBeVisible();
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
        await selectPromotionKind(page, dialog, "Post or blurb");
        await dialog.getByRole("button", { name: "Next: Content" }).click();
        await expect(dialog.locator('[data-attr="select-promotion-text-format"]')).toBeVisible();
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
        await selectPromotionKind(page, dialog, "Upload your own");
        await dialog.getByRole("button", { name: "Next: Content" }).click();
        await expect(dialog.locator('input[type="file"]').first()).toBeAttached();
      });

      test("switching type after entering content warns before discarding", async ({ page }) => {
        await openPromotionSection(page);
        await page.locator('[data-attr="promotion-new"]').click();
        const dialog = page.getByRole("dialog").first();
        await dialog.getByRole("button", { name: "Next: Content" }).click();
        await headlineInput(dialog).fill("Sunlit 2BR — first month free");
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
        await selectPromotionKind(page, dialog, "Post or blurb");
        const confirmation = page.getByRole("dialog").filter({ hasText: "Switch promotion type?" });
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(promotionKindTrigger(dialog)).toContainText("Flyer");
        await dialog.getByRole("button", { name: "Next: Content" }).click();
        await expect(headlineInput(dialog)).toHaveValue("Sunlit 2BR — first month free");
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
        await selectPromotionKind(page, dialog, "Post or blurb");
        await page.getByRole("dialog").filter({ hasText: "Switch promotion type?" }).getByRole("button", { name: "Switch", exact: true }).click();
        await expect(promotionKindTrigger(dialog)).toContainText("Post or blurb");
        await selectPromotionKind(page, dialog, "Flyer");
        await dialog.getByRole("button", { name: "Next: Content" }).click();
        await expect(headlineInput(dialog)).toHaveValue("");
      });

      test("creates a post or blurb through the promotion wizard", async ({ page }) => {
        await page.goto("/portal/promotion", { waitUntil: "domcontentloaded" });
        const fixture = await createSyntheticProperty(page);
        const frame = await openPromotionSection(page);
        const list = page.locator('[data-attr="promotion-content-direct"]');
        const actor = await syntheticFixtureActorId(page);
        const beforeIds = new Set((await promotionRows(page)).map((row) => row.id));

        await page.locator('[data-attr="promotion-new"]').click();
        const dialog = page.getByRole("dialog");
        await selectPromotionKind(page, dialog, "Post or blurb");

        const propertyTrigger = fieldSelectTrigger(dialog, "promotion-new-property");
        await expect(propertyTrigger).toBeVisible();
        await propertyTrigger.click();
        await page.getByRole("option", { name: fixture.name, exact: true }).click();
        await expect(propertyTrigger).toContainText(fixture.name);
        await dialog.getByRole("button", { name: "Next: Content" }).click();
        await dialog.getByRole("button", { name: "Next: Preview" }).click();
        await dialog.locator('[data-attr="promotion-text-generate-submit"]').click();

        const preview = page.getByRole("dialog");
        await expect(preview.getByRole("heading", { name: /^View · / })).toBeVisible();
        await expect(preview.getByRole("button", { name: "Copy text", exact: true })).toBeVisible();
        await preview.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect.poll(async () => {
          const matches = (await promotionRows(page)).filter((row) => !beforeIds.has(row.id) && row.propertyId === fixture.id && row.managerUserId === actor);
          if (matches.length === 1) {
            const saved = matches[0];
            if (!(createdPromotions.get(page) ?? []).some((row) => row.id === saved.id)) createdPromotions.set(page, [...(createdPromotions.get(page) ?? []), { id: saved.id, propertyId: fixture.id, actorId: actor }]);
          }
          return matches.length;
        }, { timeout: 15_000 }).toBe(1);
        await expect(list.getByRole("button", { name: new RegExp(fixture.name) })).toBeVisible();
        const savedId = createdPromotions.get(page)![0].id;
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(async () => (await promotionRows(page)).filter((row) => row.id === savedId && row.propertyId === fixture.id && row.managerUserId === actor).length).toBe(1);
        await expect(page.locator('[data-attr="promotion-content-direct"]').getByRole("button", { name: new RegExp(fixture.name) })).toBeVisible();
        await frame.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-07-text-promotion-created.png`,
        });
      });
    });
  }
});
