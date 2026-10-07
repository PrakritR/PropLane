import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";

/**
 * Give a person who redeemed a Property owner invite the one thing they need to
 * sign in and reach the owner portal: a profile and the `manager` portal role
 * row (the property portal is the only shell that hosts the owner routes).
 *
 * What it deliberately does NOT create, because an owner is not a manager:
 *   - no `manager_purchases` row, so no plan, trial or billing;
 *   - no workspace and no property of their own, so there is no Add property
 *     and nothing for the plan caps to count;
 *   - no manager id / work number provisioning.
 * Everything else (what they may open, what the APIs return) is decided by
 * `getOwnerAccessState` and the owner membership, not by this role row.
 *
 * Idempotent. The user id comes from the authenticated redeemer, never a body.
 *
 * `profiles.role` is the role the account was CREATED as (a legacy, singular
 * column - authorization reads `profile_roles`), so an existing resident or
 * vendor keeps theirs: accepting an owner invite must not rewrite a resident
 * account into a "manager" one. Only a brand-new profile is stamped, and only
 * so legacy readers that still consult the column can find the portal shell.
 */
export async function provisionOwnerOnlyAccess(
  db: SupabaseClient,
  user: { id: string; email?: string | null; fullName?: string | null },
): Promise<void> {
  const { data: existing } = await db
    .from("profiles")
    .select("role, full_name, application_approved")
    .eq("id", user.id)
    .maybeSingle();
  const email = (user.email ?? "").trim().toLowerCase();
  const existingRole = String((existing?.role as string | undefined) ?? "").trim();
  const { error } = await db.from("profiles").upsert(
    {
      id: user.id,
      ...(email ? { email } : {}),
      role: existingRole || primaryRoleWhenAddingManager(null),
      full_name: (existing?.full_name as string | null)?.trim() || user.fullName?.trim() || null,
      application_approved: existing?.application_approved ?? true,
    },
    { onConflict: "id" },
  );
  if (error) throw error;
  await ensureProfileRoleRow(db, user.id, "manager");
}
