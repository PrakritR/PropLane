import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

/**
 * One canonical "is the caller a manager?" guard for manager-portal API
 * routes, so sibling routes of the same feature can never disagree about who
 * gets in (the Application settings modal vs. the waiver-code routes it hosts
 * once did — one accepted legacy owner/pro managers, the other did not).
 *
 * A manager is anyone with the additive `profile_roles` "manager" row OR a
 * legacy `profiles.role` / metadata role of manager/owner/pro/admin.
 * Residents and vendors never pass.
 */
export async function requireManagerRouteUser(): Promise<{ db: SupabaseClient; userId: string } | null> {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return null;
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager =
    roleList.includes("manager") ||
    legacy === "manager" ||
    legacy === "owner" ||
    legacy === "pro" ||
    legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}
