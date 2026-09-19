import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { E2E_ACCOUNTS } from "../fixtures";

const DEV_TEST_SUPABASE_HOST = "emstjswhotsnyksqhqyf.supabase.co";

export type OwnedPortalRecordFixture = {
  marker: string;
  managerId: string;
  workspaceId: string;
  propertyIds: string[];
  propertyTitles: string[];
  chargeId: string | null;
  chargeTitle: string | null;
};

type FixtureOptions = {
  propertyCount: number;
  pendingCharge?: boolean;
};

function serviceClient(): SupabaseClient {
  let url: URL;
  try {
    url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    throw new Error("Owned portal fixtures require a valid dev/test Supabase URL");
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (
    url.protocol !== "https:" ||
    url.hostname !== DEV_TEST_SUPABASE_HOST ||
    url.port ||
    url.username ||
    url.password ||
    !key
  ) {
    throw new Error("Owned portal fixtures require the exact dev/test Supabase project and service key");
  }
  return createClient(url.toString(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function resolveSeededManager(db: SupabaseClient): Promise<string> {
  const { data: manager, error: managerError } = await db
    .from("profiles")
    .select("id,email")
    .eq("email", E2E_ACCOUNTS.manager.email)
    .single();
  if (managerError || !manager?.id) throw new Error("Seeded manager profile is required");

  const { data: roles, error: roleError } = await db
    .from("profile_roles")
    .select("role")
    .eq("user_id", manager.id)
    .eq("role", "manager");
  if (roleError || roles?.length !== 1) throw new Error("Seeded manager role could not be verified");
  return String(manager.id);
}

async function resolveFixtureWorkspace(
  db: SupabaseClient,
  managerId: string,
  requiredSlots: number,
  candidate: { id: string; name: string },
): Promise<{ id: string; created: boolean; name: string }> {
  const { data: workspaces, error: workspaceError } = await db
    .from("portal_workspaces")
    .select("id,name")
    .eq("owner_user_id", managerId);
  if (workspaceError) throw new Error(`Fixture workspace lookup failed: ${workspaceError.message}`);

  if ((workspaces ?? []).length < 3) {
    const { error } = await db.from("portal_workspaces").insert({
      id: candidate.id,
      owner_user_id: managerId,
      name: candidate.name,
      is_default: false,
    });
    if (error) throw new Error(`Fixture workspace insert failed: ${error.message}`);
    return { ...candidate, created: true };
  }

  const { data: properties, error: propertyError } = await db
    .from("manager_property_records")
    .select("workspace_id")
    .eq("manager_user_id", managerId);
  if (propertyError) throw new Error(`Fixture workspace capacity lookup failed: ${propertyError.message}`);
  const counts = new Map<string, number>();
  for (const property of properties ?? []) {
    const workspaceId = String(property.workspace_id ?? "");
    if (workspaceId) counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  }
  const available = (workspaces ?? [])
    .map((workspace) => ({
      id: String(workspace.id),
      name: String(workspace.name ?? ""),
      count: counts.get(String(workspace.id)) ?? 0,
    }))
    .filter((workspace) => 10 - workspace.count >= requiredSlots)
    .sort((a, b) => a.count - b.count)[0];
  if (!available) {
    throw new Error(`Owned portal fixture needs ${requiredSlots} free property slots in one owned workspace`);
  }
  return { id: available.id, created: false, name: available.name };
}

function propertyRecord(
  managerId: string,
  workspaceId: string,
  marker: string,
  id: string,
  title: string,
  index: number,
) {
  const address = `${200 + index} Fixture Row Lane`;
  const roomId = randomUUID();
  const submission = {
    v: 1,
    buildingName: title,
    address,
    zip: "98101",
    neighborhood: "Fixture district",
    listingPlaceCategoryId: "private_room",
    tagline: "",
    petFriendly: false,
    houseOverview: "",
    houseRulesText: "",
    housePhotoDataUrls: [],
    allowedLeaseTerms: ["12 months"],
    leaseTermsBody: "",
    sharedSpaces: [],
    bathrooms: [],
    bundles: [],
    quickFacts: [],
    rooms: [{
      id: roomId,
      name: `Fixture room ${index + 1}`,
      floor: "1",
      monthlyRent: 1000 + index,
      availability: "Now",
      moveInAvailableDate: "2026-10-01",
      manualUnavailableRanges: [],
      detail: "",
      furnishing: "Unfurnished",
      roomAmenitiesText: "",
      photoDataUrls: [],
      videoDataUrl: null,
    }],
  };
  return {
    id,
    manager_user_id: managerId,
    workspace_id: workspaceId,
    status: "live",
    row_data: { id, name: title, status: "live", address, testRunId: marker },
    property_data: {
      id,
      title,
      tagline: "",
      address,
      zip: submission.zip,
      neighborhood: submission.neighborhood,
      beds: 1,
      baths: 1,
      rentLabel: `$${(1000 + index).toLocaleString()} / mo`,
      available: "Now",
      petFriendly: false,
      buildingId: id,
      buildingName: title,
      unitLabel: `Fixture room ${index + 1}`,
      managerUserId: managerId,
      adminPublishLive: false,
      listingSubmission: submission,
    },
  };
}

async function cleanupFixture(
  db: SupabaseClient,
  fixture: OwnedPortalRecordFixture,
  workspace: { created: boolean; name: string },
) {
  if (fixture.chargeId) {
    const { data: charge, error: chargeLookupError } = await db
      .from("portal_household_charge_records")
      .select("manager_user_id,property_id,row_data")
      .eq("id", fixture.chargeId)
      .maybeSingle();
    if (chargeLookupError) throw new Error(`Charge cleanup lookup failed: ${chargeLookupError.message}`);
    if (charge) {
      if (
        charge.manager_user_id !== fixture.managerId ||
        charge.property_id !== fixture.propertyIds[0] ||
        charge.row_data?.testRunId !== fixture.marker
      ) {
        throw new Error("Charge cleanup refused: ownership changed");
      }
      const { data: deleted, error } = await db
        .from("portal_household_charge_records")
        .delete()
        .eq("id", fixture.chargeId)
        .eq("manager_user_id", fixture.managerId)
        .eq("property_id", fixture.propertyIds[0])
        .contains("row_data", { testRunId: fixture.marker })
        .select("id");
      if (error || deleted?.length !== 1) throw new Error(`Charge cleanup failed: ${error?.message ?? "row was not deleted"}`);
    }
  }

  const { data: owned, error: propertyLookupError } = await db
    .from("manager_property_records")
    .select("id,manager_user_id,workspace_id,row_data")
    .in("id", fixture.propertyIds);
  if (propertyLookupError) throw new Error(`Property cleanup lookup failed: ${propertyLookupError.message}`);
  for (const row of owned ?? []) {
    if (
      row.manager_user_id !== fixture.managerId ||
      row.workspace_id !== fixture.workspaceId ||
      row.row_data?.testRunId !== fixture.marker
    ) {
      throw new Error("Property cleanup refused: ownership changed");
    }
  }
  if ((owned ?? []).length > 0) {
    const { data: deleted, error } = await db
      .from("manager_property_records")
      .delete()
      .in("id", fixture.propertyIds)
      .eq("manager_user_id", fixture.managerId)
      .eq("workspace_id", fixture.workspaceId)
      .contains("row_data", { testRunId: fixture.marker })
      .select("id");
    const expectedIds = new Set((owned ?? []).map((row) => String(row.id)));
    const deletedIds = new Set((deleted ?? []).map((row) => String(row.id)));
    if (
      error ||
      deletedIds.size !== expectedIds.size ||
      [...expectedIds].some((id) => !deletedIds.has(id))
    ) {
      throw new Error(`Property cleanup failed: ${error?.message ?? "not every owned row was deleted"}`);
    }
  }

  if (workspace.created) {
    const { data: stored, error: workspaceLookupError } = await db
      .from("portal_workspaces")
      .select("owner_user_id,name")
      .eq("id", fixture.workspaceId)
      .maybeSingle();
    if (workspaceLookupError) throw new Error(`Workspace cleanup lookup failed: ${workspaceLookupError.message}`);
    if (stored) {
      if (stored.owner_user_id !== fixture.managerId || stored.name !== workspace.name) {
        throw new Error("Workspace cleanup refused: ownership changed");
      }
      const { count, error: countError } = await db
        .from("manager_property_records")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", fixture.workspaceId);
      if (countError || count !== 0) throw new Error("Workspace cleanup refused: fixture workspace is not empty");
      const { data: deleted, error } = await db
        .from("portal_workspaces")
        .delete()
        .eq("id", fixture.workspaceId)
        .eq("owner_user_id", fixture.managerId)
        .eq("name", workspace.name)
        .select("id");
      if (error || deleted?.length !== 1) throw new Error(`Workspace cleanup failed: ${error?.message ?? "row was not deleted"}`);
    }
  }
}

export async function withOwnedPortalRecordFixture(
  page: Page,
  options: FixtureOptions,
  run: (fixture: OwnedPortalRecordFixture) => Promise<void>,
) {
  if (!Number.isInteger(options.propertyCount) || options.propertyCount < 1 || options.propertyCount > 10) {
    throw new Error("Owned portal fixtures require between 1 and 10 properties");
  }
  const db = serviceClient();
  const managerId = await resolveSeededManager(db);
  const marker = `e2e-owned-${randomUUID()}`;
  const workspaceCandidate = { id: randomUUID(), name: `E2E fixture ${marker}` };
  let workspace = { ...workspaceCandidate, created: true };
  const propertyIds = Array.from({ length: options.propertyCount }, () => randomUUID());
  const propertyTitles = propertyIds.map((_, index) => {
    if (index === 0) return `000 Fixture property ${marker}`;
    if (index === propertyIds.length - 1) return `zzz Fixture property ${marker}`;
    return `Fixture property ${String(index + 1).padStart(2, "0")} ${marker}`;
  });
  const fixture: OwnedPortalRecordFixture = {
    marker,
    managerId,
    workspaceId: workspace.id,
    propertyIds,
    propertyTitles,
    chargeId: options.pendingCharge ? randomUUID() : null,
    chargeTitle: options.pendingCharge ? `Fixture rent ${marker}` : null,
  };

  try {
    workspace = await resolveFixtureWorkspace(db, managerId, options.propertyCount, workspaceCandidate);
    fixture.workspaceId = workspace.id;
    const records = propertyIds.map((id, index) =>
      propertyRecord(managerId, workspace.id, marker, id, propertyTitles[index]!, index),
    );
    const { error: propertyError } = await db.from("manager_property_records").insert(records);
    if (propertyError) throw new Error(`Property fixture insert failed: ${propertyError.message}`);

    if (fixture.chargeId && fixture.chargeTitle) {
      const now = new Date().toISOString();
      const charge = {
        id: fixture.chargeId,
        createdAt: now,
        residentEmail: `fixture-${fixture.chargeId}@example.invalid`,
        residentName: "Fixture Resident",
        residentUserId: null,
        propertyId: propertyIds[0],
        propertyLabel: propertyTitles[0],
        managerUserId: managerId,
        kind: "rent",
        title: fixture.chargeTitle,
        amountLabel: "$1,000.00",
        balanceLabel: "$1,000.00",
        status: "pending",
        blocksLeaseUntilPaid: false,
        dueDateLabel: "Dec 31, 2099",
        testRunId: marker,
      };
      const { error: chargeError } = await db.from("portal_household_charge_records").insert({
        id: fixture.chargeId,
        manager_user_id: managerId,
        resident_user_id: null,
        resident_email: charge.residentEmail,
        property_id: propertyIds[0],
        kind: charge.kind,
        status: charge.status,
        row_data: charge,
      });
      if (chargeError) throw new Error(`Charge fixture insert failed: ${chargeError.message}`);
    }

    const selectWorkspace = await page.request.post("/api/workspaces", {
      data: { action: "select", id: workspace.id },
    });
    if (!selectWorkspace.ok()) {
      throw new Error(`Fixture workspace activation failed with HTTP ${selectWorkspace.status()}`);
    }
    await run(fixture);
  } finally {
    try {
      if (!page.isClosed()) await page.goto("about:blank", { waitUntil: "commit" });
    } finally {
      await cleanupFixture(db, fixture, workspace);
    }
  }
}
