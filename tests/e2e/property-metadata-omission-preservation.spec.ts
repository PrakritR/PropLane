/**
 * A real Properties-page load mirrors a live listing back through POST
 * /api/property-records with propertyData only. That omission must retain the
 * stored row_data blob rather than serializing it as null and clearing it.
 */
import { randomUUID } from "node:crypto";
import { test, expect, type Page, type Request } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { signInAsManager } from "../helpers/auth";
import { E2E_ACCOUNTS } from "../fixtures";

const enabled = process.env.E2E_TESTS_ENABLED === "1";
const DEV_TEST_SUPABASE_HOST = "emstjswhotsnyksqhqyf.supabase.co";
const MAX_PROPERTIES_PER_WORKSPACE = 10;
const MAX_WORKSPACES_PER_MANAGER = 3;

type PropertyRecord = {
  id: string;
  manager_user_id: string | null;
  workspace_id: string | null;
  status: "live" | "review";
  row_data: Record<string, unknown> | null;
  property_data: Record<string, unknown> | null;
};

type PropertyWrite = Record<string, unknown>;
type FixtureWorkspace = { id: string; name: string; created: boolean };

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
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/property-records") return null;
  try {
    const body: unknown = request.postDataJSON();
    return body && typeof body === "object" && !Array.isArray(body) ? body as PropertyWrite : null;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function resolveFixtureWorkspace(
  db: SupabaseClient,
  managerId: string,
  candidate: Omit<FixtureWorkspace, "created">,
): Promise<FixtureWorkspace> {
  const { data: workspaces, error: workspaceError } = await db
    .from("portal_workspaces")
    .select("id,name")
    .eq("owner_user_id", managerId);
  if (workspaceError) throw new Error(`Property fixture workspace lookup failed: ${workspaceError.message}`);

  const { data: properties, error: propertyError } = await db
    .from("manager_property_records")
    .select("workspace_id")
    .eq("manager_user_id", managerId);
  if (propertyError) throw new Error(`Property fixture workspace capacity lookup failed: ${propertyError.message}`);

  const counts = new Map<string, number>();
  for (const property of properties ?? []) {
    const workspaceId = String(property.workspace_id ?? "").trim();
    if (workspaceId) counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  }
  const available = (workspaces ?? [])
    .map((workspace) => ({
      id: String(workspace.id),
      name: String(workspace.name ?? ""),
      count: counts.get(String(workspace.id)) ?? 0,
    }))
    .filter((workspace) => workspace.count < MAX_PROPERTIES_PER_WORKSPACE)
    .sort((left, right) => left.count - right.count)[0];
  if (available) return { id: available.id, name: available.name, created: false };

  if ((workspaces ?? []).length >= MAX_WORKSPACES_PER_MANAGER) {
    throw new Error("Property metadata fixture needs one free property slot in an owned workspace; all owned workspaces are full.");
  }
  const { error: insertError } = await db.from("portal_workspaces").insert({
    id: candidate.id,
    owner_user_id: managerId,
    name: candidate.name,
    is_default: false,
  });
  if (insertError) throw new Error(`Property fixture workspace insert failed: ${insertError.message}`);
  return { ...candidate, created: true };
}

function fixtureProperty(managerId: string, workspaceId: string, id: string, marker: string) {
  const title = `E2E metadata fixture ${marker}`;
  const address = "200 Fixture Preservation Lane";
  const roomId = randomUUID();
  const listingSubmission = {
    v: 1, buildingName: title, address, zip: "98101", neighborhood: "Fixture district",
    listingPlaceCategoryId: "private_room", tagline: "", petFriendly: false,
    houseOverview: "", houseRulesText: "", housePhotoDataUrls: [], allowedLeaseTerms: ["12 months"],
    leaseTermsBody: "", sharedSpaces: [], bathrooms: [], bundles: [], quickFacts: [],
    rooms: [{
      id: roomId, name: "Fixture room", floor: "1", monthlyRent: 1000, availability: "Now",
      moveInAvailableDate: "2026-10-01", manualUnavailableRanges: [], detail: "",
      furnishing: "Unfurnished", roomAmenitiesText: "", photoDataUrls: [], videoDataUrl: null,
    }],
  };
  return {
    id, manager_user_id: managerId, workspace_id: workspaceId, status: "live",
    row_data: {
      id, name: title, status: "live", address, testRunId: marker,
      fixturePurpose: "property-metadata-omission-preservation",
    },
    property_data: {
      id, title, tagline: "", address, zip: listingSubmission.zip, neighborhood: listingSubmission.neighborhood,
      beds: 1, baths: 1, rentLabel: "$1,000 / mo", available: "Now", petFriendly: false,
      buildingId: id, buildingName: title, unitLabel: "Fixture room", managerUserId: managerId,
      adminPublishLive: true, listingSubmission,
    },
  };
}

async function cleanupFixture(
  db: SupabaseClient,
  params: { propertyId: string; managerId: string; workspace: FixtureWorkspace; marker: string },
) {
  const cleanupErrors: unknown[] = [];
  try {
    const { data: storedProperty, error: propertyLookupError } = await db
      .from("manager_property_records")
      .select("id,manager_user_id,workspace_id,row_data")
      .eq("id", params.propertyId)
      .maybeSingle();
    if (propertyLookupError) throw new Error(`Property fixture cleanup lookup failed: ${propertyLookupError.message}`);
    if (storedProperty) {
      const rowData = asObject(storedProperty.row_data);
      if (
        storedProperty.manager_user_id !== params.managerId ||
        storedProperty.workspace_id !== params.workspace.id ||
        rowData?.testRunId !== params.marker
      ) {
        throw new Error("Property fixture cleanup refused because exact ownership could not be verified.");
      }
      const { data: deleted, error: deleteError } = await db
        .from("manager_property_records")
        .delete()
        .eq("id", params.propertyId)
        .eq("manager_user_id", params.managerId)
        .eq("workspace_id", params.workspace.id)
        .contains("row_data", { testRunId: params.marker })
        .select("id");
      if (deleteError || deleted?.length !== 1 || deleted[0]?.id !== params.propertyId) {
        throw new Error(`Property fixture cleanup failed: ${deleteError?.message ?? "exact fixture row was not deleted"}`);
      }
    }
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (params.workspace.created) {
    try {
      const { data: storedWorkspace, error: workspaceLookupError } = await db
        .from("portal_workspaces")
        .select("id,owner_user_id,name")
        .eq("id", params.workspace.id)
        .maybeSingle();
      if (workspaceLookupError) throw new Error(`Property fixture workspace cleanup lookup failed: ${workspaceLookupError.message}`);
      if (storedWorkspace) {
        if (storedWorkspace.owner_user_id !== params.managerId || storedWorkspace.name !== params.workspace.name) {
          throw new Error("Property fixture workspace cleanup refused because exact ownership could not be verified.");
        }
        const { count, error: countError } = await db
          .from("manager_property_records")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", params.workspace.id);
        if (countError || count !== 0) {
          throw new Error(`Property fixture workspace cleanup refused: ${countError?.message ?? "workspace is not empty"}`);
        }
        const { data: deleted, error: deleteError } = await db
          .from("portal_workspaces")
          .delete()
          .eq("id", params.workspace.id)
          .eq("owner_user_id", params.managerId)
          .eq("name", params.workspace.name)
          .select("id");
        if (deleteError || deleted?.length !== 1 || deleted[0]?.id !== params.workspace.id) {
          throw new Error(`Property fixture workspace cleanup failed: ${deleteError?.message ?? "exact fixture workspace was not deleted"}`);
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Property fixture cleanup failed.");
}

async function stopPageActivity(page: Page) {
  if (page.isClosed()) return;
  try {
    await page.goto("about:blank", { waitUntil: "commit" });
  } catch (navigationError) {
    try {
      await page.close({ runBeforeUnload: false });
    } catch (closeError) {
      throw new AggregateError(
        [navigationError, closeError],
        "Property fixture could not stop browser activity before cleanup.",
      );
    }
  }
}

function recordTeardownError(errors: unknown[], error: unknown) {
  errors.push(error);
}

test.describe("property metadata omission preservation", () => {
  test.skip(!enabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test("Properties load preserves row metadata when its background mirror omits rowData", async ({ page }) => {
    const { url, serviceRoleKey } = assertDevTestTarget();
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    const { data: manager, error: managerError } = await db
      .from("profiles")
      .select("id")
      .eq("email", E2E_ACCOUNTS.manager.email)
      .maybeSingle();
    if (managerError || !manager?.id) throw new Error("Seeded manager must exist in the dev/test project.");
    const managerId = String(manager.id);
    const marker = `e2e-property-metadata-${randomUUID()}`;
    const propertyId = randomUUID();
    let workspace: FixtureWorkspace | null = null;
    let priorWorkspaceId: string | null = null;

    try {
      // Authenticate before the fixture exists so sign-in hydration cannot
      // mirror it before the exact request/response observers are attached.
      await signInAsManager(page);
      const priorWorkspace = await page.request.get("/api/workspaces");
      if (!priorWorkspace.ok()) throw new Error(`Property fixture could not read the active workspace: HTTP ${priorWorkspace.status()}`);
      const priorPayload = await priorWorkspace.json() as { activeWorkspaceId?: unknown };
      priorWorkspaceId = typeof priorPayload.activeWorkspaceId === "string" ? priorPayload.activeWorkspaceId : null;

      workspace = await resolveFixtureWorkspace(db, managerId, {
        id: randomUUID(),
        name: `E2E metadata fixture ${marker}`,
      });
      const record = fixtureProperty(managerId, workspace.id, propertyId, marker);
      const { error: insertError } = await db.from("manager_property_records").insert(record);
      if (insertError) throw new Error(`Property metadata fixture insert failed: ${insertError.message}`);

      const selected = await page.request.post("/api/workspaces", { data: { action: "select", id: workspace.id } });
      if (!selected.ok()) throw new Error(`Property fixture workspace activation failed: HTTP ${selected.status()}`);

      const writes: PropertyWrite[] = [];
      page.on("request", (request) => {
        const body = propertyWriteBody(request);
        if (body) writes.push(body);
      });
      const mirroredResponse = page.waitForResponse((response) => {
        const body = propertyWriteBody(response.request());
        return body?.action === "upsert" && body.id === propertyId;
      });

      const [, response] = await Promise.all([
        (async () => {
          await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
          await expect(page.locator('[data-attr="manager-properties-tab-listed"]')).toBeVisible({ timeout: 30_000 });
        })(),
        mirroredResponse,
      ]);
      expect(response.status(), "background property-only mirror must receive the real route response").toBe(200);

      const propertyOnlyMirror = writes.find((body) => body.action === "upsert" && body.id === propertyId);
      expect(propertyOnlyMirror, "Properties page must mirror the test-owned property").toBeTruthy();
      expect(propertyOnlyMirror).toHaveProperty("propertyData");
      expect(propertyOnlyMirror).not.toHaveProperty("rowData");

      const { data: after, error: afterError } = await db
        .from("manager_property_records")
        .select("id,manager_user_id,workspace_id,status,row_data,property_data")
        .eq("id", propertyId)
        .eq("manager_user_id", managerId)
        .eq("workspace_id", workspace.id)
        .maybeSingle();
      if (afterError || !after) throw new Error(`Property fixture was unavailable after the browser mirror: ${afterError?.message ?? "not found"}`);
      expect((after as PropertyRecord).row_data).toEqual(record.row_data);
    } finally {
      const teardownErrors: unknown[] = [];
      let pageActivityStopped = false;
      try {
        await stopPageActivity(page);
        pageActivityStopped = true;
      } catch (error) {
        recordTeardownError(teardownErrors, error);
      }
      if (pageActivityStopped && priorWorkspaceId && priorWorkspaceId !== workspace?.id) {
        try {
          const restored = await page.request.post("/api/workspaces", {
            data: { action: "select", id: priorWorkspaceId },
          });
          if (!restored.ok()) {
            throw new Error(`Property fixture could not restore the active workspace: HTTP ${restored.status()}`);
          }
        } catch (error) {
          recordTeardownError(teardownErrors, error);
        }
      }
      if (pageActivityStopped && workspace) {
        try {
          await cleanupFixture(db, { propertyId, managerId, workspace, marker });
        } catch (error) {
          recordTeardownError(teardownErrors, error);
        }
      }
      if (teardownErrors.length === 1) throw teardownErrors[0];
      if (teardownErrors.length > 1) {
        throw new AggregateError(teardownErrors, "Property fixture teardown failed.");
      }
    }
  });
});
