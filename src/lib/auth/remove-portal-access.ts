import type { SupabaseClient } from "@supabase/supabase-js";

export type PortalRole = "admin" | "manager" | "resident" | "pro" | "vendor";

function nextPrimaryRole(roles: string[]): string | null {
  if (roles.includes("admin")) return "admin";
  if (roles.includes("manager")) return "manager";
  if (roles.includes("pro")) return "pro";
  if (roles.includes("resident")) return "resident";
  if (roles.includes("vendor")) return "vendor";
  return roles[0] ?? null;
}

export async function removePortalAccess(
  svc: SupabaseClient,
  userId: string,
  roleToRemove: PortalRole,
) {
  const { data: rolesRows, error: rolesErr } = await svc
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId);
  if (rolesErr) throw new Error(rolesErr.message);

  const currentRoles = (rolesRows ?? [])
    .map((row) => String(row.role ?? "").toLowerCase())
    .filter(Boolean);

  // `profile_roles` is the multi-role source of truth, but an account created before it
  // existed — or one whose backfill never ran — carries its only role on `profiles.role`.
  // Reading `profile_roles` alone reported "no_role" for those accounts, so a delete
  // purged the data and then left the login and profile standing, and the same email
  // could not be reused. Merge the legacy role in so it is a role that can be removed.
  const { data: profileRow, error: profileReadErr } = await svc
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (profileReadErr) throw new Error(profileReadErr.message);
  const legacyRole = String(profileRow?.role ?? "").toLowerCase();
  if (legacyRole && !currentRoles.includes(legacyRole)) currentRoles.push(legacyRole);

  const removedRoles = roleToRemove === "manager" ? ["manager", "owner", "pro"] : [roleToRemove];
  if (!currentRoles.some(role => removedRoles.includes(role))) {
    return { ok: true as const, mode: "no_role" as const };
  }

  const remainingRoles = currentRoles.filter((role) => !removedRoles.includes(role));

  if (remainingRoles.length === 0) {
    const { error: deleteErr } = await svc.auth.admin.deleteUser(userId);
    if (deleteErr) throw new Error(deleteErr.message);
    return { ok: true as const, mode: "deleted_auth_user" as const };
  }

  for (const role of removedRoles) {
    const { error } = await svc.from("profile_roles").delete().eq("user_id", userId).eq("role", role);
    if (error) throw new Error(error.message);
  }

  const nextRole = nextPrimaryRole(remainingRoles);
  const profilePatch: Record<string, unknown> = {
    role: nextRole,
    updated_at: new Date().toISOString(),
  };
  if (roleToRemove === "resident") {
    profilePatch.application_approved = false;
  }

  const { error: updateErr } = await svc.from("profiles").update(profilePatch).eq("id", userId);
  if (updateErr) throw new Error(updateErr.message);

  return { ok: true as const, mode: "revoked_role" as const, remainingRoles };
}
