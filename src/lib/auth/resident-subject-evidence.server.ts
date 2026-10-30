import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Only server-stored subject ids can bind historical housing to a login. */
export async function residentSubjectManagerIds(db: SupabaseClient, userId: string, email: string): Promise<string[]> {
  if (!userId || !email) return [];
  const auth = await db.auth.admin.getUserById(userId);
  if (auth.error || !auth.data.user?.email_confirmed_at || auth.data.user.email?.trim().toLowerCase() !== email) return [];
  const ids = new Set<string>();
  const apps = await db.from("manager_application_records").select("manager_user_id, row_data").eq("resident_email", email).eq("row_data->>residentUserId", userId);
  if (apps.error) return [];
  for (const row of apps.data ?? []) {
    const data = row.row_data as Record<string, unknown> | null;
    if (data?.withdrawnAt || ["rejected", "withdrawn"].includes(String(data?.bucket ?? "").toLowerCase())) continue;
    if (row.manager_user_id) ids.add(String(row.manager_user_id));
  }
  for (const table of ["portal_household_charge_records", "portal_lease_pipeline_records"]) {
    const result = await db.from(table).select("manager_user_id").eq("resident_user_id", userId).eq("resident_email", email);
    if (result.error) return [];
    for (const row of result.data ?? []) if (row.manager_user_id) ids.add(String(row.manager_user_id));
  }
  return [...ids];
}

export async function residentSubjectHasHouse(db: SupabaseClient, userId: string, email: string, ownerId: string, propertyId: string): Promise<boolean> {
  if (!userId || !email || !ownerId || !propertyId) return false;
  const auth = await db.auth.admin.getUserById(userId);
  if (auth.error || !auth.data.user?.email_confirmed_at || auth.data.user.email?.trim().toLowerCase() !== email) return false;
  const app = await db.from("manager_application_records").select("row_data, property_id, assigned_property_id").eq("manager_user_id", ownerId).eq("resident_email", email).eq("row_data->>residentUserId", userId);
  if (app.error) return false;
  if ((app.data ?? []).some((row) => {
    const data = row.row_data as Record<string, unknown> | null;
    return !data?.withdrawnAt && !["rejected", "withdrawn"].includes(String(data?.bucket ?? "").toLowerCase()) && [row.property_id, row.assigned_property_id, data?.propertyId].includes(propertyId);
  })) return true;
  for (const table of ["portal_household_charge_records", "portal_lease_pipeline_records"]) {
    const result = await db.from(table).select("id").eq("manager_user_id", ownerId).eq("resident_user_id", userId).eq("resident_email", email).eq("property_id", propertyId).limit(1);
    if (result.error) continue;
    if ((result.data ?? []).length) return true;
  }
  return false;
}
