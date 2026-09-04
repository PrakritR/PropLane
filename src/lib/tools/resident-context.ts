/**
 * ResidentAgentContext is resolved server-side from the authenticated Supabase
 * session (admin preview supported via the same effective-session helper the
 * resident portal layout uses). The resident's user id + normalized email are
 * the only scope keys, and every resident tool applies them itself — the model
 * can never supply an identity. This is the resident portal's single security
 * choke point, mirroring `resolveAgentContext` for managers.
 */
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import { loadResidentPortalAccessState } from "@/lib/resident-portal-access";
import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import type { ManagerSubscriptionTier } from "@/lib/manager-access";

export type ResidentAgentContext = {
  kind: "resident";
  userId: string;
  /** Normalized lowercase email — the primary residency scope key. */
  email: string;
  /** Managers linked to this resident (approved applications / charges / leases). */
  managerIds: string[];
  /**
   * Manager whose work number the resident texted. Present only for SMS.
   * Portal sessions leave this unset so their multi-manager view is unchanged.
   */
  activeManagerId?: string;
  /** Application-phase residents get a reduced toolset. */
  phase: "application" | "approved";
  /** The linked manager's subscription tier gates services/inbox tools. */
  managerTier: ManagerSubscriptionTier;
  /**
   * audit_log/agent_sessions scope column value for resident actions: the
   * resident's own user id (there may be zero or many linked managers).
   */
  landlordId: string;
  /**
   * Service-role client. It bypasses RLS, so every query built from it MUST
   * scope by resident identity: `.or("resident_user_id.eq.<uid>,resident_email.eq.<email>")`
   * or `.eq("resident_email", email)` — matching the corresponding API routes.
   */
  db: ReturnType<typeof createSupabaseServiceRoleClient>;
};

/**
 * Returns the resident agent context for the current request, or null when the
 * caller is unauthenticated or is not a resident.
 */
export async function resolveResidentAgentContext(): Promise<ResidentAgentContext | null> {
  const { user, profile } = await getEffectiveSessionForPortal("resident");
  if (!user) return null;

  const db = createSupabaseServiceRoleClient();
  const { data: roleRows } = await db.from("profile_roles").select("role").eq("user_id", user.id);
  const roleList = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const legacyRole = String(profile?.role ?? "").toLowerCase();
  const roles = roleList.length > 0 ? roleList : legacyRole ? [legacyRole] : [];
  if (!roles.includes("resident")) return null;

  const email = String(profile?.email ?? user.email ?? "").trim().toLowerCase();
  if (!email) return null;

  const managerId = String(profile?.manager_id ?? "").trim();
  const [managerIds, managerTier, access] = await Promise.all([
    managerIdsOwningResident(db, email),
    managerId ? getManagerSubscriptionTierByManagerId(managerId) : Promise.resolve(null),
    loadResidentPortalAccessState({
      userId: user.id,
      role: profile?.role,
      email,
      managerSubscriptionTier: null,
    }),
  ]);

  return {
    kind: "resident",
    userId: user.id,
    email,
    managerIds,
    phase: access.leaseAccessUnlocked ? "approved" : "application",
    managerTier,
    landlordId: user.id,
    db,
  };
}

/**
 * The `.or()` filter string matching the resident-scoped API routes.
 *
 * Returns `null` when the context carries NO identity. This filter is the
 * boundary between two residents of the same manager, so it must fail closed:
 * the old interpolated form produced `resident_user_id.eq.,resident_email.eq.`
 * in that case, which is malformed rather than restrictive. A caller that gets
 * `null` must return no rows, never issue the query unfiltered.
 */
export function residentScopeOrFilter(ctx: ResidentAgentContext): string | null {
  return orFilterForIdentity([
    ["resident_user_id", ctx.userId],
    ["resident_email", ctx.email],
  ]);
}

/** One texted owner over SMS, or every linked manager in the signed-in portal. */
export function residentManagerIds(ctx: ResidentAgentContext): string[] {
  if (!ctx.activeManagerId) return ctx.managerIds;
  return ctx.managerIds.includes(ctx.activeManagerId) ? [ctx.activeManagerId] : [];
}
