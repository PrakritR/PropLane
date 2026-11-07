import { test, expect, type Page } from "@playwright/test";
import { signInWritableSoftwareManager } from "../helpers/owned-manager-workspace-e2e";

const QA_PROPERTY_ID = "mgr-test-magnolia";

const BOOKING_CALENDARS_PATH = `/portal/properties/listed/${encodeURIComponent(QA_PROPERTY_ID)}/bookings`;

async function openAirbnbFromBookings(page: Page) {
  const integrations = page.locator('[data-attr="bookings-integrations"]');
  await expect(integrations).toBeVisible({ timeout: 30_000 });
  await integrations.click();
  await expect(page).toHaveURL((url) => url.pathname === "/portal/profile" &&
    url.searchParams.get("tab") === "spreadsheets" && url.searchParams.get("integration") === "bookings");
  await page.locator('[data-attr="settings-airbnb-manage"]').click();
  await expect(page.getByRole("heading", { name: "Connect Airbnb", exact: true })).toBeVisible();
}

function softwareFixtureRoom(page: Page) {
  // The seed names mgr-test-magnolia "Magnolia House — 5 rooms" and room-1 "Room 1".
  return page.getByRole("region", { name: "Magnolia House — 5 rooms", exact: true })
    .locator('[data-attr="channel-calendar-room-row"]')
    .filter({ has: page.getByText("Room 1", { exact: true }) });
}

/**
 * A house's Calendar → Bookings tab.
 *
 * The tab is a month grid (PropLane leases + imported Airbnb ranges) with the
 * channel wiring in Settings > Integrations > Bookings; the old inline "Channel
 * calendars" form — and its per-room "Copy export URL" control — were removed.
 * The export URL itself still exists and is still served, so this asserts the
 * round trip through the API rather than through a button that no longer ships.
 */
test.describe("Channel calendars (Airbnb iCal)", () => {
  test("manager can reach Link calendars from the property Bookings tab", async ({ page }) => {
    await signInWritableSoftwareManager(page);

    await page.goto(BOOKING_CALENDARS_PATH, { waitUntil: "domcontentloaded" });

    await openAirbnbFromBookings(page);

    const room = softwareFixtureRoom(page);
    await expect(room).toHaveCount(1);
    await expect(room.getByRole("textbox", { name: /Airbnb calendar link/ })).toBeVisible();
    await expect(page.locator('[data-attr="channel-calendar-link-save"]')).toBeVisible();
  });

  test("link a room and round-trip its export URL", async ({ page }) => {
    await signInWritableSoftwareManager(page);

    const prior = await page.request.get(`/api/portal/channel-calendar/connections?propertyId=${QA_PROPERTY_ID}`);
    expect(prior.ok()).toBe(true);
    const priorBody = await prior.json() as { connections: { propertyId: string; roomId: string }[] };
    expect(priorBody.connections.filter((connection) => connection.propertyId === QA_PROPERTY_ID && connection.roomId === "room-1"), "Do not overwrite an existing shared fixture connection").toHaveLength(0);
    let createdConnectionId: string | undefined;
    try {
    await page.goto(BOOKING_CALENDARS_PATH, { waitUntil: "domcontentloaded" });

    await openAirbnbFromBookings(page);

    // The current dialog lists each writable room; scope the change to Magnolia's Room 1.
    const room = softwareFixtureRoom(page);
    await expect(room).toHaveCount(1);
    const importLink = room.getByRole("textbox", { name: /Airbnb calendar link/ });
    await expect(importLink).toBeEnabled();

    // Shape-valid Airbnb export URL: the save is what this asserts, and the
    // fetch behind "sync" is allowed to fail against a placeholder feed.
    await importLink.fill(`https://www.airbnb.com/calendar/ical/e2e-${Date.now()}.ics?s=e2eplaceholder`);

    const savedResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/portal/channel-calendar/connections" && response.request().method() === "POST");
    await page.locator('[data-attr="channel-calendar-link-save"]').click();
    const saved = await savedResponse;
    expect(saved.ok()).toBe(true);
    const savedBody = await saved.json() as { results: { ok: boolean; connection?: { id: string; propertyId: string; roomId: string; hasImportUrl: boolean } }[] };
    createdConnectionId = savedBody.results[0]?.connection?.id;
    expect(savedBody.results).toHaveLength(1);
    expect(createdConnectionId).toBeTruthy();
    expect(savedBody.results[0].ok).toBe(true);
    expect(savedBody.results[0].connection?.propertyId).toBe(QA_PROPERTY_ID);
    expect(savedBody.results[0].connection?.hasImportUrl).toBe(true);
    expect(savedBody.results[0].connection?.roomId).toBe("room-1");
    const savedRoomId = savedBody.results[0].connection!.roomId;

    const exportRes = await page.evaluate(async ({ propertyId, roomId }) => {
      const origin = window.location.origin;
      const listRes = await fetch(
        `${origin}/api/portal/channel-calendar/connections?propertyId=${encodeURIComponent(propertyId)}&origin=${encodeURIComponent(origin)}`,
        { credentials: "include" },
      );
      const list = (await listRes.json()) as { connections?: { exportUrl: string; propertyId: string; roomId: string; hasImportUrl: boolean }[] };
      const connection = list.connections?.find((candidate) => candidate.propertyId === propertyId && candidate.roomId === roomId);
      const exportUrl = connection?.hasImportUrl ? connection.exportUrl : undefined;
      if (!exportUrl) return { ok: false, reason: "no export url" };
      const icsRes = await fetch(exportUrl);
      const text = await icsRes.text();
      return { ok: icsRes.ok && text.includes("BEGIN:VCALENDAR"), status: icsRes.status, snippet: text.slice(0, 80) };
    }, { propertyId: QA_PROPERTY_ID, roomId: savedRoomId });

    expect(exportRes.ok, JSON.stringify(exportRes)).toBe(true);
    } finally {
      if (createdConnectionId) {
        const removed = await page.request.delete(`/api/portal/channel-calendar/connections?id=${encodeURIComponent(createdConnectionId)}`);
        expect(removed.ok(), "Remove only this test-created connection").toBe(true);
        const remaining = await page.request.get(`/api/portal/channel-calendar/connections?propertyId=${QA_PROPERTY_ID}`);
        expect(remaining.ok()).toBe(true);
        const body = await remaining.json() as { connections: { id: string }[] };
        expect(body.connections.some((connection) => connection.id === createdConnectionId)).toBe(false);
      }
    }
  });
});
