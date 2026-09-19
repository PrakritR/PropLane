import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./authenticated-test";
import { E2E_ACCOUNTS } from "../fixtures";
import { fieldSelectTrigger, pickFieldSelect } from "../helpers/field-select";

type CalendarFixture = { propertyId: string; roomId: string };

async function withCalendarFixture(page: Page, run: (fixture: CalendarFixture) => Promise<void>) {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url.protocol !== "https:" || url.hostname !== "emstjswhotsnyksqhqyf.supabase.co" || url.port || url.username || url.password || !key) {
    throw new Error("Calendar fixtures require the exact dev/test Supabase project and service key");
  }
  const db = createClient(url.toString(), key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: manager, error: managerError } = await db.from("profiles").select("id,email").eq("email", E2E_ACCOUNTS.manager.email).single();
  if (managerError || !manager?.id) throw new Error("Seeded manager profile is required");
  const { data: roles, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", manager.id).eq("role", "manager");
  if (roleError || roles?.length !== 1) throw new Error("Seeded manager role could not be verified");
  const { data: workspace, error: workspaceError } = await db.from("portal_workspaces").select("id").eq("owner_user_id", manager.id).eq("is_default", true).single();
  if (workspaceError || !workspace?.id) throw new Error("Seeded manager default workspace is required");
  const marker = `e2e-channel-${randomUUID()}`;
  const fixture = { propertyId: marker, roomId: `room-${randomUUID()}` };
  // Establish cleanup identity before the first possible write, including an
  // insert whose response fails after the database has accepted it.
  try {
    const title = `Calendar fixture ${marker}`;
    const submission = {
      v: 1, buildingName: title, address: "100 Test Fixture Lane", zip: "98101", neighborhood: "Test fixture",
      listingPlaceCategoryId: "private_room", tagline: "", petFriendly: false, houseOverview: "",
      houseRulesText: "", housePhotoDataUrls: [], allowedLeaseTerms: ["12 months"], leaseTermsBody: "",
      sharedSpaces: [], bathrooms: [], bundles: [], quickFacts: [],
      rooms: [{ id: fixture.roomId, name: "Fixture room", floor: "1", monthlyRent: 1000,
        availability: "Now", moveInAvailableDate: "2026-01-01", manualUnavailableRanges: [],
        detail: "", furnishing: "Unfurnished", roomAmenitiesText: "", photoDataUrls: [], videoDataUrl: null }],
    };
    const { error } = await db.from("manager_property_records").insert({
      id: fixture.propertyId, manager_user_id: manager.id, workspace_id: workspace.id, status: "live",
      row_data: { id: fixture.propertyId, name: title, status: "live", address: submission.address, testRunId: marker },
      property_data: { id: fixture.propertyId, title, tagline: "", address: submission.address, zip: submission.zip,
        neighborhood: submission.neighborhood, beds: 1, baths: 1, rentLabel: "$1,000 / mo", available: "Now",
        petFriendly: false, buildingId: fixture.propertyId, buildingName: title, unitLabel: "Fixture room",
        managerUserId: manager.id, adminPublishLive: false, listingSubmission: submission },
    });
    if (error) throw new Error(`Calendar fixture insert failed: ${error.message}`);
    await page.context().addCookies([{ name: "proplane-workspace", value: workspace.id, url: page.url() }]);
    // Save/export are real. Avoid an external fetch of the deliberately invalid
    // feed by exercising the product's existing saved/sync-error path.
    await page.route("**/api/portal/channel-calendar/sync?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture feed sync disabled" }) }));
    await run(fixture);
  } finally {
    const { data: owned, error: lookupError } = await db.from("manager_property_records").select("manager_user_id,workspace_id,row_data").eq("id", fixture.propertyId).maybeSingle();
    if (lookupError) throw new Error(`Calendar fixture cleanup lookup failed: ${lookupError.message}`);
    if (owned) {
      if (owned.manager_user_id !== manager.id || owned.workspace_id !== workspace.id || owned.row_data?.testRunId !== marker) throw new Error("Calendar cleanup refused: ownership changed");
      const { error: connectionError } = await db.from("external_calendar_connections").delete().eq("property_id", fixture.propertyId).eq("manager_user_id", manager.id).eq("room_id", fixture.roomId).eq("provider", "airbnb");
      if (connectionError) throw new Error(`Calendar connection cleanup failed: ${connectionError.message}`);
      const { error: propertyError } = await db.from("manager_property_records").delete().eq("id", fixture.propertyId).eq("manager_user_id", manager.id).eq("workspace_id", workspace.id).contains("row_data", { testRunId: marker });
      if (propertyError) throw new Error(`Calendar property cleanup failed: ${propertyError.message}`);
    }
  }
}

async function openCalendar(page: Page, fixture: CalendarFixture) {
  const destination = `/portal/properties/listed/${encodeURIComponent(fixture.propertyId)}/bookings`;
  await page.goto(destination, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(new RegExp(`${destination}$`));
  const trigger = page.locator('[data-attr="portfolio-bookings-link-airbnb"]');
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  const modal = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Link calendars", exact: true }) });
  await expect(modal).toBeVisible();
  return modal;
}

test.describe("Channel calendars (Airbnb iCal)", () => {
  test.use({ authRole: "manager" });

  test("manager can reach Link calendars from the property Bookings tab", async ({ page }) => {
    await withCalendarFixture(page, async fixture => {
      const modal = await openCalendar(page, fixture);
      await expect(modal.getByText("Channel", { exact: true })).toBeVisible();
      await expect(modal.getByText("Airbnb import URL", { exact: true })).toBeVisible();
      await expect(modal.locator('[data-attr="channel-calendar-save-link"]')).toBeVisible();
    });
  });

  test("link a room and round-trip its export URL", async ({ page }) => {
    await withCalendarFixture(page, async fixture => {
      const modal = await openCalendar(page, fixture);
      await pickFieldSelect(page, fieldSelectTrigger(modal, "channel-calendar-link-room"), "Fixture room");
      const endpoint = `/api/portal/channel-calendar/connections?propertyId=${encodeURIComponent(fixture.propertyId)}`;
      const before = await page.request.get(endpoint);
      expect(before.ok(), "initial lookup succeeds").toBe(true);
      expect((await before.json()).connections).toEqual([]);
      await modal.locator('[data-attr="channel-calendar-link-import-url"]').fill("https://www.airbnb.com/calendar/ical/e2e-placeholder.ics?s=e2eplaceholder");
      const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/portal/channel-calendar/connections" && response.request().method() === "POST");
      await modal.locator('[data-attr="channel-calendar-save-link"]').click();
      const saved = await savedResponse;
      expect(saved.ok(), "actual save succeeds").toBe(true);
      const created = (await saved.json()).connection;
      expect(created).toMatchObject({ propertyId: fixture.propertyId, roomId: fixture.roomId, provider: "airbnb" });
      expect(typeof created.id).toBe("string");
      await expect(page.getByText("Calendar saved. Use Sync all to refresh bookings.", { exact: true })).toBeVisible();
      const response = await page.request.get(endpoint);
      expect(response.ok(), "created lookup succeeds").toBe(true);
      const connections = (await response.json()).connections;
      expect(connections).toHaveLength(1);
      const connection = connections[0];
      expect(connection).toMatchObject({ id: created.id, propertyId: fixture.propertyId, roomId: fixture.roomId, provider: "airbnb" });
      const exportUrl = new URL(connection.exportUrl);
      expect(exportUrl.origin).toBe(new URL(page.url()).origin);
      const exported = await page.request.get(exportUrl.toString());
      expect(exported.ok()).toBe(true);
      expect(await exported.text()).toContain("BEGIN:VCALENDAR");
    });
  });
});
