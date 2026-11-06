import type { SupabaseClient } from "@supabase/supabase-js";

/** Admin authority comes exclusively from the stored role grant. */
export async function filterAdminUserIds(db: SupabaseClient, userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return new Set();
  const { data, error } = await db.from("profile_roles").select("user_id").eq("role", "admin").in("user_id", ids);
  if (error) {
    console.error("filterAdminUserIds profile_roles read failed", { count: ids.length, message: error.message });
    return new Set();
  }
  return new Set((data ?? []).map((row) => String(row.user_id ?? "").trim()).filter(Boolean));
}

/** For negative authorization checks, unreadable roles must never look like absence. */
export async function userHoldsAdminRoleStrict(db: SupabaseClient, userId: string): Promise<boolean> {
  const id = userId.trim();
  if (!id) throw new Error("Could not read admin roles.");
  const { data, error } = await db.from("profile_roles").select("user_id").eq("role", "admin").in("user_id", [id]);
  if (error) throw new Error("Could not read admin roles.");
  return (data ?? []).some((row) => row.user_id === id);
}

export async function userHoldsAdminRole(db: SupabaseClient, userId: string): Promise<boolean> {
  const id = userId.trim();
  return !!id && (await filterAdminUserIds(db, [id])).has(id);
}

export async function listAdminUserIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from("profile_roles").select("user_id").eq("role", "admin");
  if (error) throw new Error("Could not read admin roles.");
  return [...new Set((data ?? []).map((row) => String(row.user_id ?? "").trim()).filter(Boolean))].sort();
}
