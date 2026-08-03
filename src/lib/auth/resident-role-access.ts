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

async function activePortalRole(): Promise<string> {
  try {
    const { effectiveRole } = await getPortalAccessContext();
    return normalizeLegacyRole(effectiveRole);
  } catch {
    return "";
  }
}

/**
 * Effective role for a route that serves BOTH the manager and the resident
 * portal (`/api/portal-work-orders`, `/api/portal-service-requests`), where the
 * role picks a branch in both directions: `!== "resident"` selects the manager's
 * portfolio-wide read, `=== "resident"` applies the `resident_email` scope. Both
 * branches must read the SAME value — resolving only the inequality side leaves
 * the query unscoped and returns other people's rows.
 *
 * `profiles.role` alone answers "manager" for a manager+resident in either
 * portal, which is why the resident Add-on services tab rendered the manager's
 * rows. `profile_roles` alone answers "resident" in BOTH portals, which would
 * break the same account's manager portal instead. The tiebreak is the portal
 * the request came from, which is what `getPortalAccessContext().effectiveRole`
 * already resolves: a single-role account resolves to its one role, and
 * `assertPortalLayoutRole` refuses to render any portal layout for a multi-role
 * account until `axis_active_portal` names that portal.
 *
 * That signal only ever NARROWS: it is consulted after `authorizeResidentRole`
 * has already proven the account holds the resident role, so it cannot grant
 * anything on its own. Anything it does not disambiguate keeps the legacy value,
 * i.e. today's behavior.
 */
export async function resolveResidentScopedActorRole(
  db: ServiceRoleClient,
  params: { userId: string | null | undefined; legacyRole: string | null | undefined },
): Promise<string> {
  const legacyRole = normalizeLegacyRole(params.legacyRole);
  if (legacyRole === "resident") return "resident";
  if (!(await authorizeResidentRole(db, params))) return legacyRole;
  return (await activePortalRole()) === "resident" ? "resident" : legacyRole;
}
