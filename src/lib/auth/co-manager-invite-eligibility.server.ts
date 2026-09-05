import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Co-manager linking must read `profile_roles`, not legacy `profiles.role` alone.
 * Multi-role accounts keep the role they were created with on `profiles.role` forever
 * — a resident who later gains manager still reads `profiles.role = resident`.
 */
export async function userHasPortalRole(
  supabase: SupabaseClient,
  userId: string,
  role: "owner" | "manager",
): Promise<boolean> {
  const { data: pr } = await supabase
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", role)
    .maybeSingle();
  if (pr?.role === role) return true;
  const { data: p } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  return String((p as { role?: string } | null)?.role ?? "").toLowerCase() === role;
}

export async function userIsPropertyPortalManager(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  if (await userHasPortalRole(supabase, userId, "manager")) return true;
  return userHasPortalRole(supabase, userId, "owner");
}
