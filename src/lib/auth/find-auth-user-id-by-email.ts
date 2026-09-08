import type { SupabaseClient } from "@supabase/supabase-js";

/** Service-role client only (`auth.admin`). */
export async function findAuthUserIdByEmail(supabase: SupabaseClient, email: string): Promise<string | null> {
  const normal = email.trim().toLowerCase();
  // Fast path: check profiles table (populated for all provisioned accounts).
  const { data: profileRow, error: profileError } = await supabase.from("profiles").select("id").eq("email", normal).maybeSingle();
  if (profileError && profileError.code !== "PGRST116") throw new Error(profileError.message);
  if (profileRow?.id) {
    const { data, error } = await supabase.auth.admin.getUserById(String(profileRow.id));
    if (error && error.code !== "user_not_found") throw new Error(error.message);
    if (data.user?.email?.trim().toLowerCase() === normal) return data.user.id;
  }
  // Fallback: scan auth users for accounts that were created but haven't had a profile upserted yet.
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    const user = users.find(candidate => candidate.email?.trim().toLowerCase() === normal);
    if (user) return user.id;
    if (users.length < 1000) return null;
  }
}
