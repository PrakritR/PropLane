import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

/** Internal calendar evidence is not part of a linked vendor's profile. */
export function vendorOwnRecordProjection(row: ManagerVendorRow): ManagerVendorRow {
  const profile = { ...row } as ManagerVendorRow & { vendorCoordinationAppointmentEvidence?: unknown };
  delete profile.vendorCoordinationAppointmentEvidence;
  return profile;
}

export type OwnVendorRecord = { id: string; managerUserId: string; row: ManagerVendorRow };

export async function resolveOwnVendorRecords(db: SupabaseClient, userId: string): Promise<OwnVendorRecord[]> {
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, row_data, updated_at")
    .eq("vendor_user_id", userId)
    .order("manager_user_id", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    managerUserId: row.manager_user_id as string,
    row: vendorOwnRecordProjection(row.row_data as ManagerVendorRow),
  }));
}

/** Stable vendor directory row for signed-in vendor user features that still need one manager link. */
export async function resolveOwnVendorRecord(
  db: SupabaseClient,
  userId: string,
): Promise<OwnVendorRecord | null> {
  return (await resolveOwnVendorRecords(db, userId))[0] ?? null;
}
