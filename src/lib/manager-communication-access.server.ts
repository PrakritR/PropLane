import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";

/**
 * The one server rule for "may this workspace's manager COMMUNICATE?" - send an inbox message,
 * text, email, place a call, send a payment reminder, or let the assistant message someone.
 *
 * A manager on a LIVE no-card signup trial (`billing: trial`, not lapsed - see
 * `isLiveSignupTrialPurchase`) has no Communication until the account pays (Stripe / Apple) or
 * holds a waiver / admin / portal grant. Everything else is unchanged: Free (including a LAPSED
 * trial) keeps the Communication it has today, and every paid or granted plan is allowed.
 *
 * Pass the workspace OWNER, never the acting teammate: a co-manager acting in a trial owner's
 * workspace is refused with the owner's plan, and one acting in a paid owner's workspace is
 * allowed whatever their own account is. The plan is read server-side from `manager_purchases`;
 * when it cannot be read the answer is a refusal (fail closed), never "probably paid".
 *
 * Only OUTBOUND is gated. Inbound storage (a resident, vendor or prospect writing to the
 * workspace) and transactional mail (sign-in, password reset, lease e-sign) never come through
 * here, so nothing a customer sends is lost while the owner is on a trial.
 */
export type ManagerCommunicationAccess =
  | { allowed: true }
  | {
      allowed: false;
      reason: "trial" | "plan_unreadable";
      /** HTTP status a route should answer with: 402 for the paywall, 503 for an unreadable plan. */
      status: 402 | 503;
      message: string;
    };

export const MANAGER_COMMUNICATION_TRIAL_MESSAGE = "Communication is available on a paid plan.";
export const MANAGER_COMMUNICATION_UNREADABLE_MESSAGE =
  "We could not verify your plan. Try again in a moment or contact support.";

export async function assertManagerCommunicationAllowed(ownerUserId: string): Promise<ManagerCommunicationAccess> {
  const owner = String(ownerUserId ?? "").trim();
  const unreadable: ManagerCommunicationAccess = {
    allowed: false,
    reason: "plan_unreadable",
    status: 503,
    message: MANAGER_COMMUNICATION_UNREADABLE_MESSAGE,
  };
  if (!owner) return unreadable;
  try {
    const plan = await getEffectiveManagerSkuTier(owner);
    if (!plan.ok) return unreadable;
    if (plan.liveSignupTrial === true) {
      return { allowed: false, reason: "trial", status: 402, message: MANAGER_COMMUNICATION_TRIAL_MESSAGE };
    }
    return { allowed: true };
  } catch {
    return unreadable;
  }
}

/**
 * The workspace owner a send from `workspaceId` belongs to: `portal_workspaces.owner_user_id`.
 * With no workspace named (a surface that is not partitioned) the actor is their own owner.
 * A workspace that cannot be read or has no owner resolves to `null` - callers refuse on null.
 */
export async function resolveCommunicationOwnerId(
  db: SupabaseClient,
  actorUserId: string,
  workspaceId?: string | null,
): Promise<string | null> {
  const workspace = String(workspaceId ?? "").trim();
  if (!workspace) return String(actorUserId ?? "").trim() || null;
  try {
    const { data, error } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspace).maybeSingle();
    if (error) return null;
    const owner = String((data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "").trim();
    return owner || null;
  } catch {
    return null;
  }
}

/** Assert for an actor sending from a workspace: resolve its owner, then check that owner's plan. */
export async function assertManagerCommunicationAllowedForWorkspace(
  db: Parameters<typeof resolveCommunicationOwnerId>[0],
  actorUserId: string,
  workspaceId?: string | null,
): Promise<ManagerCommunicationAccess> {
  const owner = await resolveCommunicationOwnerId(db, actorUserId, workspaceId);
  if (!owner) {
    return {
      allowed: false,
      reason: "plan_unreadable",
      status: 503,
      message: MANAGER_COMMUNICATION_UNREADABLE_MESSAGE,
    };
  }
  return assertManagerCommunicationAllowed(owner);
}
