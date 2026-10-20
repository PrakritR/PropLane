import type { SupabaseClient } from "@supabase/supabase-js";

/** Keeps profile_roles in sync when profiles are written (service or self). */
export async function ensureProfileRoleRow(
  supabase: SupabaseClient,
  userId: string,
  role: ProfileRoleName,
) {
  const { error } = await supabase.from("profile_roles").upsert(
    { user_id: userId, role },
    { onConflict: "user_id,role" },
  );
  if (error) throw error;
}

export type ProfileRoleName = "resident" | "manager" | "admin" | "vendor";

/**
 * Stamp a role row that a LATER step still has to earn, and hand back the undo.
 *
 * A role granted before the row that justifies it (an invite accept that then fails to move to `accepted`) is a
 * standing portal grant with nothing behind it, and nothing in those flows sweeps one up. `rollback` removes only a
 * row this call actually added: a role the account already held is never taken away by someone else's failed write.
 */
export async function stampProfileRoleRow(
  supabase: SupabaseClient,
  userId: string,
  role: ProfileRoleName,
): Promise<{ rollback: () => Promise<void> }> {
  const { data: existing, error: readError } = await supabase
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", role)
    .maybeSingle();
  if (readError) throw readError;
  await ensureProfileRoleRow(supabase, userId, role);
  const added = !existing;
  return {
    rollback: async () => {
      if (!added) return;
      const { error } = await supabase.from("profile_roles").delete().eq("user_id", userId).eq("role", role);
      if (error) {
        console.error("[profile-roles] could not roll back a stamped role", { userId, role, message: error.message });
      }
    },
  };
}
