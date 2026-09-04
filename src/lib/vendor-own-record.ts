import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

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
    row: row.row_data as ManagerVendorRow,
  }));
}

/** Stable vendor directory row for signed-in vendor user features that still need one manager link. */
export async function resolveOwnVendorRecord(
  db: SupabaseClient,
  userId: string,
): Promise<OwnVendorRecord | null> {
  return (await resolveOwnVendorRecords(db, userId))[0] ?? null;
}

export type VendorLinkedManager = { managerUserId: string; name: string };

/**
 * The managers this vendor may bill, with a display name each.
 *
 * Serving several clients is the normal condition for a contractor, so anything that asks a
 * vendor to choose a manager needs this list. It is derived from the vendor's own directory
 * links — never from a client-supplied id — and deduplicated, because one manager can hold
 * more than one directory row for the same vendor.
 */
export async function resolveVendorLinkedManagers(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<VendorLinkedManager[]> {
  const records = await resolveOwnVendorRecords(db, vendorUserId);
  const managerIds = [...new Set(records.map((r) => r.managerUserId).filter(Boolean))];
  if (managerIds.length === 0) return [];

  const { data } = await db.from("profiles").select("id, full_name").in("id", managerIds);
  const nameById = new Map(
    (data ?? []).map((row) => [
      String((row as { id?: string }).id ?? ""),
      String((row as { full_name?: string }).full_name ?? "").trim(),
    ]),
  );
  return managerIds.map((managerUserId) => ({
    managerUserId,
    name: nameById.get(managerUserId) || "Property manager",
  }));
}
