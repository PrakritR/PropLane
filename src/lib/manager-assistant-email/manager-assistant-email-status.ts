import type { ManagerMessagingEntitlement, ManagerMessagingPlanTier, ManagerMessagingWorkspaceRole } from "@/lib/sms/manager-messaging-number";

export type ManagerAssistantEmailStatus = {
  provisioningAvailable: boolean;
  sendingAvailable: boolean;
  planTier: ManagerMessagingPlanTier;
  entitlement: ManagerMessagingEntitlement;
  workspaceRole: ManagerMessagingWorkspaceRole;
  address: string | null;
  canRequest: boolean;
  canUse: boolean;
};

export const MANAGER_ASSISTANT_EMAIL_SETTINGS_HREF = "/portal/profile?tab=messaging";
