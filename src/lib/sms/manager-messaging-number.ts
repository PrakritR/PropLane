export type ManagerMessagingRuntimeMode =
  "paused" | "allowlisted_self_service" | "automatic";

export type ManagerMessagingWorkspaceRole = "primary" | "co_manager";

export type ManagerMessagingEntitlement =
  | { eligible: true; tier: "pro" | "business"; source: "stripe" | "apple" }
  | {
      eligible: false;
      reason:
        | "free"
        | "trialing"
        | "past_due"
        | "canceled"
        | "legacy_unknown"
        | "plan_unreadable";
    };

export type ManagerMessagingNumber = {
  state:
    "pending_registration" | "provisioning" | "active" | "failed" | "released";
  registrationState: "pending" | "approved" | "rejected";
  carrierRegistrationState:
    | "not_submitted"
    | "pending"
    | "registered"
    | "failed"
    | "deregistering"
    | "deregistered";
  attachmentState: "not_attached" | "attaching" | "attached" | "failed";
  phoneNumber: string | null;
  lastError: string | null;
  setupNeedsAttention?: boolean;
};

/**
 * The account's authoritative plan class, resolved from `manager_purchases`
 * (never the reconcile-dependent `sms_manager_entitlements` row, which is absent
 * until a manager first requests a number). `"free"` is confirmed no-paid-plan;
 * `"paid"` is Pro/Business or a live subscription; `"unknown"` is an unreadable
 * plan row. UI shows the "upgrade to unlock SMS" upsell ONLY for `"free"` — a
 * paid manager who has never reconciled must not see a free-tier prompt.
 */
export type ManagerMessagingPlanTier = "free" | "paid" | "unknown";

export type ManagerMessagingNumberStatus = {
  mode: ManagerMessagingRuntimeMode;
  workspaceRole: ManagerMessagingWorkspaceRole;
  provisioningAvailable: boolean;
  /**
   * Whether THIS DEPLOYMENT can send at all, independent of the manager's
   * number or plan. A registered, active number still sends nothing when the
   * texting runtime is off, and reporting that as carrier "approval in
   * progress" points the manager at Twilio for a switch only an operator here
   * can flip.
   */
  sendingAvailable: boolean;
  planTier: ManagerMessagingPlanTier;
  entitlement: ManagerMessagingEntitlement;
  number: ManagerMessagingNumber | null;
  canRequest: boolean;
  canSend: boolean;
  personalPhone: {
    phone: string | null;
    verifiedAt: string | null;
    forwardInbound: boolean;
  };
};

export const MANAGER_CARRIER_REGISTRATION_STALE_MS = 30 * 60_000;

/**
 * Carrier registration progress has its own clock. Routine provider-pool
 * reconciliation updates unrelated timestamps, so `updated_at` must never be
 * used to decide whether a pending registration is stuck.
 */
export function managerCarrierRegistrationNeedsAttention(input: {
  provisionState: ManagerMessagingNumber["state"] | string | null | undefined;
  carrierRegistrationState:
    | ManagerMessagingNumber["carrierRegistrationState"]
    | string
    | null
    | undefined;
  registrationSubmittedAt: string | null | undefined;
  lastProviderEventAt: string | null | undefined;
  nowMs?: number;
}): boolean {
  if (
    input.provisionState !== "provisioning" ||
    input.carrierRegistrationState !== "pending"
  ) {
    return false;
  }

  const progressTimes = [
    input.registrationSubmittedAt,
    input.lastProviderEventAt,
  ]
    .map((value) => Date.parse(String(value ?? "")))
    .filter(Number.isFinite);
  // A pending carrier registration without submission/event evidence is an
  // invalid state that needs operator attention rather than an endless wait.
  if (progressTimes.length === 0) return true;

  const latestProgressAt = Math.max(...progressTimes);
  return (
    (input.nowMs ?? Date.now()) - latestProgressAt >
    MANAGER_CARRIER_REGISTRATION_STALE_MS
  );
}

export const MANAGER_MESSAGING_SETTINGS_HREF = "/portal/profile?tab=messaging";

export function formatManagerMessagingPhone(
  phone: string | null | undefined,
): string {
  if (!phone?.trim()) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}
