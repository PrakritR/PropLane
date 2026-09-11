import type { ManagerMessagingEntitlement, ManagerMessagingPlanTier, ManagerMessagingWorkspaceRole } from "@/lib/sms/manager-messaging-number";

/**
 * What the Work email card renders, in the same vocabulary the work number
 * card uses. Derived server-side so "is this thing actually working?" has one
 * answer rather than one per surface.
 *
 * - `ready`              — an address exists and this deployment can send mail.
 * - `assigned_send_off`  — an address exists but mail is switched off on this
 *                          deployment, so it can neither reply nor be
 *                          advertised. A PropLane setting, nothing the manager
 *                          can act on.
 * - `assigned_plan_hold` — an address exists and mail works, but the plan or
 *                          billing no longer qualifies. Kept distinct from
 *                          `assigned_send_off` because the two need opposite
 *                          advice: one is ours to fix, the other is theirs.
 * - `requestable`        — no address yet, and the manager may ask for one.
 * - `unavailable`        — no address, and the plan or environment says no.
 * - `storage_unavailable` — the table is missing on this environment.
 */
export type ManagerAssistantEmailState =
  | "ready"
  | "assigned_send_off"
  | "assigned_plan_hold"
  | "requestable"
  | "unavailable"
  | "storage_unavailable";

export type ManagerAssistantEmailStatus = {
  provisioningAvailable: boolean;
  sendingAvailable: boolean;
  storageReady: boolean;
  planTier: ManagerMessagingPlanTier;
  entitlement: ManagerMessagingEntitlement;
  workspaceRole: ManagerMessagingWorkspaceRole;
  address: string | null;
  state: ManagerAssistantEmailState;
  canRequest: boolean;
  /**
   * The address exists AND can actually carry a message. Everything that shows
   * the address to somebody else — the resident card, a listing, the welcome
   * email — must gate on this, exactly as the work number gates on `canSend`.
   */
  canUse: boolean;
  /**
   * They ticked "set up a PropLane work email" while creating the account.
   * Carried on the status the panel already loads rather than a second round
   * trip, so there is one read and one source for what Settings renders.
   */
  requestedAtSignup: boolean;
};

export const MANAGER_ASSISTANT_EMAIL_SETTINGS_HREF = "/portal/profile?tab=messaging";

/**
 * A response that is actually a work-email status.
 *
 * The onboarding screens read this endpoint alongside several others through a
 * shared fetch; a route that answers 200 with a different shape (a proxy, a
 * stub, a deploy mid-rollout) used to reach the upsell copy as
 * `entitlement.eligible` and throw the WHOLE setup screen away — every card,
 * including the Google ones that had nothing to do with it. Mirrors
 * `isMessagingNumberStatus` on the work-number side.
 */
export function isManagerAssistantEmailStatus(
  value: unknown,
): value is ManagerAssistantEmailStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ManagerAssistantEmailStatus>;
  return (
    typeof candidate.canRequest === "boolean" &&
    typeof candidate.canUse === "boolean" &&
    Boolean(candidate.entitlement) &&
    typeof candidate.entitlement === "object" &&
    typeof candidate.planTier === "string"
  );
}
