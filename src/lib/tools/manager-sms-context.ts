/**
 * AgentContext resolved from a webhook instead of an authenticated session, for
 * the manager SMS agent.
 *
 * The identity gate is NOT here — it is `resolveManagerSmsInboundIdentity`
 * (`src/lib/sms/manager-sms-access.server.ts`), and it is the only thing standing
 * between an inbound text and this manager's portfolio. Three facts must
 * hold before this resolver is ever called:
 *
 *   1. The `To` number is a work number owned by exactly one manager, resolved
 *      from the authoritative `manager_sms_numbers` assignment. That pins the
 *      work-number owner BEFORE any phone comparison, so a match can never
 *      cross tenants.
 *   2. `From` is that owner's verified `profiles.phone`, or a verified
 *      co-manager of that owner with a current accepted assignment.
 *   3. That profile's `phone_verified_at` is set. An unverified phone is
 *      user-editable and forgeable, and any write that changes `profiles.phone`
 *      must null the stamp (see docs/agents/sms-system.md).
 *
 * This resolver then does only what `resolveAgentContext` does minus the
 * session: read email + roles and refuse anyone who is not a manager, owner, or
 * admin. On a delegated turn `landlordId` stays the work-number owner (data
 * tenant) and `userId` is the co-manager (actor). Combined turns keep both as
 * the texter so owned-house tools stay unchanged.
 *
 * NOTE ON TRUST: a Twilio `From` header is attacker-influencable. That is why
 * `buildManagerSmsRegistry` (`src/lib/tools/index.ts`) withholds every
 * destructive tool from this surface — see its doc comment.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import type { ManagerSmsAccess } from "@/lib/sms/manager-sms-access";
import type { AgentContext } from "@/lib/tools/context";

export type ManagerSmsIdentityFailure = "no_profile" | "not_a_manager" | "lookup_failed";

export type ManagerSmsIdentity =
  | { ok: true; ctx: AgentContext }
  | { ok: false; reason: ManagerSmsIdentityFailure };

/**
 * Build the manager agent context for an actor already identified by
 * `resolveManagerSmsInboundIdentity`. Never call this with an id derived from
 * anything the inbound message carried.
 */
export async function resolveManagerSmsAgentContext(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    actorUserId?: string;
    access?: ManagerSmsAccess;
  },
): Promise<ManagerSmsIdentity> {
  const workNumberOwnerId = args.managerUserId.trim();
  const actorUserId = (args.actorUserId ?? args.managerUserId).trim();
  if (!workNumberOwnerId || !actorUserId) return { ok: false, reason: "no_profile" };

  const [{ data: profile, error: profileError }, { data: roleRows, error: roleError }] = await Promise.all([
    db.from("profiles").select("email, role").eq("id", actorUserId).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", actorUserId),
  ]);
  // Fail closed: an unreadable role table must never resolve to "no roles" and
  // then fall through to some other reading of the text.
  if (profileError || roleError) return { ok: false, reason: "lookup_failed" };
  if (!profile) return { ok: false, reason: "no_profile" };

  // `profiles.role` is legacy and singular; `profile_roles` is the source of
  // truth for a multi-role account (a manager who also rents somewhere).
  const roleList = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const legacyRole = String(profile.role ?? "").toLowerCase();
  const roles = roleList.length > 0 ? roleList : legacyRole ? [legacyRole] : [];

  let isAdmin = false;
  try {
    isAdmin = await userHoldsAdminRole(db, actorUserId);
  } catch {
    isAdmin = false;
  }
  if (!isAdmin && !roles.some((r) => r === "manager" || r === "owner")) {
    return { ok: false, reason: "not_a_manager" };
  }

  const access = args.access;
  const landlordId = access?.mode === "delegated" ? workNumberOwnerId : actorUserId;

  return {
    ok: true,
    ctx: {
      landlordId,
      userId: actorUserId,
      email: String(profile.email ?? "").trim().toLowerCase(),
      roles,
      isAdmin,
      db: db as AgentContext["db"],
      ...(access ? { managerSmsAccess: access } : {}),
    },
  };
}
