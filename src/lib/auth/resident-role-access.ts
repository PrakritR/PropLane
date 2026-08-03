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
 */
export async function holdsResidentRole(db: ServiceRoleClient, userId: string): Promise<boolean> {
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

/**
 * The single resident-role predicate every resident-scoped server surface uses:
 * the resident portal access resolver and the resident API routes the sections
 * it unlocks call (extend lease, move-out availability, SMS conversations).
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
  const legacyRole = String(params.legacyRole ?? "").trim().toLowerCase();
  if (legacyRole === "resident") return true;
  const userId = typeof params.userId === "string" ? params.userId.trim() : "";
  if (!userId) return false;
  return holdsResidentRole(db, userId);
}
