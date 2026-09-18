import { test, expect, type Page } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

/**
 * Per-property Operations settings (PLAN-0916-1040): pick a house, edit it, and
 * "All properties" is untouched; the choice survives a reload; Reset restores
 * the workspace values. Drives the picker + scope bar in the browser and proves
 * the server behaviour through same-origin fetches (the exact calls the panels
 * make), so it needs no fragile timing-dropdown interaction.
 *
 * Requires a workspace with at least two properties; it skips otherwise so a
 * sparsely seeded environment does not report a false failure.
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
  test("pick a house -> edit -> All properties unchanged -> reload keeps it -> reset restores", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAsManager(page);
    await page.goto("/portal/settings?tab=inspections", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    const picker = page.locator('[data-attr="settings-property-scope"]');
    if ((await picker.count()) === 0) {
      test.skip(true, "workspace has fewer than two properties");
      return;
    }

    // Pick the first house (option index 1; index 0 is "All properties").
    await picker.first().click();
    const options = page.locator('[role="option"]');
    await expect(options.first()).toBeVisible();
    await options.nth(1).click();
    await page.waitForTimeout(500);
    const houseId = new URL(page.url()).searchParams.get("property");
    expect(houseId, "picking a house writes ?property= into the URL").toBeTruthy();

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
    await page.goto(`/portal/settings?tab=inspections&property=${houseId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    expect(new URL(page.url()).searchParams.get("property")).toBe(houseId);
    await picker.first().click();
    const resetLink = page.locator('[data-attr="settings-property-scope-reset"]');
    await expect(resetLink).toBeVisible({ timeout: 10_000 });

    // Reset lives in the title-row picker menu.
    await resetLink.click();
    await page.waitForTimeout(1500);
    const houseReset = await call(page, `/api/portal/reminder-settings?propertyId=${houseId}`);
    expect(houseReset.body.inherited).toBe(true);
    expect(before(houseReset)).toEqual(workspaceBefore);

    // The workspace view now lists no override for this house.
    const workspaceView = await call(page, "/api/portal/reminder-settings");
    expect(workspaceView.body.overriddenPropertyIds ?? []).not.toContain(houseId);
  });
});
