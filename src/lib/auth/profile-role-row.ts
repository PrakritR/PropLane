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
 *
 * "Added" is decided by the insert itself (`ignoreDuplicates`, so a conflicting row is left alone and not returned),
 * never by a read before the write: two parallel first-time stamps would both read "absent" and both believe they
 * added the row. The caller still owes the other half of the question - whether anything ELSE now justifies the role -
 * before it undoes anything.
 */
export async function stampProfileRoleRow(
  supabase: SupabaseClient,
  userId: string,
  role: ProfileRoleName,
): Promise<{ rollback: () => Promise<void> }> {
  const { data: inserted, error } = await supabase
    .from("profile_roles")
    .upsert({ user_id: userId, role }, { onConflict: "user_id,role", ignoreDuplicates: true })
    .select("user_id");
  if (error) throw error;
  const added = Array.isArray(inserted) && inserted.length > 0;
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
