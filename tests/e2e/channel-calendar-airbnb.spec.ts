import { test, expect } from "@playwright/test";
import { signInAsManager2 } from "../helpers/auth";
import { cleanupSyntheticProperties, createSyntheticProperty } from "../helpers/synthetic-property-e2e";

const fixtureByPage = new WeakMap<object, { id: string; path: string }>();
const fixtureFor = (page: object) => {
  const fixture = fixtureByPage.get(page);
  if (!fixture) throw new Error("Synthetic calendar property was not initialized.");
  return fixture;
};

/**
 * A house's Calendar → Bookings tab.
 *
 * The tab is a month grid (PropLane leases + imported Airbnb ranges) with the
 * channel wiring behind a "Link calendars" modal; the old inline "Channel
 * calendars" form — and its per-room "Copy export URL" control — were removed.
 * The export URL itself still exists and is still served, so this asserts the
 * round trip through the API rather than through a button that no longer ships.
 */
test.describe("Channel calendars (Airbnb iCal)", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsManager2(page, "/portal/properties");
    const property = await createSyntheticProperty(page);
    fixtureByPage.set(page, { ...property, path: `/portal/properties/listed/${encodeURIComponent(property.id)}/bookings` });
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

  test("manager can reach Link calendars from the property Bookings tab", async ({ page }) => {
    const { path } = fixtureFor(page);
    await page.goto(path, { waitUntil: "domcontentloaded" });

    const linkAirbnb = page.locator('[data-attr="portfolio-bookings-link-airbnb"]');
    await expect(linkAirbnb).toBeVisible({ timeout: 30_000 });
    await linkAirbnb.click();

    await expect(page.getByRole("heading", { name: "Link calendars" })).toBeVisible();
    await expect(page.getByText("Channel").first()).toBeVisible();
    await expect(page.getByText("Airbnb import URL").first()).toBeVisible();
    await expect(page.locator('[data-attr="channel-calendar-save-link"]')).toBeVisible();
  });

  test("link a room and round-trip its export URL", async ({ page }) => {
    const fixture = fixtureFor(page);
    await page.goto(fixture.path, { waitUntil: "domcontentloaded" });

    const linkAirbnb = page.locator('[data-attr="portfolio-bookings-link-airbnb"]');
    await expect(linkAirbnb).toBeVisible({ timeout: 30_000 });
    await linkAirbnb.click();
    await expect(page.getByRole("heading", { name: "Link calendars" })).toBeVisible();

    // The owned fixture has one room. The shared Select renders a button and
    // auto-picks that room after the listing data loads.
    const roomSelect = page.locator('[data-attr="channel-calendar-link-room"]');
    await expect(roomSelect).toBeEnabled({ timeout: 30_000 });
    await expect(roomSelect).toContainText("Fixture Room");

    const importUrl = "https://www.airbnb.com/calendar/ical/e2e-placeholder.ics?s=e2eplaceholder";
    await page.locator('[data-attr="channel-calendar-link-import-url"]').fill(importUrl);
    await page.locator('[data-attr="channel-calendar-save-link"]').click();
    await expect(page.getByText(/Airbnb calendar linked and synced\.|Calendar saved\./)).toBeVisible({
      timeout: 20_000,
    });

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
