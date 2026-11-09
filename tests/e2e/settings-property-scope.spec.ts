import { test, expect, type Page } from "@playwright/test";
import { createWritableSyntheticManager, cleanupWritableSyntheticManager } from "../helpers/writable-synthetic-manager";

/**
 * Per-property Operations settings (PLAN-0916-1040): pick a house, edit it, and
 * "All properties" is untouched; the choice survives a reload; Reset restores
 * the workspace values. Drives the picker + scope bar in the browser and proves
 * the server behaviour through same-origin fetches (the exact calls the panels
 * make), so it needs no fragile timing-dropdown interaction.
 *
 * Uses an isolated writable workspace with two real API-created properties.
 */
type Resp = { status: number; body: { scope?: string; inherited?: boolean; overriddenPropertyIds?: string[]; settings?: { rules?: { inspection?: { timings?: string[] } } } } };
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
const before = (r: Resp) => (r.body.settings?.rules?.inspection?.timings ?? []).filter((t) => t.startsWith("before:"));

test.describe("Settings — per-property Operations scope", () => {
  test("pick a house -> edit -> All properties unchanged -> reload keeps it -> reset restores", async ({ browser }) => {
    const manager = await createWritableSyntheticManager(browser, { properties: 2 });
    const { page } = manager;
    const fixture = manager.properties[0]!;
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
    await page.goto("/portal/profile?tab=inspections", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-attr="settings-property-scope"]')).toBeVisible({ timeout: 30_000 });

    // Select only the uniquely created fixture.
    await picker.first().click();
    const options = page.locator('[role="option"]');
    await expect(options.first()).toBeVisible();
    await page.getByRole("option", { name: fixture.name, exact: true }).click();
    await page.waitForTimeout(500);
    const houseId = new URL(page.url()).searchParams.get("property");
    expect(houseId, "picking the fixture writes its exact id into the URL").toBe(fixture.id);

    // Clean slate for a deterministic run.
    await call(page, "/api/portal/reminder-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ propertyId: houseId, reset: true }) });

    const workspaceBefore = before(await call(page, "/api/portal/reminder-settings"));
    const houseInherit = await call(page, `/api/portal/reminder-settings?propertyId=${houseId}`);
    expect(houseInherit.body.inherited).toBe(true);

    // Edit the house: Before = 2 days.
    const patched = await call(page, "/api/portal/reminder-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "inspection", rule: { timings: ["before:2880", "after:1440", "after:10080"] }, propertyId: houseId }),
    });
    expect(patched.body.scope).toBe("property");
    expect(before(patched)).toEqual(["before:2880"]);
    expect(patched.body.overriddenPropertyIds).toContain(houseId);

    // "All properties" is untouched.
    const workspaceAfter = before(await call(page, "/api/portal/reminder-settings"));
    expect(workspaceAfter).toEqual(workspaceBefore);

    // The house's own value persists across a reload with &property=.
    await page.goto(`/portal/profile?tab=inspections&property=${houseId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    expect(new URL(page.url()).searchParams.get("property")).toBe(houseId);
    const resetLink = page.locator('[data-attr="settings-property-scope-reset"]');
    await expect(resetLink).toBeVisible({ timeout: 10_000 });

    // Reset from the scope bar restores the workspace values.
    await resetLink.click();
    await page.waitForTimeout(1500);
    const houseReset = await call(page, `/api/portal/reminder-settings?propertyId=${houseId}`);
    expect(houseReset.body.inherited).toBe(true);
    expect(before(houseReset)).toEqual(workspaceBefore);

    // The workspace view now lists no override for this house.
    const workspaceView = await call(page, "/api/portal/reminder-settings");
    expect(workspaceView.body.overriddenPropertyIds ?? []).not.toContain(houseId);
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        const restored = await call(page, "/api/portal/reminder-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyId: fixture.id, reset: true }),
        });
        if (restored.status !== 200) throw new Error(`Could not reset the synthetic property reminder override (HTTP ${restored.status}).`);
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
