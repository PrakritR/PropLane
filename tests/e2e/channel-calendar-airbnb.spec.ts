import { test, expect, type Route } from "@playwright/test";
import { signInAsManager2 } from "../helpers/auth";
import { cleanupSyntheticProperties, createSyntheticProperty } from "../helpers/synthetic-property-e2e";

const fixtureByPage = new WeakMap<object, { id: string; name: string; roomId: string; roomName: string; path: string }>();
const fixtureFor = (page: object) => {
  const fixture = fixtureByPage.get(page);
  if (!fixture) throw new Error("Synthetic calendar property was not initialized.");
  return fixture;
};

/**
 * Settings → Integrations → Bookings is where a channel calendar is wired now.
 *
 * `ManagerBookingChannelsPanel` owns the Airbnb row, and its Connect/Manage action opens the
 * one-page "Connect Airbnb" popup with a row PER ROOM across the whole workspace — there is no
 * room selector any more, and the old property Bookings tab is a month-grid PREVIEW whose
 * `portfolio-bookings-link-airbnb` button no longer ships. The export URL itself still exists
 * and is still served, so the round trip is asserted through the API.
 */
test.describe("Channel calendars (Airbnb iCal)", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsManager2(page, "/portal/properties");
    const property = await createSyntheticProperty(page);
    fixtureByPage.set(page, { ...property, path: "/portal/profile?tab=spreadsheets&integration=bookings" });
  });

  test.afterEach(async ({ page }) => {
    const fixture = fixtureByPage.get(page);
    if (fixture) {
      const list = await page.request.get(`/api/portal/channel-calendar/connections?propertyId=${encodeURIComponent(fixture.id)}&origin=${encodeURIComponent(new URL(page.url()).origin)}`);
      if (!list.ok()) throw new Error(`Calendar cleanup read failed (HTTP ${list.status()}).`);
      const body = await list.json() as { connections?: Array<{ id?: string; propertyId?: string }> };
      for (const connection of body.connections ?? []) {
        if (connection.propertyId !== fixture.id || !connection.id) throw new Error("Calendar cleanup ownership did not match the synthetic property.");
        const deleted = await page.request.delete(`/api/portal/channel-calendar/connections?id=${encodeURIComponent(connection.id)}`);
        if (!deleted.ok()) throw new Error(`Synthetic calendar cleanup failed (HTTP ${deleted.status()}).`);
      }
      const verify = await page.request.get(`/api/portal/channel-calendar/connections?propertyId=${encodeURIComponent(fixture.id)}&origin=${encodeURIComponent(new URL(page.url()).origin)}`);
      if (!verify.ok()) throw new Error(`Calendar cleanup verification read failed (HTTP ${verify.status()}).`);
      const remaining = await verify.json() as { connections?: Array<{ propertyId?: string }> };
      if ((remaining.connections ?? []).some((connection) => connection.propertyId === fixture.id)) throw new Error("Synthetic calendar connection remained after cleanup.");
    }
    await cleanupSyntheticProperties(page);
  });

  test("manager can open Connect Airbnb from Settings → Integrations → Bookings", async ({ page }) => {
    const { path, name, roomId, roomName } = fixtureFor(page);
    await page.goto(path, { waitUntil: "domcontentloaded" });

    const manageAirbnb = page.locator('[data-attr="settings-airbnb-manage"]');
    await expect(manageAirbnb).toBeVisible({ timeout: 30_000 });

    // Reload with the real workspace request held between the server response and the browser.
    // This proves an early click cannot open a stale/unscoped channel modal while workspace
    // ownership and its property list are still unresolved.
    let releaseWorkspace!: () => void;
    const workspaceGate = new Promise<void>((resolve) => { releaseWorkspace = resolve; });
    let workspaceStatus: number | null = null;
    const heldRoutes = new Set<Promise<void>>();
    const routePattern = "**/api/workspaces**";
    const holdWorkspaceResponse = async (route: Route) => {
      if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/workspaces") {
        await route.continue();
        return;
      }
      let finishHeldRoute!: () => void;
      const heldRouteFinished = new Promise<void>((resolve) => { finishHeldRoute = resolve; });
      heldRoutes.add(heldRouteFinished);
      try {
        const response = await route.fetch({ timeout: 15_000 });
        if (workspaceStatus === null) workspaceStatus = response.status();
        await workspaceGate;
        await route.fulfill({ response });
      } finally {
        finishHeldRoute();
        heldRoutes.delete(heldRouteFinished);
      }
    };
    await page.route(routePattern, holdWorkspaceResponse);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => workspaceStatus, { timeout: 20_000, message: "the page should issue its real workspace read" }).toBe(200);
      await expect(manageAirbnb).toBeDisabled();
    } finally {
      releaseWorkspace();
      while (heldRoutes.size > 0) await Promise.all([...heldRoutes]);
      await page.unroute(routePattern, holdWorkspaceResponse);
    }
    await expect(manageAirbnb).toBeEnabled({ timeout: 20_000 });
    await manageAirbnb.click();

    const dialog = page.getByRole("dialog", { name: "Connect Airbnb" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const section = page.locator(`section[aria-label="${name}"]`);
    await expect(section).toBeVisible({ timeout: 30_000 });
    const roomRow = section.locator('[data-attr="channel-calendar-room-row"]').filter({ hasText: roomName });
    await expect(roomRow).toHaveCount(1);
    await expect(roomRow.locator('[data-attr="channel-calendar-link-import-url"]')).toBeVisible();
    await expect(roomRow.locator('[data-attr="channel-calendar-export-url"]')).toBeVisible();
    expect(roomId).toMatch(/^room-/);
    await expect(section.locator('[data-attr="channel-calendar-link-import-url"]')).toBeVisible();
    await expect(dialog.locator('[data-attr="channel-calendar-link-save"]')).toBeVisible();
  });

  test("link a room and round-trip its export URL", async ({ page }) => {
    const fixture = fixtureFor(page);
    await page.goto(fixture.path, { waitUntil: "domcontentloaded" });

    const manageAirbnb = page.locator('[data-attr="settings-airbnb-manage"]');
    await expect(manageAirbnb).toBeVisible({ timeout: 30_000 });
    await manageAirbnb.click();
    const dialog = page.getByRole("dialog", { name: "Connect Airbnb" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // One row per room across the workspace — the owned fixture contributes exactly one.
    const section = page.locator(`section[aria-label="${fixture.name}"]`);
    await expect(section).toBeVisible({ timeout: 30_000 });
    const row = section.locator('[data-attr="channel-calendar-room-row"]').filter({ hasText: fixture.roomName });
    await expect(row).toHaveCount(1);
    const importField = row.locator('[data-attr="channel-calendar-link-import-url"]');
    const exportField = row.locator('[data-attr="channel-calendar-export-url"]');
    await expect(importField).toBeVisible();
    await expect(exportField).toBeVisible();
    expect(fixture.roomId).toMatch(/^room-/);

    const importUrl = "https://www.airbnb.com/calendar/ical/e2e-placeholder.ics?s=e2eplaceholder";
    await importField.fill(importUrl);
    await dialog.locator('[data-attr="channel-calendar-link-save"]').click();
    await expect(page.getByText("Calendars saved and synced.")).toBeVisible({ timeout: 20_000 });

    const exportRes = await page.evaluate(async ({ propertyId, expectedImportUrl }) => {
      const origin = window.location.origin;
      const bookingRes = await fetch(
        `${origin}/api/portal/channel-calendar/bookings?propertyIds=${encodeURIComponent(propertyId)}`,
        { credentials: "include" },
      );
      const bookingBody = (await bookingRes.json()) as { properties?: Array<{ propertyId: string; rooms: Array<{ exportUrl: string; importUrl: string | null; ranges: Array<{ sourceUid: string; summary: string }> }> }> };
      const connection = bookingBody.properties?.find((property) => property.propertyId === propertyId)?.rooms[0];
      const exportUrl = connection?.exportUrl;
      if (!exportUrl) return { ok: false, reason: "no export url" };
      if (connection?.importUrl !== expectedImportUrl) return { ok: false, reason: "import URL did not persist" };
      const icsRes = await fetch(exportUrl);
      const text = await icsRes.text();
      return {
        ok: icsRes.ok && text.includes("BEGIN:VCALENDAR"),
        echoesSyntheticImportedEvent: text.includes("proplane-qa-calendar-1108@example.invalid") || text.includes("QA synthetic calendar block"),
        containsImportedRange: connection.ranges.some((range) => range.sourceUid === "proplane-qa-calendar-1108@example.invalid" && range.summary === "QA synthetic calendar block"),
        status: icsRes.status,
      };
    }, { propertyId: fixture.id, expectedImportUrl: importUrl });

    expect(exportRes.ok, JSON.stringify(exportRes)).toBe(true);
    expect(exportRes.echoesSyntheticImportedEvent, "the destination export should not echo its own imported Airbnb event").toBe(false);
    expect(exportRes.containsImportedRange, "mocked synthetic Airbnb range should appear in the owned property's booking data").toBe(true);
  });
});
