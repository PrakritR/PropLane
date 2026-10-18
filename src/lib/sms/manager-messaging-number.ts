/** Type-only import: never pulls the `server-only` module into a client bundle. */
import type { WorkspaceNumberEntry } from "@/lib/sms/work-numbers.server";

export type ManagerMessagingRuntimeMode =
  "paused" | "allowlisted_self_service" | "automatic";

export type ManagerMessagingWorkspaceRole = "primary" | "co_manager";

/**
 * Why the WORKSPACE's line cannot send, when `lineReady` is false. Resolved
 * where the facts are (the status route), because a teammate has no `number`
 * row of their own to read one from - and without it every blocker collapsed
 * into "Finishing setup", which told a teammate looking at a live, registered,
 * carrier-approved line to go and finish setup that is already done.
 *
 * - `deployment` - this deployment's texting switch or runtime mode, which
 *   nobody in the product can flip.
 * - `billing` - the workspace wallet that would pay (paused, out of credit,
 *   unreadable plan).
 * - `paused` - a line that IS provisioned, registered and carrier-approved,
 *   held on the provider side: quarantined, inside or past a reconciliation
 *   grace window, or attached to the wrong Messaging Service. Nothing is
 *   unfinished, so it must not borrow the setup sentence.
 * - `setup` - the line genuinely is not provisioned/registered/attached yet,
 *   or the workspace has none. The ONLY state that says "Finishing setup".
 * - `unavailable` - the control plane could not be read, so we fail closed
 *   without claiming a reason.
 */
export type ManagerMessagingLineBlock =
  | "deployment"
  | "billing"
  | "paused"
  | "setup"
  | "unavailable";

export type ManagerMessagingEntitlement =
  | { eligible: true; tier: "free" | "pro" | "business"; source: "stripe" | "apple" | "none" }
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
   * can flip. In a workspace the viewer does not own this reads the OWNER's
   * runtime access — the line is theirs, so a teammate's own (absent) pilot
   * seat never reports the workspace's live number as unsendable.
   */
  sendingAvailable: boolean;
  planTier: ManagerMessagingPlanTier;
  entitlement: ManagerMessagingEntitlement;
  number: ManagerMessagingNumber | null;
  /** The workspace this status is about — the switcher's active workspace. */
  workspace?: { id: string; name: string; owned: boolean; isDefault: boolean } | null;
  /** Every workspace the viewer can see with its line, for Settings. */
  workspaces?: Array<{
    workspaceId: string;
    workspaceName: string;
    owned: boolean;
    isDefault: boolean;
    ownerName: string | null;
    phoneNumber: string | null;
    provisionState: string | null;
    /**
     * Every number this workspace holds (home plus shared-in), up to 2,
     * primary first. Present only for a workspace the viewer OWNS — a
     * shared workspace still reads its single line from `workspaceNumber`.
     */
    numbers?: WorkspaceNumberEntry[];
  }>;
  /**
   * The line of a SHARED workspace. A work number belongs to the workspace,
   * so inside a workspace someone else owns the viewer reads the owner's
   * number here and never requests one of their own. `phoneNumber` is null
   * while the owner has not set one up; `ownerName` tells the viewer whose
   * job that is. Absent in an owned workspace (its own `number` is the line).
   */
  workspaceNumber?: {
    phoneNumber: string | null;
    ownerUserId: string;
    ownerName: string | null;
  } | null;
  canRequest: boolean;
  /**
   * They ticked "set up a PropLane number" while creating the account. Carried
   * on the status the panel already loads rather than a second round trip, so
   * there is one read and one source for what Settings renders.
   */
  requestedAtSignup: boolean;
  /**
   * Whether the WORKSPACE's line itself can send right now: the owner's number
   * and allowlist seat, the workspace wallet, and this deployment's send
   * switch. Deliberately independent of who is looking - a teammate with
   * read-only Communication still reads a live line as live, so the work-number
   * card never reports a sendable number as "Finishing setup". Anything that
   * describes the LINE reads this; only the viewer's own send affordance reads
   * `canSend`.
   */
  lineReady: boolean;
  /**
   * Why `lineReady` is false, as one non-sensitive word. Absent/null when the
   * line is ready. Every reader that WORDS the line's state reads this rather
   * than guessing from `lineReady` alone.
   */
  lineBlocked?: ManagerMessagingLineBlock | null;
  /**
   * Whether THIS VIEWER may text from that line: `lineReady` plus, for a
   * teammate, their own Communication (`inbox`) grant at edit level - the gate
   * `manager-sms-send.server.ts` applies, so the Text channel is never offered
   * for a send that would come back 403.
   */
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

/**
 * The one provider diagnostic safe to surface verbatim: the structured
 * sender-pool attachment failure — operation name plus optional Twilio code
 * and/or HTTP status (never raw provider free-text), with its cleanup outcome.
 * `twilioOperationError` emits whichever identifiers exist, so code-only,
 * status-only, and neither must all match. Any other stored value (raw DB or
 * provider text) is scrubbed to null.
 */
const MANAGER_MESSAGING_SENDER_POOL_DIAGNOSTIC =
  /^Twilio Messaging Service sender-pool attachment failed(?: \((?:code [\w-]+(?:, HTTP \d{3})?|HTTP \d{3})\))?\.(?: The purchased number (?:was released|release could not be confirmed; do not retry until PropLane reviews it)\.)?$/;

export function managerMessagingSenderPoolDiagnostic(
  error: unknown,
): string | null {
  const value = typeof error === "string" ? error.trim() : "";
  return MANAGER_MESSAGING_SENDER_POOL_DIAGNOSTIC.test(value) ? value : null;
}

export const MANAGER_MESSAGING_SETTINGS_HREF = "/portal/profile?tab=messaging";

export function formatManagerMessagingPhone(
  phone: unknown,
): string {
  if (typeof phone !== "string" || !phone.trim()) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

/**
 * A line that EXISTS but is still waiting on carrier registration - the one
 * state where "SMS is waiting on carrier approval" is a true reason and there
 * is nothing left for the manager to finish. Every other reason a line cannot
 * send (the workspace wallet, the deployment's send switch, a quarantine) must
 * not borrow that sentence, and a teammate reading a workspace line they are
 * simply not allowed to use must not borrow it either: they have no `number`
 * row, so this is false for them.
 */
export function workNumberAwaitingCarrier(
  status: { number?: ManagerMessagingNumber | null } | null | undefined,
): boolean {
  const number = status?.number;
  if (!number || !number.phoneNumber) return false;
  if (number.state !== "active" && number.state !== "provisioning") return false;
  return number.registrationState !== "approved" || number.carrierRegistrationState !== "registered";
}

/** Just the fields of the status that say which line a workspace texts from. */
export type WorkspaceWorkNumberSource = {
  workspaceRole?: ManagerMessagingWorkspaceRole | string | null;
  number?: { phoneNumber?: string | null } | null;
  workspaceNumber?: { phoneNumber?: string | null } | null;
};

/**
 * The one answer to "does this workspace have a work number": a teammate
 * (`co_manager`) reads the owner's line from `workspaceNumber`, an owner reads
 * their own `number`. Trimmed, or null when there is none - a teammate's own
 * legacy row is never the workspace's number.
 */
export function workspaceWorkNumber(
  status: WorkspaceWorkNumberSource | null | undefined,
): string | null {
  if (!status) return null;
  const raw =
    status.workspaceRole === "co_manager"
      ? status.workspaceNumber?.phoneNumber
      : status.number?.phoneNumber;
  // A number stored as a JSON number (old rows) is still the workspace's line.
  const value =
    typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  return value || null;
}
