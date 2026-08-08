import { test, expect } from "@playwright/test";
import { E2E_ACCOUNTS } from "../fixtures";
import { signIn, establishActivePortal } from "../helpers/auth";

const BROOKLYN_PROPERTY_ID = "mgr-seed-5259-brooklyn-ave-ne";

const BOOKING_CALENDARS_PATH = `/portal/properties/listed/${encodeURIComponent(BROOKLYN_PROPERTY_ID)}/booking-calendars`;

test.describe("Channel calendars (Airbnb iCal)", () => {
  test("manager sees Channel calendars on property Booking calendars tab", async ({ page }) => {
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

    await expect(page.getByRole("heading", { name: "Channel calendars" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Airbnb import URL").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" }).first()).toBeVisible();
  });

  test("save connection and export URL round-trip", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password, "/portal/dashboard");
    await establishActivePortal(page, "manager", "/portal/dashboard");

    await page.goto(BOOKING_CALENDARS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Channel calendars" })).toBeVisible({
      timeout: 30_000,
    });

    const firstSave = page.locator('[data-attr^="channel-calendar-save-"]').first();
    await firstSave.click();
    await expect(page.getByText("Channel calendar saved.")).toBeVisible({ timeout: 15_000 });

    const copyExport = page.locator('[data-attr^="channel-calendar-copy-export-"]').first();
    await expect(copyExport).toBeVisible();
    await copyExport.click();
    await expect(page.getByText(/Export URL copied/i)).toBeVisible({ timeout: 10_000 });

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
