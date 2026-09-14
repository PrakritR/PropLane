import { purgeAccountStorageFolder } from "@/lib/auth/purge-account-storage";
import { applicationPhotoFolderKey } from "@/lib/rental-application/application-photos.server";
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

function rowDataReferencesProperty(rowData: unknown, propertyId: string): boolean {
  if (!rowData || typeof rowData !== "object") return false;
  const row = rowData as Record<string, unknown>;
  return (
    propertyIdMatches(row.assignedPropertyId, propertyId) ||
    propertyIdMatches(row.propertyId, propertyId) ||
    propertyIdMatches((row.application as { propertyId?: unknown } | undefined)?.propertyId, propertyId)
  );
}

function resolvedPropertyIds(row: {
  property_id?: unknown;
  assigned_property_id?: unknown;
  row_data?: unknown;
}): string[] {
  const ids = [
    String(row.property_id ?? "").trim(),
    String(row.assigned_property_id ?? "").trim(),
  ];
  const rowData = row.row_data;
  if (rowData && typeof rowData === "object") {
    const data = rowData as Record<string, unknown>;
    ids.push(String(data.propertyId ?? "").trim());
    ids.push(String(data.assignedPropertyId ?? "").trim());
    const application = data.application;
    if (application && typeof application === "object") {
      ids.push(String((application as { propertyId?: unknown }).propertyId ?? "").trim());
    }
  }
  return [...new Set(ids.filter(Boolean))];
}

function rowIsOrphanedFromLiveProperties(
  row: { property_id?: unknown; assigned_property_id?: unknown; row_data?: unknown },
  livePropertyIds: Set<string>,
): boolean {
  const ids = resolvedPropertyIds(row);
  if (ids.length === 0) return true;
  return ids.every((id) => !livePropertyIds.has(id));
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

async function throwIfRealError(error: { message?: string } | null | undefined): Promise<void> {
  if (error && !looksLikeMissingTableError(error)) throw new Error(error.message);
}

async function deleteByExactColumn(
  db: ServiceDb,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const { data, error: selectError } = await db.from(table).select("*").eq(column, value);
  await throwIfRealError(selectError);
  const rows = data ?? [];
  const { error } = await db.from(table).delete().eq(column, value);
  await throwIfRealError(error);
  return rows.length;
}

async function deleteRowsById(db: ServiceDb, table: string, ids: string[]): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    const { error } = await db.from(table).delete().eq("id", id);
    await throwIfRealError(error);
    deleted += 1;
  }
  return deleted;
}

async function collectIdsByExactColumn(
  db: ServiceDb,
  table: string,
  column: string,
  value: string,
): Promise<string[]> {
  const { data, error } = await db.from(table).select("id").eq(column, value);
  await throwIfRealError(error);
  return (data ?? [])
    .map((row) => String((row as { id?: unknown }).id ?? "").trim())
    .filter(Boolean);
}

async function bestEffortStorage(db: ServiceDb, bucket: string, folder: string): Promise<void> {
  try {
    await purgeAccountStorageFolder(db, bucket, folder);
  } catch {
    // A mock client, missing bucket, or older environment must not block the
    // housing-row delete the captain asked for.
  }
}

const PROPERTY_SCOPED_DELETE_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: "application_fee_waiver_redemptions", column: "property_id" },
  { table: "document_share_links", column: "property_id" },
  { table: "portal_record_share_links", column: "property_id" },
  { table: "manager_house_public_links", column: "property_id" },
  { table: "manager_application_fee_waiver_codes", column: "property_id" },
  { table: "property_utility_allocations", column: "property_id" },
  { table: "sales_migration_records", column: "property_id" },
  { table: "external_calendar_connections", column: "property_id" },
  { table: "manager_property_access", column: "property_id" },
  { table: "manager_property_owners", column: "property_id" },
  { table: "resident_tour_links", column: "property_id" },
  { table: "manager_sms_conversation_houses", column: "property_id" },
  { table: "resident_inspections", column: "property_id" },
  { table: "portal_schedule_records", column: "property_id" },
  { table: "portal_service_request_records", column: "property_id" },
  { table: "portal_work_order_records", column: "property_id" },
  { table: "portal_work_order_records", column: "assigned_property_id" },
  { table: "portal_recurring_rent_profile_records", column: "property_id" },
  { table: "portal_household_charge_records", column: "property_id" },
  { table: "portal_lease_pipeline_records", column: "property_id" },
  { table: "manager_payment_plans", column: "property_id" },
  { table: "manager_late_fee_waivers", column: "property_id" },
  { table: "manager_bills", column: "property_id" },
  { table: "manager_documents", column: "property_id" },
  { table: "manager_budgets", column: "property_id" },
  { table: "prospect_sms_bursts", column: "property_id" },
  { table: "ledger_entries", column: "property_id" },
  { table: "security_deposit_ledger", column: "property_id" },
  { table: "gl_journal_lines", column: "property_id" },
  { table: "gl_journal_entries", column: "property_id" },
];

const MANAGER_SCOPED_HOUSING_TABLES: ReadonlyArray<{
  table: string;
  select: string;
}> = [
  { table: "manager_application_records", select: "id, manager_user_id, property_id, assigned_property_id, row_data" },
  { table: "portal_lease_pipeline_records", select: "id, manager_user_id, property_id, row_data" },
  { table: "portal_household_charge_records", select: "id, manager_user_id, property_id, row_data" },
  { table: "portal_recurring_rent_profile_records", select: "id, manager_user_id, property_id, row_data" },
  { table: "portal_work_order_records", select: "id, manager_user_id, property_id, assigned_property_id, row_data" },
  { table: "portal_service_request_records", select: "id, manager_user_id, property_id, row_data" },
  { table: "portal_schedule_records", select: "id, manager_user_id, property_id, row_data" },
  { table: "resident_inspections", select: "id, manager_user_id, property_id" },
  { table: "manager_sms_conversation_houses", select: "conversation_key, manager_user_id, property_id" },
  { table: "resident_tour_links", select: "id, manager_user_id, property_id" },
  { table: "manager_house_public_links", select: "id, manager_user_id, property_id" },
  { table: "manager_application_fee_waiver_codes", select: "id, manager_user_id, property_id" },
  { table: "portal_reminder_records", select: "id, manager_user_id, payload" },
  { table: "portal_scheduled_inbox_message_records", select: "id, manager_user_id, row_data" },
];

async function deleteApplicationDependents(db: ServiceDb, applicationIds: string[]): Promise<void> {
  for (const applicationId of applicationIds) {
    await bestEffortStorage(db, "application-documents", `application/${applicationPhotoFolderKey(applicationId)}`);
    const { error: screeningErr } = await db.from("screening_orders").delete().eq("application_id", applicationId);
    await throwIfRealError(screeningErr);
    const { error: cosignerErr } = await db.from("cosigner_submission_records").delete().eq("signer_app_id", applicationId);
    await throwIfRealError(cosignerErr);
  }
}

async function deleteWorkOrderDependents(db: ServiceDb, workOrderIds: string[]): Promise<void> {
  for (const workOrderId of workOrderIds) {
    const { error: bidErr } = await db.from("work_order_bids").delete().eq("work_order_id", workOrderId);
    await throwIfRealError(bidErr);
    const { error: offerErr } = await db.from("work_order_vendor_offers").delete().eq("work_order_id", workOrderId);
    await throwIfRealError(offerErr);
  }
}

async function pruneTourHostRegistry(db: ServiceDb, propertyId: string): Promise<void> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("id", "axis_property_mgr_registry_v1");
  await throwIfRealError(error);
  const registry = (data ?? [])[0];
  if (!registry || typeof registry !== "object") return;
  const rowData = (registry as { row_data?: unknown }).row_data;
  if (!rowData || typeof rowData !== "object") return;
  const payload = (rowData as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const nextPayload = { ...(payload as Record<string, unknown>) };
  let changed = false;
  for (const key of Object.keys(nextPayload)) {
    if (propertyIdMatches(key, propertyId)) {
      delete nextPayload[key];
      changed = true;
    }
  }
  if (!changed) return;
  const { error: updateErr } = await db
    .from("portal_schedule_records")
    .update({ row_data: { ...(rowData as Record<string, unknown>), payload: nextPayload } })
    .eq("id", "axis_property_mgr_registry_v1");
  await throwIfRealError(updateErr);
}

async function deleteRemindersForProperty(db: ServiceDb, propertyId: string): Promise<number> {
  const { data, error } = await db.from("portal_reminder_records").select("id, payload").limit(2000);
  await throwIfRealError(error);
  const ids: string[] = [];
  for (const row of data ?? []) {
    const id = String((row as { id?: unknown }).id ?? "").trim();
    const payload = (row as { payload?: unknown }).payload;
    if (!id || !payload || typeof payload !== "object") continue;
    if (propertyIdMatches((payload as { propertyId?: unknown }).propertyId, propertyId)) ids.push(id);
  }
  return deleteRowsById(db, "portal_reminder_records", ids);
}

async function deleteScheduledInboxForProperty(db: ServiceDb, propertyId: string): Promise<number> {
  const { data, error } = await db.from("portal_scheduled_inbox_message_records").select("id, row_data").limit(2000);
  await throwIfRealError(error);
  const ids: string[] = [];
  for (const row of data ?? []) {
    const id = String((row as { id?: unknown }).id ?? "").trim();
    if (!id) continue;
    if (rowDataReferencesProperty((row as { row_data?: unknown }).row_data, propertyId)) ids.push(id);
  }
  return deleteRowsById(db, "portal_scheduled_inbox_message_records", ids);
}

async function stripPropertyFromInviteLinks(db: ServiceDb, propertyId: string): Promise<void> {
  const { data, error } = await db.from("manager_invite_links").select("id, assigned_property_ids");
  await throwIfRealError(error);
  for (const row of data ?? []) {
    const id = String((row as { id?: unknown }).id ?? "").trim();
    const assignedRaw = asStringArray((row as { assigned_property_ids?: unknown }).assigned_property_ids);
    if (!id || !assignedRaw.some((idValue) => propertyIdMatches(idValue, propertyId))) continue;
    const assigned = assignedRaw.filter((idValue) => !propertyIdMatches(idValue, propertyId));
    const { error: updateErr } = await db
      .from("manager_invite_links")
      .update({ assigned_property_ids: assigned })
      .eq("id", id);
    await throwIfRealError(updateErr);
  }
}

async function collectApplicationIdsForProperty(db: ServiceDb, propertyId: string): Promise<string[]> {
  const [byProperty, byAssigned] = await Promise.all([
    db
      .from("manager_application_records")
      .select("id, manager_user_id, property_id, assigned_property_id, row_data")
      .eq("property_id", propertyId),
    db
      .from("manager_application_records")
      .select("id, manager_user_id, property_id, assigned_property_id, row_data")
      .eq("assigned_property_id", propertyId),
  ]);
  await throwIfRealError(byProperty.error);
  await throwIfRealError(byAssigned.error);

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const app of [...(byProperty.data ?? []), ...(byAssigned.data ?? [])]) {
    const id = String((app as { id?: unknown }).id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const { data: legacyApps, error: legacyErr } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, property_id, assigned_property_id, row_data")
    .is("property_id", null)
    .is("assigned_property_id", null)
    .limit(500);
  if (!legacyErr || looksLikeMissingTableError(legacyErr)) {
    for (const app of legacyApps ?? []) {
      const id = String((app as { id?: unknown }).id ?? "").trim();
      if (!id || seen.has(id)) continue;
      if (!rowDataReferencesProperty((app as { row_data?: unknown }).row_data, propertyId)) continue;
      seen.add(id);
      ids.push(id);
    }
  } else {
    throw new Error(legacyErr.message);
  }
  return ids;
}

/**
 * After a listing is deleted: drop it from every co-manager link and DELETE
 * residents, applications, leases, payments, reminders, services, and other
 * housing rows that pointed at that exact property id.
 */
export async function clearHousingAccessForDeletedProperty(
  db: ServiceDb,
  propertyId: string,
): Promise<{ invitesUpdated: number; applicationsCleared: number; recordsDeleted: number }> {
  const pid = propertyId.trim();
  if (!pid) return { invitesUpdated: 0, applicationsCleared: 0, recordsDeleted: 0 };

  let invitesUpdated = 0;
  let recordsDeleted = 0;

  const { data: invites, error: inviteErr } = await db
    .from("account_link_invites")
    .select("id, assigned_property_ids, property_co_manager_permissions");
  if (inviteErr && !looksLikeMissingTableError(inviteErr)) {
    throw new Error(inviteErr.message);
  }
  for (const invite of invites ?? []) {
    if (await stripPropertyFromInviteRow(db, invite, pid)) invitesUpdated += 1;
  }
  await stripPropertyFromInviteLinks(db, pid);

  const applicationIds = await collectApplicationIdsForProperty(db, pid);
  await deleteApplicationDependents(db, applicationIds);

  const workOrderIds = [
    ...(await collectIdsByExactColumn(db, "portal_work_order_records", "property_id", pid)),
    ...(await collectIdsByExactColumn(db, "portal_work_order_records", "assigned_property_id", pid)),
  ];
  await deleteWorkOrderDependents(db, [...new Set(workOrderIds)]);

  const { data: inspections } = await db.from("resident_inspections").select("id, manager_user_id").eq("property_id", pid);
  for (const report of inspections ?? []) {
    const id = String((report as { id?: unknown }).id ?? "").trim();
    const owner = String((report as { manager_user_id?: unknown }).manager_user_id ?? "").trim();
    if (id && owner) await bestEffortStorage(db, "inspection-evidence", `${owner}/${id}`);
  }

  recordsDeleted += await deleteRemindersForProperty(db, pid);
  recordsDeleted += await deleteScheduledInboxForProperty(db, pid);

  for (const { table, column } of PROPERTY_SCOPED_DELETE_TABLES) {
    recordsDeleted += await deleteByExactColumn(db, table, column, pid);
  }

  recordsDeleted += await deleteRowsById(db, "manager_application_records", applicationIds);

  await pruneTourHostRegistry(db, pid);

  const { data: relRows, error: relErr } = await db.from("portal_pro_relationship_records").select("id, row_data");
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

  return {
    invitesUpdated,
    applicationsCleared: applicationIds.length,
    recordsDeleted: recordsDeleted + applicationIds.length,
  };
}

/**
 * Remove this manager's housing rows whose property is gone or was never on
 * their live portfolio (owned + co-manager-linked). Used to heal leftovers
 * from the old "Moved out" scrub and from properties deleted before cascade.
 */
export async function purgeOrphanHousingRecordsForManager(
  db: ServiceDb,
  managerUserId: string,
  livePropertyIds: Set<string>,
): Promise<{ applicationsCleared: number; recordsDeleted: number }> {
  const uid = managerUserId.trim();
  if (!uid) return { applicationsCleared: 0, recordsDeleted: 0 };

  let applicationsCleared = 0;
  let recordsDeleted = 0;

  for (const { table, select } of MANAGER_SCOPED_HOUSING_TABLES) {
    const { data, error } = await db.from(table).select(select).eq("manager_user_id", uid);
    await throwIfRealError(error);
    const orphanIds: string[] = [];
    const orphanPropertyIds: string[] = [];
    for (const row of data ?? []) {
      const reminderPayload = (row as { payload?: unknown }).payload;
      const asHousingRow = reminderPayload
        ? { property_id: (reminderPayload as { propertyId?: unknown }).propertyId, row_data: reminderPayload }
        : (row as { property_id?: unknown; assigned_property_id?: unknown; row_data?: unknown });
      if (!rowIsOrphanedFromLiveProperties(asHousingRow, livePropertyIds)) continue;
      const id = String((row as { id?: unknown }).id ?? "").trim();
      const propertyId = String((row as { property_id?: unknown }).property_id ?? "").trim();
      if (id) orphanIds.push(id);
      else if (propertyId) orphanPropertyIds.push(propertyId);
    }
    if (table === "manager_application_records") {
      await deleteApplicationDependents(db, orphanIds);
      applicationsCleared += orphanIds.length;
    }
    if (table === "portal_work_order_records") {
      await deleteWorkOrderDependents(db, orphanIds);
    }
    if (table === "resident_inspections") {
      for (const row of data ?? []) {
        const id = String((row as { id?: unknown }).id ?? "").trim();
        if (!orphanIds.includes(id)) continue;
        const owner = String((row as { manager_user_id?: unknown }).manager_user_id ?? "").trim();
        if (id && owner) await bestEffortStorage(db, "inspection-evidence", `${owner}/${id}`);
      }
    }
    recordsDeleted += await deleteRowsById(db, table, orphanIds);
    for (const propertyId of orphanPropertyIds) {
      const { data: scoped } = await db.from(table).select("*").eq("manager_user_id", uid).eq("property_id", propertyId);
      const { error } = await db.from(table).delete().eq("manager_user_id", uid).eq("property_id", propertyId);
      await throwIfRealError(error);
      recordsDeleted += (scoped ?? []).length;
    }
  }

  return { applicationsCleared, recordsDeleted };
}
