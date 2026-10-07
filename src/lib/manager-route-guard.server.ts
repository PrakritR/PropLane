import type { SupabaseClient } from "@supabase/supabase-js";
import { withholdManagerSurface } from "@/lib/property-owner/access.server";
import { getRequestUserFast } from "@/lib/auth/request-user-fast.server";
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
 *
 * `{ fast: true }` resolves the caller from the verified token claims instead
 * of a GoTrue round trip (`request-user-fast.server.ts`). Claims reflect the
 * token, not a fresh read, so a revoked or banned session still reads until the
 * token expires. That is acceptable for READS ONLY: pass `fast: true` only from
 * a GET/HEAD handler that has no side effects; every mutating handler keeps the
 * default `getUser()`. If the claims cannot be verified this falls back to
 * `getUser()`, never to "allowed". `user_metadata.role` keeps the same meaning
 * (a legacy fallback consulted only when `profiles.role` is empty).
 */
export async function requireManagerRouteUser(
  opts?: { fast?: boolean },
): Promise<{ db: SupabaseClient; userId: string } | null> {
  const supabaseAuth = await createSupabaseServerClient();
  let user: { id: string; user_metadata?: Record<string, unknown> } | null =
    opts?.fast === true ? await getRequestUserFast(supabaseAuth) : null;
  if (!user?.id) {
    const {
      data: { user: fresh },
    } = await supabaseAuth.auth.getUser();
    user = fresh;
  }
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
  // A Property owner carries the manager role row only to load the owner
  // shell; they are not a manager and every manager-portal API refuses them.
  if (await withholdManagerSurface(db, user.id)) return null;
  return { db, userId: user.id };
}
