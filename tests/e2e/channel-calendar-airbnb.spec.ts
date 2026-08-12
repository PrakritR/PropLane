import { test, expect } from "@playwright/test";
import { E2E_ACCOUNTS } from "../fixtures";
import { signIn, establishActivePortal } from "../helpers/auth";

const BROOKLYN_PROPERTY_ID = "mgr-seed-5259-brooklyn-ave-ne";

const BOOKING_CALENDARS_PATH = `/portal/properties/listed/${encodeURIComponent(BROOKLYN_PROPERTY_ID)}/calendar/bookings`;

/**
 * A house's Calendar → Bookings tab.
 *
 * The tab is a month grid (PropLane leases + imported Airbnb ranges) with the
 * channel wiring behind a "Link Airbnb" modal; the old inline "Channel
 * calendars" form — and its per-room "Copy export URL" control — were removed.
 * The export URL itself still exists and is still served, so this asserts the
 * round trip through the API rather than through a button that no longer ships.
 */
test.describe("Channel calendars (Airbnb iCal)", () => {
  test("manager can reach Link Airbnb from the property Bookings tab", async ({ page }) => {
    await signIn(
      page,
      E2E_ACCOUNTS.manager.email,
      E2E_ACCOUNTS.manager.password,
      BOOKING_CALENDARS_PATH,
    );
    await establishActivePortal(
      page,
      "manager",
      BOOKING_CALENDARS_PATH,
    );

    await page.goto(BOOKING_CALENDARS_PATH, { waitUntil: "domcontentloaded" });

    const linkAirbnb = page.locator('[data-attr="property-bookings-link-airbnb"]');
    await expect(linkAirbnb).toBeVisible({ timeout: 30_000 });
    await linkAirbnb.click();

    await expect(page.getByRole("heading", { name: "Link Airbnb" })).toBeVisible();
    await expect(page.getByText("Airbnb import URL").first()).toBeVisible();
    await expect(page.locator('[data-attr="channel-calendar-save-link"]')).toBeVisible();
  });

  test("link a room and round-trip its export URL", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password, "/portal/dashboard");
    await establishActivePortal(page, "manager", "/portal/dashboard");

    await page.goto(BOOKING_CALENDARS_PATH, { waitUntil: "domcontentloaded" });

    const linkAirbnb = page.locator('[data-attr="property-bookings-link-airbnb"]');
    await expect(linkAirbnb).toBeVisible({ timeout: 30_000 });
    await linkAirbnb.click();
    await expect(page.getByRole("heading", { name: "Link Airbnb" })).toBeVisible();

    // The room select auto-picks when the listing has exactly one room, so read
    // the options rather than assuming either shape.
    const roomSelect = page.locator('[data-attr="channel-calendar-link-room"]');
    const roomValues = await roomSelect
      .locator("option")
      .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value).filter(Boolean));
    expect(roomValues.length, "listing exposes at least one room to link").toBeGreaterThan(0);
    await roomSelect.selectOption(roomValues[0]!);

    // Shape-valid Airbnb export URL: the save is what this asserts, and the
    // fetch behind "sync" is allowed to fail against a placeholder feed.
    await page
      .locator('[data-attr="channel-calendar-link-import-url"]')
      .fill("https://www.airbnb.com/calendar/ical/e2e-placeholder.ics?s=e2eplaceholder");

    await page.locator('[data-attr="channel-calendar-save-link"]').click();
    await expect(page.getByText(/Airbnb calendar linked and synced\.|Calendar saved\./)).toBeVisible({
      timeout: 20_000,
    });

    const exportRes = await page.evaluate(async (propertyId) => {
      const origin = window.location.origin;
      const listRes = await fetch(
        `${origin}/api/portal/channel-calendar/connections?propertyId=${encodeURIComponent(propertyId)}&origin=${encodeURIComponent(origin)}`,
        { credentials: "include" },
      );
      const list = (await listRes.json()) as { connections?: { exportUrl: string }[] };
      const exportUrl = list.connections?.[0]?.exportUrl;
      if (!exportUrl) return { ok: false, reason: "no export url" };
      const icsRes = await fetch(exportUrl);
      const text = await icsRes.text();
      return { ok: icsRes.ok && text.includes("BEGIN:VCALENDAR"), status: icsRes.status, snippet: text.slice(0, 80) };
    }, BROOKLYN_PROPERTY_ID);

    expect(exportRes.ok, JSON.stringify(exportRes)).toBe(true);
  });
});
