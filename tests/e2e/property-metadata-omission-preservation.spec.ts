/**
 * A real Properties-page load mirrors the seeded manager's cached live rows
 * back through POST /api/property-records. Those mirrors carry propertyData
 * only. rowData must remain omitted, rather than being serialized as null and
 * clearing the server's seeded metadata.
 */
import { test, expect, type Request } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { signInAsManager } from "../helpers/auth";
import { E2E_ACCOUNTS } from "../fixtures";

const enabled = process.env.E2E_TESTS_ENABLED === "1";
const DEV_TEST_SUPABASE_HOST = "emstjswhotsnyksqhqyf.supabase.co";

type PropertyRecord = {
  id: string;
  manager_user_id: string | null;
  status: "live" | "review";
  row_data: Record<string, unknown> | null;
  property_data: Record<string, unknown> | null;
};

type PropertyWrite = Record<string, unknown>;

function assertDevTestTarget(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new Error("Property metadata E2E requires the dev/test Supabase URL and service-role key.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Property metadata E2E refuses an invalid Supabase target URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== DEV_TEST_SUPABASE_HOST ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Property metadata E2E refuses a target other than the exact dev/test Supabase origin.");
  }
  return { url, serviceRoleKey };
}

function propertyWriteBody(request: Request): PropertyWrite | null {
  if (
    request.method() !== "POST" ||
    new URL(request.url()).pathname !== "/api/property-records"
  ) {
    return null;
  }
  try {
    const body: unknown = request.postDataJSON();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as PropertyWrite
      : null;
  } catch {
    return null;
  }
}

function hasMeaningfulObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0,
  );
}

test.describe("property metadata omission preservation", () => {
  test.skip(!enabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test("Properties load preserves seeded row metadata when its background mirror omits rowData", async ({ page }) => {
    const { url, serviceRoleKey } = assertDevTestTarget();
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

    // Read-only evidence before the browser load. This record is a stable,
    // manager-owned row from test:seed - no fixture is created or cleaned up.
    const { data: manager, error: managerError } = await db
      .from("profiles")
      .select("id")
      .eq("email", E2E_ACCOUNTS.manager.email)
      .maybeSingle();
    if (managerError) throw managerError;
    expect(manager?.id, "seeded manager must exist in the dev/test project").toBeTruthy();

    const { data: candidates, error: candidatesError } = await db
      .from("manager_property_records")
      .select("id, manager_user_id, status, row_data, property_data")
      .eq("manager_user_id", manager!.id)
      .in("status", ["live", "review"])
      .order("id", { ascending: true });
    if (candidatesError) throw candidatesError;
    const before = (candidates as PropertyRecord[] | null)?.find(
      (record) =>
        hasMeaningfulObject(record.row_data) &&
        hasMeaningfulObject(record.property_data) &&
        record.property_data.id === record.id,
    );
    expect(
      before,
      "seeded manager must own a live property with meaningful row and listing metadata",
    ).toBeTruthy();
    const beforeRowData = before!.row_data;
    const propertyId = before!.id;

    const readRecord = async (): Promise<PropertyRecord> => {
      const { data, error } = await db
        .from("manager_property_records")
        .select("id, manager_user_id, status, row_data, property_data")
        .eq("id", propertyId)
        .eq("manager_user_id", manager!.id)
        .maybeSingle();
      if (error) throw error;
      expect(data, "selected seeded property must remain owned by the seeded manager").toBeTruthy();
      return data as PropertyRecord;
    };

    await signInAsManager(page);

    const writes: PropertyWrite[] = [];
    page.on("request", (request) => {
      const body = propertyWriteBody(request);
      if (body) writes.push(body);
    });
    const mirroredResponse = page.waitForResponse((response) => {
      const body = propertyWriteBody(response.request());
      return body?.id === propertyId;
    });

    await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-attr="manager-properties-tab-listed"]')).toBeVisible({ timeout: 30_000 });
    const response = await mirroredResponse;
    expect(response.status(), "background mirror must receive the real route response").toBe(200);

    expect(writes, "Properties page load must capture at least one real background mirror write").not.toHaveLength(0);
    const propertyOnlyMirror = writes.find((body) => body.id === propertyId);
    expect(propertyOnlyMirror, "Properties page must mirror the selected seeded property").toBeTruthy();
    expect(propertyOnlyMirror).toHaveProperty("propertyData");
    // Omission is semantically different from explicit null: the route uses it
    // to retain the stored row_data blob on a property-only background mirror.
    expect(propertyOnlyMirror).not.toHaveProperty("rowData");

    // Read-only evidence after the real page load and route write completes.
    // The server may update updated_at, so compare the metadata column itself.
    const after = await readRecord();
    expect(after.row_data).toEqual(beforeRowData);
  });
});
