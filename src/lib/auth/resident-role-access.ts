import { getPortalAccessContext } from "@/lib/auth/portal-access";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceRoleClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Read the stored resident capability; errors deny access. */
async function holdsResidentRole(db: ServiceRoleClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("profile_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "resident")
      .maybeSingle();
    if (error) {
      console.error("holdsResidentRole profile_roles read failed", { userId, message: error.message });
      return false;
    }
    return Boolean(data);
  } catch (e) {
    console.error("holdsResidentRole profile_roles read threw", {
      userId,
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

function normalizeLegacyRole(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Authorize resident APIs only from stored profile_roles. */
export async function authorizeResidentRole(
  db: ServiceRoleClient,
  params: { userId: string | null | undefined; legacyRole: string | null | undefined },
): Promise<boolean> {
  const userId = typeof params.userId === "string" ? params.userId.trim() : "";
  if (!userId) return false;
  return holdsResidentRole(db, userId);
}

/**
 * Resolve dual-audience API access from STORED roles only. The capability is the `profile_roles` row;
 * the active portal merely narrows which of two capabilities a request is exercising.
 *
 * An account acting as the resident reads as the resident. An account that stores the manager role
 * reads as that manager when the request says so — including a manager who is also a platform
 * admin, who `AGENTS.md` § "Admin borrows" says "reads and writes as the manager they are" outside
 * explicit `?oversight=admin`.
 *
 * Widening to manager needs a portal context this request can actually trust AND an active portal
 * that EXPLICITLY names it. A context that cannot be read (the read failed, or
 * `getPortalAccessContext` threw its phone-gate `redirect()`), one that belongs to another session,
 * one whose own role list disagrees with the stored roles, and one with no valid
 * `axis_active_portal` cookie at all (`getPortalAccessContext` returns a null `effectiveRole` for
 * every multi-role account without one) all narrow to resident instead — the broader scope is never
 * granted on the strength of a failure or a missing answer. An account that holds no resident role
 * has no narrower scope to fall back to, so there the stored manager capability still answers.
 *
 * An account that stores neither resident nor manager (admin-only, vendor-only) is denied: these
 * routes have no scope to give it. An unreadable role list is denied.
 */
export async function resolveResidentScopedActorRole(
  db: ServiceRoleClient,
  params: { userId: string | null | undefined; legacyRole: string | null | undefined },
): Promise<string> {
  const userId = typeof params.userId === "string" ? params.userId.trim() : "";
  if (!userId) return "denied";
  try {
    const { data, error } = await db.from("profile_roles").select("role").eq("user_id", userId);
    if (error) return "denied";
    const roles = (data ?? []).map((row) => normalizeLegacyRole(row.role)).filter((role) => ["resident", "manager", "vendor", "admin"].includes(role));
    if (!roles.length) return "denied";
    if (roles.length === 1) return ["resident", "manager"].includes(roles[0]!) ? roles[0]! : "denied";
    const narrowest = roles.includes("resident") ? "resident" : "denied";
    const context = await getPortalAccessContext().catch(() => null);
    const trusted =
      Boolean(context?.user?.id) &&
      context!.user!.id === userId &&
      roles.every((role) => (context!.roles as readonly string[]).map(normalizeLegacyRole).includes(role));
    if (!trusted) return narrowest;
    const active = normalizeLegacyRole(context!.effectiveRole);
    if (active === "resident" && roles.includes("resident")) return "resident";
    if ((active === "manager" || active === "admin") && roles.includes("manager")) return "manager";
    if (!roles.includes("resident") && roles.includes("manager")) return "manager";
    return narrowest;
  } catch {
    return "denied";
  }
}
