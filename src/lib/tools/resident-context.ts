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
import { isTestWorkspaceActorAllowed } from "@/lib/test-workspaces/index.server";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import { loadResidentPortalAccessState } from "@/lib/resident-portal-access";
import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import type { ManagerSubscriptionTier } from "@/lib/manager-access";
import { loadResidentFormsFacts, type BlockingFormsPending } from "@/lib/move-in-forms/blocking";

/**
 * One image the resident attached to THIS chat turn, already stored privately
 * under the resident's own storage prefix by the chat route. `index` is the
 * position in the message's attachment list, which is how the model refers to
 * it ("the second photo"); the tool never sees bytes, only this reference.
 */
export type ResidentChatPhotoRef = {
  index: number;
  storagePath: string;
};

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
  /**
   * Where the reply is delivered. `portal` keeps links relative so they open
   * inside the app the resident is signed in on; anything else (SMS, email,
   * unset) gets absolute production links. See `domains/portal-links.ts`.
   */
  channel?: "portal" | "sms" | "email";
  /** Application-phase residents get a reduced toolset. */
  phase: "application" | "approved";
  /** The linked manager's subscription tier gates services/inbox tools. */
  managerTier: ManagerSubscriptionTier;
  /**
   * A move-in form that blocks "Move-in details" is unsubmitted (or the forms read failed, which
   * holds the same lock). The portal withholds the house's door codes, Wi-Fi, rules and instructions
   * behind this (`blockingFormsPending.moveInDetails` + `redactMoveInDetails`); every agent surface
   * must withhold the same. REQUIRED, so a context builder that forgets it fails typecheck. Build it
   * with `moveInDetailsLockFromBlocking` (from the access state's own forms read) or, where there is no
   * access state, `loadMoveInDetailsLock` — never default it to `false`.
   */
  moveInDetailsLocked: boolean;
  /** The form that unlocks it, when known (absent after a failed read — nothing is named then). */
  moveInDetailsLockFormId?: string | null;
  /** The lock is held only because the forms read failed. */
  moveInDetailsLockReadFailed?: boolean;
  /**
   * audit_log/agent_sessions scope column value for resident actions: the
   * resident's own user id (there may be zero or many linked managers).
   */
  landlordId: string;
  /**
   * Photos attached to the current chat turn, keyed by attachment index. Set
   * ONLY by the resident chat route for the duration of one request; absent on
   * SMS turns and on the confirm request, which is why a preview must pin the
   * storage paths it resolved rather than expect the stash to still exist.
   */
  chatPhotos?: ResidentChatPhotoRef[];
  /**
   * Service-role client. It bypasses RLS, so every query built from it MUST
   * scope by resident identity: `.or("resident_user_id.eq.<uid>,resident_email.eq.<email>")`
   * or `.eq("resident_email", email)` — matching the corresponding API routes.
   */
  db: ReturnType<typeof createSupabaseServiceRoleClient>;
};

export type MoveInDetailsLock = Pick<ResidentAgentContext, "moveInDetailsLocked" | "moveInDetailsLockFormId" | "moveInDetailsLockReadFailed">;

/**
 * The one place `moveInDetailsLocked` is derived, from the SAME `BlockingFormsPending` the resident
 * portal computes (`loadResidentPortalAccessState().blockingFormsPending`). Pure, so a context builder
 * that already holds the access state reuses its single forms read rather than querying
 * `resident_move_in_forms` a second time on the resident hot path (AGENTS.md § Performance & egress).
 * An absent value is a read that never produced an answer, so it locks like a failed one.
 */
export function moveInDetailsLockFromBlocking(blocking: BlockingFormsPending | null | undefined): MoveInDetailsLock {
  if (!blocking) return { moveInDetailsLocked: true, moveInDetailsLockFormId: null, moveInDetailsLockReadFailed: true };
  if (!blocking.moveInDetails) return { moveInDetailsLocked: false, moveInDetailsLockFormId: null, moveInDetailsLockReadFailed: false };
  return {
    moveInDetailsLocked: true,
    moveInDetailsLockFormId: blocking.readFailed ? null : (blocking.formIds?.moveInDetails ?? null),
    moveInDetailsLockReadFailed: blocking.readFailed === true,
  };
}

/**
 * The same derivation for a builder with NO access state to read it off (the SMS test harness), which is
 * the only caller that still owes this table a query. A read that fails or throws locks (fail closed)
 * and names no form.
 */
export async function loadMoveInDetailsLock(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  who: { email: string; userId?: string | null },
): Promise<MoveInDetailsLock> {
  try {
    const { blocking } = await loadResidentFormsFacts(db, who);
    return moveInDetailsLockFromBlocking(blocking);
  } catch {
    return { moveInDetailsLocked: true, moveInDetailsLockFormId: null, moveInDetailsLockReadFailed: true };
  }
}

/**
 * Returns the resident agent context for the current request, or null when the
 * caller is unauthenticated or is not a resident.
 */
export async function resolveResidentAgentContext(): Promise<ResidentAgentContext | null> {
  const { user, profile } = await getEffectiveSessionForPortal("resident");
  if (!user) return null;

  const db = createSupabaseServiceRoleClient();
  if (!(await isTestWorkspaceActorAllowed(user.id, db))) return null;
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
    channel: "portal",
    phase: access.leaseAccessUnlocked ? "approved" : "application",
    managerTier,
    ...moveInDetailsLockFromBlocking(access.blockingFormsPending),
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
