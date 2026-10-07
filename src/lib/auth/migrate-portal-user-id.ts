import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
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

const TABLES_SYNCED_BY_UPDATED_AT: ReadonlySet<string> = new Set([
  "portal_household_charge_records",
  "portal_recurring_rent_profile_records",
]);

async function updateUserIdColumn(
  db: ServiceDb,
  table: string,
  column: string,
  fromUserId: string,
  toUserId: string,
) {
  if (fromUserId === toUserId) return;
  const { error } = await db
    .from(table)
    .update({
      [column]: toUserId,
      // The household-charges incremental resync keys on updated_at (see household-charges.ts).
      ...(TABLES_SYNCED_BY_UPDATED_AT.has(table) ? { updated_at: new Date().toISOString() } : {}),
    })
    .eq(column, fromUserId);
  if (error && !looksLikeMissingTableError(error)) throw new Error(error.message);
}

async function mergeProfiles(db: ServiceDb, fromUserId: string, toUserId: string) {
  if (fromUserId === toUserId) return;

  const [{ data: fromProfile }, { data: toProfile }] = await Promise.all([
    db.from("profiles").select("*").eq("id", fromUserId).maybeSingle(),
    db.from("profiles").select("*").eq("id", toUserId).maybeSingle(),
  ]);

  if (!fromProfile && !toProfile) return;

  const merged = {
    id: toUserId,
    email: (toProfile?.email ?? fromProfile?.email ?? "").trim().toLowerCase(),
    role: toProfile?.role ?? fromProfile?.role ?? null,
    full_name: toProfile?.full_name?.trim() || fromProfile?.full_name?.trim() || null,
    manager_id: toProfile?.manager_id?.trim() || fromProfile?.manager_id?.trim() || null,
    application_approved: Boolean(toProfile?.application_approved ?? fromProfile?.application_approved),
  };

  const { error: upsertError } = await db.from("profiles").upsert(merged, { onConflict: "id" });
  if (upsertError) throw new Error(upsertError.message);

  if (fromProfile) {
    const { error: deleteError } = await db.from("profiles").delete().eq("id", fromUserId);
    if (deleteError && !looksLikeMissingTableError(deleteError)) throw new Error(deleteError.message);
  }
}

function isPortalRole(role: string): role is "resident" | "manager" | "admin" | "vendor" {
  return role === "resident" || role === "manager" || role === "admin" || role === "vendor";
}

async function mergeProfileRoles(db: ServiceDb, fromUserId: string, toUserId: string) {
  if (fromUserId === toUserId) return;
  const { data: roleRows } = await db.from("profile_roles").select("role").eq("user_id", fromUserId);
  for (const row of roleRows ?? []) {
    const role = String(row.role ?? "").trim();
    if (!role || !isPortalRole(role)) continue;
    await ensureProfileRoleRow(db, toUserId, role);
  }
  const { error } = await db.from("profile_roles").delete().eq("user_id", fromUserId);
  if (error && !looksLikeMissingTableError(error)) throw new Error(error.message);
}

/** Move portal rows and profile data from one auth user id to another (same person, different login). */
export async function migratePortalUserId(db: ServiceDb, fromUserId: string, toUserId: string): Promise<void> {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return;

  await mergeProfiles(db, fromUserId, toUserId);
  await mergeProfileRoles(db, fromUserId, toUserId);

  const userIdColumns: Array<[string, string]> = [
    ["manager_purchases", "user_id"],
    ["manager_property_records", "manager_user_id"],
    ["manager_application_records", "manager_user_id"],
    ["manager_vendor_records", "manager_user_id"],
    ["portal_household_charge_records", "manager_user_id"],
    ["portal_recurring_rent_profile_records", "manager_user_id"],
    ["portal_lease_pipeline_records", "manager_user_id"],
    ["portal_work_order_records", "manager_user_id"],
    ["portal_schedule_records", "manager_user_id"],
    ["portal_pro_relationship_records", "manager_user_id"],
    ["portal_pro_relationship_records", "related_user_id"],
    ["portal_inbox_thread_records", "owner_user_id"],
    ["portal_bug_feedback_records", "reporter_user_id"],
    ["account_link_invites", "inviter_user_id"],
    ["account_link_invites", "invitee_user_id"],
    ["screening_orders", "manager_user_id"],
    ["cosigner_submission_records", "manager_user_id"],
    ["ledger_entries", "manager_user_id"],
    ["ledger_entries", "resident_user_id"],
    ["manager_expense_entries", "manager_user_id"],
    ["portal_household_charge_records", "resident_user_id"],
    ["portal_recurring_rent_profile_records", "resident_user_id"],
    ["portal_lease_pipeline_records", "resident_user_id"],
    ["portal_resident_lease_upload_records", "resident_user_id"],
  ];

  for (const [table, column] of userIdColumns) {
    await updateUserIdColumn(db, table, column, fromUserId, toUserId);
  }

  const { data: vendorTaxRows } = await db
    .from("vendor_tax_profiles")
    .select("vendor_id, row_data")
    .eq("manager_user_id", fromUserId);
  for (const row of vendorTaxRows ?? []) {
    await db.from("vendor_tax_profiles").delete().eq("manager_user_id", fromUserId).eq("vendor_id", row.vendor_id);
    await db.from("vendor_tax_profiles").upsert(
      {
        manager_user_id: toUserId,
        vendor_id: row.vendor_id,
        row_data: row.row_data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "manager_user_id,vendor_id" },
    );
  }

  const { data: managerTax } = await db.from("manager_tax_profiles").select("*").eq("manager_user_id", fromUserId).maybeSingle();
  if (managerTax) {
    await db.from("manager_tax_profiles").delete().eq("manager_user_id", fromUserId);
    await db.from("manager_tax_profiles").upsert(
      { ...managerTax, manager_user_id: toUserId },
      { onConflict: "manager_user_id" },
    );
  }
}
