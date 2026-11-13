import { test, expect, type Page } from "@playwright/test";
import { createWritableSyntheticManager, cleanupWritableSyntheticManager } from "../helpers/writable-synthetic-manager";

/**
 * Per-property Tours settings: pick a house, edit it, and prove "All properties"
 * is untouched. The saved override persists across reload when the house is
 * selected again; the Tours panel has no reset control, so reset is verified via
 * the documented backend override action. Drives the visible picker and exact
 * scoped requests without fragile timing-dropdown interaction.
 *
 * Uses an isolated writable workspace with two real API-created properties.
 */
type Resp = { status: number; body: { activeWorkspaceId?: string; scope?: string; inherited?: boolean; overriddenPropertyIds?: string[]; source?: string; settings?: { tourNoticeDays?: number } } };
const call = (page: Page, url: string, init?: RequestInit): Promise<Resp> =>
  page.evaluate(
    async ([u, i]) => {
      const r = await fetch(u as string, { credentials: "include", cache: "no-store", ...((i as RequestInit) || {}) });
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {}
      return { status: r.status, body } as Resp;
    },
    [url, init] as const,
  );
test.describe("Settings — per-property Automations scope", () => {
  test("pick a house -> edit -> All properties unchanged -> reload persists -> backend reset restores", async ({ browser }) => {
    const manager = await createWritableSyntheticManager(browser, { properties: 2 });
    const { page } = manager;
    const fixture = manager.properties[0]!;
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      const workspaceResponse = await call(page, "/api/workspaces");
      expect(workspaceResponse.status).toBe(200);
      const workspaceId = workspaceResponse.body.activeWorkspaceId;
      expect(workspaceId, "the synthetic manager has an active writable workspace").toBeTruthy();
      const settingsUrl = "/portal/profile?tab=applicationsLeases#tours";
      await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });

      // Inspections no longer has a Settings pane. Workspace → Automations → Tours is the
      // current property-scoped settings surface and uses the same API scope resolver.
      const tours = page.locator("#tours");
      const picker = tours.locator('[data-attr="settings-property-scope"]');
      await expect(tours.getByRole("heading", { name: "Tours" })).toBeVisible({ timeout: 30_000 });
      await expect(picker).toBeVisible({ timeout: 30_000 });

      const workspaceQuery = `?workspaceId=${encodeURIComponent(workspaceId!)}`;
      const propertyQuery = `?propertyId=${encodeURIComponent(fixture.id)}&workspaceId=${encodeURIComponent(workspaceId!)}`;
      const chooseFixture = async (scopePicker: ReturnType<typeof tours.locator>) => {
        const scopedRead = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === "GET" && url.pathname === "/api/portal/manager-tour-settings" &&
            url.searchParams.get("propertyId") === fixture.id && url.searchParams.get("workspaceId") === workspaceId;
        }, { timeout: 15_000 });
        await scopePicker.click();
        await page.getByRole("option", { name: fixture.name, exact: true }).click();
        await expect(scopePicker).toContainText(fixture.name);
        const scopedResponse = await scopedRead;
        expect(scopedResponse.status()).toBe(200);
        const scopedUrl = new URL(scopedResponse.url());
        expect(scopedUrl.searchParams.get("propertyId")).toBe(fixture.id);
        expect(scopedUrl.searchParams.get("workspaceId")).toBe(workspaceId);
      };
      const requestInit = (body: Record<string, unknown>): RequestInit => ({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // Remove only this newly-created property's prior override, then record the exact workspace default.
      const clean = await call(page, "/api/portal/manager-tour-settings", requestInit({ propertyId: fixture.id, workspaceId, reset: true }));
      expect(clean.status).toBe(200);
      const workspaceBeforeResponse = await call(page, `/api/portal/manager-tour-settings${workspaceQuery}`);
      expect(workspaceBeforeResponse.status).toBe(200);
      const workspaceBefore = workspaceBeforeResponse.body.settings?.tourNoticeDays;
      expect(workspaceBefore).toEqual(expect.any(Number));

      // The visible All properties choice resolves to this workspace's default.
      await picker.click();
      await page.getByRole("option", { name: "All properties", exact: true }).click();
      await expect(page.locator('[data-attr="manager-tour-notice-days"]')).toHaveValue(String(workspaceBefore));
      const allProperties = await call(page, `/api/portal/manager-tour-settings${workspaceQuery}`);
      expect(allProperties.body.settings).toEqual(workspaceBeforeResponse.body.settings);

      // Pick only the fixture and prove it starts by inheriting the same workspace value.
      await chooseFixture(picker);
      const houseInherit = await call(page, `/api/portal/manager-tour-settings${propertyQuery}`);
      expect(houseInherit.status).toBe(200);
      expect(houseInherit.body.scope).toBe("property");
      expect(houseInherit.body.inherited).toBe(true);
      const noticeInput = tours.locator('[data-attr="manager-tour-notice-days"]');
      await expect(noticeInput).toHaveValue(String(workspaceBefore));

      // Edit the house through the current notice stepper; the autosave must include its exact scope.
      const propertyValue = workspaceBefore === 7 ? 8 : 7;
      const saved = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "PATCH" && url.pathname === "/api/portal/manager-tour-settings";
      }, { timeout: 15_000 });
      await noticeInput.fill(String(propertyValue));
      const saveResponse = await saved;
      expect(saveResponse.status()).toBe(200);
      const savePayload = saveResponse.request().postDataJSON() as { propertyId?: string; propertyIds?: string[]; workspaceId?: string; tourNoticeDays?: number };
      expect(savePayload.propertyId).toBe(fixture.id);
      expect(savePayload.workspaceId).toBe(workspaceId);
      expect(savePayload.propertyIds).toBeUndefined();
      expect(savePayload.tourNoticeDays).toBe(propertyValue);
      const saveBody = await saveResponse.json() as { scope?: string; settings?: { tourNoticeDays?: number }; overriddenPropertyIds?: string[] };
      expect(saveBody.scope).toBe("property");
      expect(saveBody.settings?.tourNoticeDays).toBe(propertyValue);
      expect(saveBody.overriddenPropertyIds).toContain(fixture.id);

      // The workspace default / All properties value stays unchanged.
      const workspaceAfter = await call(page, `/api/portal/manager-tour-settings${workspaceQuery}`);
      expect(workspaceAfter.body.settings).toEqual(workspaceBeforeResponse.body.settings);
      expect(workspaceAfter.body.overriddenPropertyIds).toContain(fixture.id);

      // The picker is section-local state, so select the house again after reload and prove the
      // persisted server value is loaded for the exact property/workspace scope.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(tours.getByRole("heading", { name: "Tours" })).toBeVisible({ timeout: 30_000 });
      const reloadedPicker = tours.locator('[data-attr="settings-property-scope"]');
      await expect(reloadedPicker).toBeVisible({ timeout: 30_000 });
      await chooseFixture(reloadedPicker);
      await expect(tours.locator('[data-attr="manager-tour-notice-days"]')).toHaveValue(String(propertyValue));

      // Reset is the server's explicit property-override action; verify the picker now inherits All properties.
      const reset = await call(page, "/api/portal/manager-tour-settings", requestInit({ propertyId: fixture.id, workspaceId, reset: true }));
      expect(reset.status).toBe(200);
      expect(reset.body.inherited).toBe(true);
      expect(reset.body.settings).toEqual(workspaceBeforeResponse.body.settings);
      const workspaceAfterReset = await call(page, `/api/portal/manager-tour-settings${workspaceQuery}`);
      expect(workspaceAfterReset.body.settings).toEqual(workspaceBeforeResponse.body.settings);
      expect(workspaceAfterReset.body.overriddenPropertyIds ?? []).not.toContain(fixture.id);
      await page.reload({ waitUntil: "domcontentloaded" });
      const resetPicker = tours.locator('[data-attr="settings-property-scope"]');
      await expect(resetPicker).toBeVisible({ timeout: 30_000 });
      await chooseFixture(resetPicker);
      await expect(tours.locator('[data-attr="manager-tour-notice-days"]')).toHaveValue(String(workspaceBefore));
      const propertyAfterReset = await call(page, `/api/portal/manager-tour-settings${propertyQuery}`);
      expect(propertyAfterReset.status).toBe(200);
      expect(propertyAfterReset.body.inherited).toBe(true);
      expect(propertyAfterReset.body.settings).toEqual(workspaceBeforeResponse.body.settings);
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        const restored = await call(page, "/api/portal/manager-tour-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyId: fixture.id, reset: true }),
        });
        if (restored.status !== 200) throw new Error(`Could not reset the synthetic property tour override (HTTP ${restored.status}).`);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await cleanupWritableSyntheticManager(manager);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Settings property fixture cleanup failed.");
    }
  });
});
