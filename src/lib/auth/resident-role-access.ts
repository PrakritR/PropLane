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

/** Resolve dual-audience API access from stored roles. Multi-role portal context
 * narrows that capability; an unavailable context falls back to resident scope. */
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
    const context = await getPortalAccessContext().catch(() => null);
    const active = normalizeLegacyRole(context?.effectiveRole);
    if (context?.user?.id === userId && roles.every((role) => context.roles.includes(role as never)) && roles.includes(active) && ["resident", "manager"].includes(active)) return active;
    return roles.includes("resident") ? "resident" : "denied";
  } catch {
    return "denied";
  }
}
