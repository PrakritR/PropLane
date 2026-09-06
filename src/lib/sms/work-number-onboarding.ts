import type { ManagerMessagingWorkspaceRole } from "@/lib/sms/manager-messaging-number";
import { trimmedText } from "@/lib/trimmed-text";

/**
 * Just enough of `/api/manager/messaging-number` to decide whether the signup
 * step should offer work-number setup.
 */
export type WorkNumberOnboardingStatus = {
  number?: { phoneNumber?: string | null } | null;
  canRequest?: boolean;
  provisioningAvailable?: boolean;
  workspaceRole?: ManagerMessagingWorkspaceRole | string | null;
};

/** The number already provisioned for this account, or "" when there is none. */
export function workNumberOnboardingPhone(status: WorkNumberOnboardingStatus | null): string {
  return trimmedText(status?.number?.phoneNumber);
}

/**
 * Whether the signup step should also show a PropLane work number card.
 *
 * The server decides eligibility; this only reads its answer. `canRequest` and
 * `provisioningAvailable` come from `/api/manager/messaging-number`, which
 * weighs the plan, the environment and the current number state.
 *
 * There used to be an extra `workspaceRole === "co_manager"` refusal here,
 * justified by "the provisioning route refuses them". It does not: `canRequest`
 * never consults the pure-co-manager flag, the POST never rejects on it, and
 * `reconcileManagerSmsEntitlement` goes out of its way to let a pure co-manager
 * INHERIT an inviting owner's plan so they can qualify. Settings offers them the
 * request for exactly that reason, so this gate was hiding at signup the one
 * thing the rest of the system says they may have — a co-manager who onboarded
 * simply never saw the offer (AXI-158).
 *
 * A status that could not be read is `null` and shows nothing: this is an
 * optional signup step, and a failed background read must not become an error
 * the manager did not ask for.
 */
export function shouldOfferWorkNumberSetup(status: WorkNumberOnboardingStatus | null): boolean {
  if (!status) return false;
  if (workNumberOnboardingPhone(status)) return true;
  return Boolean(status.canRequest || status.provisioningAvailable);
}
