/** A real Properties-page load and property-only upsert must preserve row metadata. */
import { test, expect, type Request } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createWritableSyntheticManager, cleanupWritableSyntheticManager } from "../helpers/writable-synthetic-manager";

const enabled = process.env.E2E_TESTS_ENABLED === "1";
const DEV_TEST_SUPABASE_URL = "https://emstjswhotsnyksqhqyf.supabase.co";

type PropertyWrite = Record<string, unknown>;

function propertyWriteBody(request: Request): PropertyWrite | null {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/property-records") return null;
  try {
    const body: unknown = request.postDataJSON();
    return body && typeof body === "object" && !Array.isArray(body) ? body as PropertyWrite : null;
  } catch {
    return null;
  }
}

function serviceRoleClient() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== DEV_TEST_SUPABASE_URL) {
    throw new Error("Property metadata E2E refuses a non-dev/test Supabase target.");
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("Property metadata E2E requires the dev/test service-role key for readback only.");
  return createClient(DEV_TEST_SUPABASE_URL, key, { auth: { persistSession: false } });
}

test.describe("property metadata omission preservation", () => {
  test.skip(!enabled, "Set E2E_TESTS_ENABLED=1 with the bounded synthetic account harness.");

  test("property-only upsert preserves metadata and page load does not mirror the fixture", async ({ browser }) => {
    const db = serviceRoleClient();
    const manager = await createWritableSyntheticManager(browser);
    const { page, actorId, property } = manager;
    const marker = `metadata-${Date.now()}`;
    try {
      const beforeRows = await db.from("manager_property_records")
        .select("id,manager_user_id,workspace_id,row_data,property_data")
        .eq("id", property.id)
        .eq("manager_user_id", actorId);
      if (beforeRows.error || beforeRows.data?.length !== 1) {
        throw new Error("Writable synthetic property could not be read before metadata setup.");
      }
      const before = beforeRows.data[0]!;
      const rowData = {
        ...(before.row_data && typeof before.row_data === "object" ? before.row_data as Record<string, unknown> : {}),
        preservedFixtureMetadata: { marker, nested: ["keep", 17], enabled: true },
      };

      const completeWrite = await page.request.post("/api/property-records", {
        data: { action: "upsert", id: property.id, status: "live", rowData, propertyData: before.property_data },
      });
      expect(completeWrite.status(), "initial marker is written through the authenticated route").toBe(200);
      const markerRead = await db.from("manager_property_records")
        .select("row_data")
        .eq("id", property.id)
        .eq("manager_user_id", actorId)
        .maybeSingle();
      if (markerRead.error || markerRead.data?.row_data == null) throw new Error("Metadata marker was not confirmed before the page-load check.");
      expect(markerRead.data.row_data).toEqual(rowData);

      const writes: PropertyWrite[] = [];
      page.on("request", (request) => {
        const body = propertyWriteBody(request);
        if (body) writes.push(body);
      });
      await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-attr="manager-properties-tab-listed"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(property.name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1_000);
      expect(writes.filter((body) => body.id === property.id), "page load must not mirror the fixture").toEqual([]);

      const originalPropertyData = before.property_data as Record<string, unknown>;
      const submission = originalPropertyData.listingSubmission as Record<string, unknown>;
      const changedTagline = `Updated ${marker}`;
      const propertyOnlyWrite = {
        action: "upsert",
        id: property.id,
        status: "live",
        propertyData: {
          ...originalPropertyData,
          tagline: changedTagline,
          listingSubmission: { ...submission, tagline: changedTagline },
        },
      };
      expect(propertyOnlyWrite).not.toHaveProperty("rowData");
      const response = await page.request.post("/api/property-records", { data: propertyOnlyWrite });
      expect(response.status(), "property-only upsert must receive the real route response").toBe(200);

      const afterRows = await db.from("manager_property_records")
        .select("id,manager_user_id,workspace_id,row_data,property_data")
        .eq("id", property.id)
        .eq("manager_user_id", actorId)
        .eq("workspace_id", before.workspace_id);
      if (afterRows.error || afterRows.data?.length !== 1) {
        throw new Error("Writable synthetic property was unavailable after property-only upsert.");
      }
      expect(afterRows.data[0]!.row_data).toEqual(rowData);
      expect((afterRows.data[0]!.property_data as Record<string, unknown>).tagline).toBe(changedTagline);
    } finally {
      await cleanupWritableSyntheticManager(manager);
    }
  });
});
