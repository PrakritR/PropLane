import { getPortalAccessContext } from "@/lib/auth/portal-access";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceRoleClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * Whether this account HOLDS the resident role, from the multi-role source of
 * truth (`profile_roles`) rather than the legacy single-value `profiles.role`.
 *
 * `profiles.role` records only whichever role the account was CREATED as, so a
 * resident who is also a manager reads back as `"manager"` forever. Every portal
 * guard already knows this and authorizes off `profile_roles` (`hasRole` in
 * `portal-access.ts`), but the resident ACCESS resolver did not — so the layout
 * admitted a manager+resident into /resident and then handed them
 * `emptyAccessState`, which resolves to nav stage `pre_approval`. That locked
 * Lease, House details, Services, Payments and Documents, and made
 * `/resident/lease` redirect to the apply wizard, no matter how approved their
 * application was: the role check short-circuits before any application is read.
 *
 * Fails CLOSED on a read failure, like `getPortalAccessContext`, but logs it —
 * a transient error otherwise reproduces the exact padlock symptom above with
 * nothing anywhere to distinguish it from a genuine "no resident role".
 *
 * Module-private on purpose: reaching for this instead of `authorizeResidentRole`
 * silently drops the legacy `profiles.role === "resident"` acceptance below and
 * newly locks out any resident whose `profile_roles` row was never backfilled.
 */
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

/**
 * The single resident-role predicate every resident-scoped server surface uses:
 * the resident portal access resolver and the resident API routes the sections
 * it unlocks call.
 *
 * A legacy `profiles.role` of `"resident"` is still accepted so an account whose
 * `profile_roles` row was never backfilled is not newly locked out; anything
 * else falls through to `profile_roles`, so a manager+resident is authorized and
 * an account holding no resident role is refused.
 */
export async function authorizeResidentRole(
  db: ServiceRoleClient,
  params: { userId: string | null | undefined; legacyRole: string | null | undefined },
): Promise<boolean> {
  if (normalizeLegacyRole(params.legacyRole) === "resident") return true;
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
