import { sealApplicantRow } from "@/lib/security/applicant-identity";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

function looksLikeMissingTableError(err: { message?: string } | null | undefined): boolean {
  const m = (err?.message ?? "").toLowerCase();
  return (
    m.includes("schema cache") ||
    m.includes("does not exist") ||
    (m.includes("relation") && m.includes("not"))
  );
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/**
 * Ids match EXACTLY. This helper runs with the service-role client and rewrites
 * rows across every manager, so any normalization here lets one manager's id
 * fold onto another's: a record created under `mgr-victim-house-1.` is a
 * distinct primary key its owner may legitimately delete, and a fuzzy match
 * would carry that delete into the victim's `mgr-victim-house-1` grants and
 * resident rows.
 */
function propertyIdMatches(candidate: unknown, propertyId: string): boolean {
  const left = String(candidate ?? "").trim();
  const right = propertyId.trim();
  if (!left || !right) return false;
  return left === right;
}

function scrubHousingFromRowData(rowData: unknown): Record<string, unknown> {
  const row =
    rowData && typeof rowData === "object" ? { ...(rowData as Record<string, unknown>) } : {};
  row.property = "";
  row.propertyId = "";
  row.assignedPropertyId = "";
  row.assignedRoomChoice = "";
  row.stage = "Moved out";
  if (row.manualResidentDetails && typeof row.manualResidentDetails === "object") {
    row.manualResidentDetails = {
      ...(row.manualResidentDetails as Record<string, unknown>),
      roomNumber: "",
      moveInDate: "",
      moveOutDate: new Date().toISOString().slice(0, 10),
    };
  } else {
    row.manualResidentDetails = {
      roomNumber: "",
      moveInDate: "",
      moveOutDate: new Date().toISOString().slice(0, 10),
    };
  }
  if (row.application && typeof row.application === "object") {
    row.application = {
      ...(row.application as Record<string, unknown>),
      propertyId: "",
    };
  }
  return row;
}

function rowDataReferencesProperty(rowData: unknown, propertyId: string): boolean {
  if (!rowData || typeof rowData !== "object") return false;
  const row = rowData as Record<string, unknown>;
  return (
    propertyIdMatches(row.assignedPropertyId, propertyId) ||
    propertyIdMatches(row.propertyId, propertyId) ||
    propertyIdMatches((row.application as { propertyId?: unknown } | undefined)?.propertyId, propertyId)
  );
}

async function stripPropertyFromInviteRow(
  db: ServiceDb,
  invite: { id?: unknown; assigned_property_ids?: unknown; property_co_manager_permissions?: unknown },
  propertyId: string,
): Promise<boolean> {
  const id = String(invite.id ?? "").trim();
  if (!id) return false;
  const assignedRaw = asStringArray(invite.assigned_property_ids);
  if (!assignedRaw.some((idValue) => propertyIdMatches(idValue, propertyId))) return false;
  const assigned = assignedRaw.filter((idValue) => !propertyIdMatches(idValue, propertyId));
  const permsRaw = invite.property_co_manager_permissions;
  const nextPerms: Record<string, unknown> = {};
  if (permsRaw && typeof permsRaw === "object") {
    for (const [key, value] of Object.entries(permsRaw as Record<string, unknown>)) {
      if (!propertyIdMatches(key, propertyId)) nextPerms[key] = value;
    }
  }
  const { error } = await db
    .from("account_link_invites")
    .update({
      assigned_property_ids: assigned,
      property_co_manager_permissions: nextPerms,
    })
    .eq("id", id);
  if (error && !looksLikeMissingTableError(error)) throw new Error(error.message);
  return true;
}

/**
 * After a listing is deleted: drop it from every co-manager link and scrub
 * housing / placement fields from application (resident) rows for that property
 * so Managers → Residents no longer shows the deleted address, room, or dates.
 */
export async function clearHousingAccessForDeletedProperty(
  db: ServiceDb,
  propertyId: string,
): Promise<{ invitesUpdated: number; applicationsCleared: number }> {
  const pid = propertyId.trim();
  if (!pid) return { invitesUpdated: 0, applicationsCleared: 0 };

  let invitesUpdated = 0;
  let applicationsCleared = 0;

  const { data: invites, error: inviteErr } = await db
    .from("account_link_invites")
    .select("id, assigned_property_ids, property_co_manager_permissions");
  if (inviteErr && !looksLikeMissingTableError(inviteErr)) {
    throw new Error(inviteErr.message);
  }
  for (const invite of invites ?? []) {
    if (await stripPropertyFromInviteRow(db, invite, pid)) invitesUpdated += 1;
  }

  // Two .eq queries instead of a .or() filter: pid is client-supplied (it is
  // the deleted record's id) and PostgREST .or() strings are injectable via
  // commas/parens — .eq binds the value safely.
  const [byProperty, byAssigned] = await Promise.all([
    db
      .from("manager_application_records")
      .select("id, manager_user_id, property_id, assigned_property_id, row_data")
      .eq("property_id", pid),
    db
      .from("manager_application_records")
      .select("id, manager_user_id, property_id, assigned_property_id, row_data")
      .eq("assigned_property_id", pid),
  ]);
  for (const res of [byProperty, byAssigned]) {
    if (res.error && !looksLikeMissingTableError(res.error)) {
      throw new Error(res.error.message);
    }
  }
  const appRows = [...(byProperty.data ?? []), ...(byAssigned.data ?? [])];

  const seenAppIds = new Set<string>();
  for (const app of appRows ?? []) {
    const id = String((app as { id?: unknown }).id ?? "").trim();
    if (!id) continue;
    seenAppIds.add(id);
    const { error } = await db
      .from("manager_application_records")
      .update({
        property_id: null,
        assigned_property_id: null,
        row_data: sealApplicantRow(scrubHousingFromRowData((app as { row_data?: unknown }).row_data), id, String(app.manager_user_id ?? ((app as { row_data?: { managerUserId?: string } }).row_data)?.managerUserId ?? "")),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error && !looksLikeMissingTableError(error)) throw new Error(error.message);
    applicationsCleared += 1;
  }

  // Fallback for older rows that only keep the property id inside row_data.
  const { data: legacyApps, error: legacyErr } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, property_id, assigned_property_id, row_data")
    .is("property_id", null)
    .is("assigned_property_id", null)
    .limit(500);
  if (!legacyErr || looksLikeMissingTableError(legacyErr)) {
    for (const app of legacyApps ?? []) {
      const id = String((app as { id?: unknown }).id ?? "").trim();
      if (!id || seenAppIds.has(id)) continue;
      if (!rowDataReferencesProperty((app as { row_data?: unknown }).row_data, pid)) continue;
      const { error } = await db
        .from("manager_application_records")
        .update({
          property_id: null,
          assigned_property_id: null,
          row_data: sealApplicantRow(scrubHousingFromRowData((app as { row_data?: unknown }).row_data), id, String(app.manager_user_id ?? ((app as { row_data?: { managerUserId?: string } }).row_data)?.managerUserId ?? "")),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error && !looksLikeMissingTableError(error)) throw new Error(error.message);
      applicationsCleared += 1;
    }
  }

  const { data: relRows, error: relErr } = await db
    .from("portal_pro_relationship_records")
    .select("id, row_data");
  if (!relErr || looksLikeMissingTableError(relErr)) {
    for (const rel of relRows ?? []) {
      const id = String((rel as { id?: unknown }).id ?? "").trim();
      const rowData = (rel as { row_data?: unknown }).row_data;
      if (!id || !rowData || typeof rowData !== "object") continue;
      const assigned = asStringArray((rowData as { assignedPropertyIds?: unknown }).assignedPropertyIds);
      if (!assigned.some((idValue) => propertyIdMatches(idValue, pid))) continue;
      const nextAssigned = assigned.filter((idValue) => !propertyIdMatches(idValue, pid));
      const permsRaw = (rowData as { propertyCoManagerPermissions?: unknown }).propertyCoManagerPermissions;
      const nextPerms: Record<string, unknown> = {};
      if (permsRaw && typeof permsRaw === "object") {
        for (const [key, value] of Object.entries(permsRaw as Record<string, unknown>)) {
          if (!propertyIdMatches(key, pid)) nextPerms[key] = value;
        }
      }
      const { error } = await db
        .from("portal_pro_relationship_records")
        .update({
          row_data: {
            ...(rowData as Record<string, unknown>),
            assignedPropertyIds: nextAssigned,
            propertyCoManagerPermissions: nextPerms,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error && !looksLikeMissingTableError(error)) throw new Error(error.message);
    }
  }

  return { invitesUpdated, applicationsCleared };
}
