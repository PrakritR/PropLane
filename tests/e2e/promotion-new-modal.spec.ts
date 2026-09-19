import { test, expect, type Page, type Locator } from "./authenticated-test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";
import { mockStripeAllRoutes } from "../helpers/auth";
import { fieldSelectTrigger, pickFieldSelect } from "../helpers/field-select";

/**
 * Promotion UX: All / Text / Image command-bar sections plus search, and
 * "New promotion" is a Kind → Content → Preview workspace.
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

test.describe("Promotion UX", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Set E2E_TESTS_ENABLED=1 after npm run test:seed");

  test.use({ authRole: "manager" });

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

      test("New promotion opens one workspace and progresses through Kind, Content, and Preview", async ({ page }) => {
        await openPromotionSection(page);
        await page.locator('[data-attr="promotion-new"]').click();

        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("New promotion", { exact: true })).toBeVisible();

        const kind = promotionKindTrigger(dialog);
        await expect(kind).toContainText("Flyer");
        await expect(dialog.getByRole("heading", { name: "Kind", exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: /continue/i })).toBeVisible();
        await dialog.locator('[data-attr="promotion-new-next"]').click();
        await expect(dialog.getByRole("heading", { name: "Content", exact: true })).toBeVisible();
        await expect(headlineInput(dialog)).toBeVisible();
        await dialog.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-03-new-modal-flyer.png`,
        });

        await dialog.locator('[data-attr="promotion-new-next"]').click();
        await expect(dialog.getByRole("heading", { name: "Preview", exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Generate flyer" })).toBeVisible();

        await dialog.locator('[data-attr="promotion-new-back"]').click();
        await expect(dialog.getByRole("heading", { name: "Content", exact: true })).toBeVisible();
        await dialog.locator('[data-attr="promotion-new-back"]').click();
        await expect(dialog.getByRole("heading", { name: "Kind", exact: true })).toBeVisible();
        await selectPromotionKind(page, dialog, "Text");
        await expect(dialog.getByRole("heading", { name: "Kind", exact: true })).toBeVisible();
        await dialog.locator('[data-attr="promotion-new-next"]').click();
        const format = fieldSelectTrigger(dialog, "select-promotion-text-format");
        await expect(format).toBeVisible();
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

        await dialog.locator('[data-attr="promotion-new-next"]').click();
        await expect(dialog.getByRole("heading", { name: "Content", exact: true })).toBeVisible();
        await headlineInput(dialog).fill("Sunlit 2BR — first month free");
        await dialog.screenshot({
          path: `${SHOT_DIR}/${viewport.name}-05-flyer-content-entered.png`,
        });

        await dialog.locator('[data-attr="promotion-new-back"]').click();
        await selectPromotionKind(page, dialog, "Text");
        const confirm = page.getByRole("dialog").filter({ hasText: "Switch type" });
        await expect(confirm).toBeVisible();
        await expect(confirm).toContainText(/discard/i);
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        fs.writeFileSync(
          `${SHOT_DIR}/${viewport.name}-06-type-switch-confirm.txt`,
          "DOM confirmation shown on type switch with entered content.\n",
        );
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(kind).toContainText("Flyer");
        await dialog.locator('[data-attr="promotion-new-next"]').click();
        await expect(dialog.getByRole("heading", { name: "Content", exact: true })).toBeVisible();
        await expect(headlineInput(dialog)).toHaveValue("Sunlit 2BR — first month free");

        await dialog.locator('[data-attr="promotion-new-back"]').click();
        await selectPromotionKind(page, dialog, "Text");
        await page.getByRole("dialog").filter({ hasText: "Switch type" }).getByRole("button", { name: "Switch", exact: true }).click();
        await expect(kind).toContainText("Text");
        await dialog.locator('[data-attr="promotion-new-next"]').click();
        await expect(fieldSelectTrigger(dialog, "select-promotion-text-format")).toBeVisible();

        await dialog.locator('[data-attr="promotion-new-back"]').click();
        await selectPromotionKind(page, dialog, "Flyer");
        await dialog.locator('[data-attr="promotion-new-next"]').click();
        await expect(headlineInput(dialog)).toHaveValue("");

        await dialog.getByRole("button", { name: /close/i }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
      });

      test("creates a text promotion through Content and Preview", async ({ page }) => {
        const target = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
        if (target.protocol !== "https:" || target.hostname !== "emstjswhotsnyksqhqyf.supabase.co" || target.port || target.username || target.password) throw new Error("Promotion fixture requires the exact dev/test database");
        const frame = await openPromotionSection(page);
        const list = page.locator('[data-attr="promotion-content-direct"]');
        const beforeIds = await list.locator('[data-attr^="promotion-select-"]').evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-attr")).filter((value): value is string => Boolean(value)),
        );
        type StoredRow = { id: string; managerUserId: string; textCopies?: { id: string; copy: Record<string, unknown> }[] };
        const readRows = async (): Promise<StoredRow[]> => {
          const response = await page.request.get("/api/portal-promotions");
          expect(response.ok(), "real promotion read succeeds").toBe(true);
          const body = await response.json();
          expect(Array.isArray(body.rows)).toBe(true);
          return body.rows;
        };
        const baselineIds = new Set((await readRows()).map(row => row.id));
        const marker = `E2E promotion ${randomUUID()}`;
        const expectedNotes = `Use the supplied listing facts. Test reference: ${marker}.`;
        const copyFingerprint = (copy: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.keys(copy).sort().map(key => [key, copy[key]])));
        let armed = false, generationCount = 0, persistedCount = 0;
        let generatedCopy: Record<string, unknown> | null = null;
        const owned = new Map<string, { entryId: string; managerId: string; copy: Record<string, unknown> }>();
        const violations: string[] = [];
        const pending = new Set<Promise<void>>();
        const handleWrite = async (route: Route) => {
          const request = route.request(), pathname = new URL(request.url()).pathname;
          if (["GET", "HEAD", "OPTIONS"].includes(request.method())) { await route.fallback(); return; }
          const body = request.postDataJSON();
          if (pathname === "/api/portal/promotion-text-generate" && armed && generationCount === 0 && body?.extraInstructions === expectedNotes && body?.format === "instagram_caption") {
            generationCount += 1;
            const response = await route.fetch();
            if (!response.ok()) throw new Error(`Real generation failed: ${response.status()}`);
            const result = await response.json();
            if (!result.copy || typeof result.copy.body !== "string" || !result.copy.body.trim()) throw new Error("Real generation returned no text copy");
            generatedCopy = { ...result.copy, format: "instagram_caption" };
            await route.fulfill({ response });
            return;
          }
          const row = body?.row as StoredRow | undefined;
          const entry = row?.textCopies?.[0];
          if (pathname === "/api/portal-promotions" && armed && generationCount === 1 && generatedCopy && owned.size === 0 && body?.action === "upsert"
            && row?.id?.startsWith("promo-") && !baselineIds.has(row.id) && row.managerUserId && row.textCopies?.length === 1
            && entry?.id?.startsWith("ptext-") && copyFingerprint(entry.copy) === copyFingerprint(generatedCopy)) {
            // The exact real generation response binds this new row/entry. Track
            // before forwarding so even a lost save response can be cleaned up.
            owned.set(row.id, { entryId: entry.id, managerId: row.managerUserId, copy: entry.copy });
            const response = await route.fetch();
            if (!response.ok()) throw new Error(`Real promotion save failed: ${response.status()}`);
            persistedCount += 1;
            await route.fulfill({ response });
            return;
          }
          throw new Error(`Unexpected promotion test write: ${request.method()} ${pathname}`);
        };
        const fence = async (route: Route) => {
          const task = handleWrite(route).catch(async error => {
            violations.push(error instanceof Error ? error.message : String(error));
            await route.abort("blockedbyclient").catch(() => {});
          });
          pending.add(task);
          try { await task; } finally { pending.delete(task); }
        };
        await page.route("**/api/**", fence);
        try {
          await page.locator('[data-attr="promotion-new"]').click();
          const dialog = page.getByRole("dialog");
          await selectPromotionKind(page, dialog, "Text");
          await dialog.locator('[data-attr="promotion-new-next"]').click();
          const format = fieldSelectTrigger(dialog, "select-promotion-text-format");
          await expect(format).toBeVisible();
          await pickFieldSelect(page, format, "Instagram caption");
          await dialog.locator("#promotion-text-notes").fill(expectedNotes);
          await dialog.locator('[data-attr="promotion-new-next"]').click();
          await expect(dialog.getByRole("heading", { name: "Preview", exact: true })).toBeVisible();
          armed = true;
          await dialog.locator('[data-attr="promotion-text-generate-submit"]').click();

          const preview = page.getByRole("dialog");
          await expect(preview.getByRole("heading", { name: /^View · / })).toBeVisible();
          await expect(preview.getByRole("button", { name: "Copy text", exact: true })).toBeVisible();
          await preview.getByRole("button", { name: "Close", exact: true }).click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect.poll(() => persistedCount).toBe(1);
          expect(generationCount).toBe(1);
          expect(owned.size).toBe(1);
          expect(violations).toEqual([]);
          const [rowId, identity] = [...owned.entries()][0];
          const createdId = `${rowId}::text::${identity.entryId}`;
          const stored = (await readRows()).find(row => row.id === rowId);
          expect(stored).toMatchObject({ id: rowId, managerUserId: identity.managerId, textCopies: [{ id: identity.entryId, copy: identity.copy }] });
          expect(stored?.textCopies).toHaveLength(1);
          const afterIds = await list.locator('[data-attr^="promotion-select-"]').evaluateAll((els) =>
            els.map((el) => el.getAttribute("data-attr")).filter((value): value is string => Boolean(value)),
          );
          const created = afterIds.filter((id) => !beforeIds.includes(id));
          expect(created, "exactly one promotion asset was created").toEqual([`promotion-select-${createdId}`]);
          await frame.screenshot({
            path: `${SHOT_DIR}/${viewport.name}-07-text-promotion-created.png`,
          });
        } finally {
          // Destroy the document so a still-running generator cannot enqueue a
          // late save. Drain already-forwarded requests before exact-ID cleanup.
          await page.goto("about:blank");
          await Promise.allSettled([...pending]);
          await page.unroute("**/api/**", fence);
          const rows = await readRows();
          for (const [rowId, identity] of owned) {
            const stored = rows.find(row => row.id === rowId);
            if (!stored) continue;
            expect(stored.managerUserId, "cleanup retains exact generated owner").toBe(identity.managerId);
            expect(stored.textCopies, "cleanup retains exact generated entry").toEqual([{ ...stored.textCopies?.[0], id: identity.entryId, copy: identity.copy }]);
            const deleted = await page.request.post("/api/portal-promotions", { data: { action: "delete", id: rowId } });
            expect(deleted.ok(), "real exact-owned-row cleanup succeeds").toBe(true);
          }
          expect((await readRows()).filter(row => owned.has(row.id))).toEqual([]);
          expect(violations).toEqual([]);
        }
      });
    });
  }
});
