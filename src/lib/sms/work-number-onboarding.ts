import type { ManagerMessagingWorkspaceRole } from "@/lib/sms/manager-messaging-number";

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
  return status?.number?.phoneNumber?.trim() || "";
}

/**
 * Whether "Connect Google services" should also show a PropLane work number card.
 *
 * A PURE CO-MANAGER never gets one — they text the owner's number by design
 * (`isPureCoManager` in the provisioning route refuses them), so offering the
 * card there advertises a dead end. Everyone else sees it either as a status
 * line for a number they already hold, or as a route into Settings where the
 * real provisioning flow lives (area code, plan gate, retry diagnostics).
 *
 * A status that could not be read is `null` and shows nothing: this is an
 * optional signup step, and a failed background read must not become an error
 * the manager did not ask for.
 */
export function shouldOfferWorkNumberSetup(status: WorkNumberOnboardingStatus | null): boolean {
  if (!status) return false;
  if (status.workspaceRole === "co_manager") return false;
  if (workNumberOnboardingPhone(status)) return true;
  return Boolean(status.canRequest || status.provisioningAvailable);
}
