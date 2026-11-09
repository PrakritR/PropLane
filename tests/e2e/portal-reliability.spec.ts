import { expect, test, type TestInfo } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";
import { createWritableSyntheticManager, cleanupWritableSyntheticManager } from "../helpers/writable-synthetic-manager";

// Real authenticated dev/test rows. Network gates simulate slow and failed
// source reads; they do not substitute demo data or send messages.
test.use({ storageState: { cookies: [], origins: [] } });
test.describe("Portal loading and record actions", () => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires seeded dev/test manager");
  test.beforeEach(async ({ page }) => { await signInAsManager(page); });

  test("Residents never shows an empty result while membership sources are pending", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/manager-applications*", async (route) => { await gate; await route.continue(); });
    await page.goto("/portal/residents/current", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status", { name: "Loading records" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Nothing here yet", { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("status", { name: "Loading records" })).toHaveCount(0, { timeout: 45_000 });
    await expect(page.getByRole("alert").filter({ hasText: "Could not load residents" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Residents", exact: true })).toBeVisible();
  });

  test("Residents failed membership read offers a retry instead of an empty directory", async ({ page }) => {
    await page.route("**/api/manager-applications*", (route) => route.fulfill({ status: 503, json: { error: "Test outage" } }));
    await page.goto("/portal/residents/current", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert").filter({ hasText: "Could not load residents" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Nothing here yet", { exact: true })).toHaveCount(0);
    await page.unroute("**/api/manager-applications*");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Could not load residents" })).toHaveCount(0, { timeout: 45_000 });
  });

  for (const width of [1280, 390]) {
    const phoneFixtureRestorations = new WeakMap<TestInfo, () => Promise<void>>();
    test.afterEach(async ({}, testInfo) => {
      const restore = phoneFixtureRestorations.get(testInfo);
      phoneFixtureRestorations.delete(testInfo);
      if (!restore) return;
      try {
        await restore();
      } catch (restoreError) {
        // Playwright retains the test-body failure separately; keep the failed restoration
        // visible as an afterEach failure rather than masking either error.
        throw restoreError;
      }
    });

    test(`Properties actions belong to each record at ${width}px`, async ({ browser }, testInfo) => {
      // This case creates an account, proves its mailbox, clears its scoped phone gate and
      // creates an owned property before testing the record action. Keep the overall budget
      // bounded but distinct from the ordinary portal interaction budget.
      test.setTimeout(180_000);
      let manager: Awaited<ReturnType<typeof createWritableSyntheticManager>> | null = null;
      try {
      manager = await createWritableSyntheticManager(browser, {
        onPhoneFixtureReady: (fixture) => { phoneFixtureRestorations.set(testInfo, fixture.restore); },
      });
      const page = manager.page;
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
      const trigger = page.getByRole("button", { name: `Actions for ${manager.property.name}`, exact: true });
      await expect(trigger).toBeVisible({ timeout: 45_000 });
      await expect(page.locator('[data-attr="list-selection-toolbar"]')).toHaveCount(0);
      const box = await trigger.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(width < 640 ? 44 : 32);
      expect(box!.height).toBeGreaterThanOrEqual(width < 640 ? 44 : 32);
      await trigger.click();
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: "Edit", exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Unlist", exact: true })).toBeVisible();
      const menuBox = await menu.boundingBox();
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await trigger.click();
      const [detailRequest] = await Promise.all([
        page.waitForRequest((request) => {
          const url = new URL(request.url());
          return /^\/portal\/properties\/listed\/[^/]+\/preview$/.test(url.pathname) && url.searchParams.get("edit") === "1";
        }, { timeout: 45_000 }),
        menu.getByRole("menuitem", { name: "Edit", exact: true }).click(),
      ]);
      expect(new URL(detailRequest.url()).searchParams.get("edit")).toBe("1");
      expect(new URL(detailRequest.url()).pathname).toBe(`/portal/properties/listed/${manager.property.id}/preview`);
      await expect(page.locator('[data-attr="listing-v2-next"]')).toBeVisible({ timeout: 45_000 });
      } finally {
        if (manager) {
          await cleanupWritableSyntheticManager(manager);
        }
      }
    });
  }

  test("Communication keeps status choices in Filter", async ({ page }) => {
    await page.goto("/portal/communication/active", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Residents, applicants and vendors, in one place.", { exact: true })).toHaveCount(0);
    await page.locator('[data-attr="communication-filter-sheet-open"]').first().click();
    const status = page.getByRole("button", { name: /Status/ }).first();
    if (await status.count()) await status.click();
    await expect(page.getByText("Read", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Unread", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Archived", { exact: true }).first()).toBeVisible();
  });
});
