import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagerMessagingLineBlock } from "@/lib/sms/manager-messaging-number";
import { resolveOwnerSendNumberRow } from "@/lib/sms/manager-workspace-role.server";
import { WORKSPACE_NO_WORK_NUMBER_CODE } from "@/lib/sms/workspace-no-work-number";
import {
  evaluateManagerSmsNumberSendability,
  normalizeSmsRuntimeMode,
  smsRuntimeAllowsManager,
} from "@/lib/sms/number-registration-policy";
import { evaluateManagerCommsBillingGate } from "@/lib/comms-billing/eligibility.server";
import {
  readSharedLineConfig,
  resolveSendWorkspaceId,
  sharedLineActiveFor,
} from "@/lib/one-number/shared-line-number.server";

export type SendNumberRow = {
  manager_user_id: string;
  workspace_id?: string | null;
  phone_number: string | null;
  phone_number_sid: string | null;
  messaging_service_sid: string | null;
  campaign_sid: string | null;
  provision_state: string;
  registration_state: string;
  registration_ref: string | null;
  attachment_state: string | null;
  number_registration_state: string | null;
  grace_started_at: string | null;
  grace_expires_at: string | null;
  quarantined_at: string | null;
  quarantine_reason: string | null;
};

type RuntimeRow = {
  mode: string;
  pilot_manager_user_ids: string[] | null;
};

/** An `sms_runtime_config` read a caller already performed, passed in unchanged. */
export type RuntimeConfigResult = {
  data: { mode?: unknown; pilot_manager_user_ids?: unknown } | null;
  error: unknown;
};

export const SEND_NUMBER_COLUMNS =
  "id, manager_user_id, workspace_id, phone_number, phone_number_sid, messaging_service_sid, campaign_sid, provision_state, registration_state, registration_ref, attachment_state, number_registration_state, grace_started_at, grace_expires_at, quarantined_at, quarantine_reason";

export type WorkspaceSendReadiness =
  | {
      canSend: true;
      numberRow: SendNumberRow;
      /** The workspace that holds the sending line - its wallet pays. */
      workspaceId: string | null;
      /** The service the consent ledger is scoped to. */
      messagingServiceSid: string;
      /**
       * Set only while the workspace sends from the ONE shared number (line_mode
       * `shared`). `numberRow` is then a description of that line, not a
       * `manager_sms_numbers` row, and `providerMessagingServiceSid` is the
       * service the provider call goes out through.
       */
      viaSharedLine?: true;
      providerMessagingServiceSid?: string;
    }
  | { canSend: false; reason: string };

/**
 * The ONE answer to "can this workspace's line send right now": the owner's
 * line row for the workspace (or the message's house / selected line), its
 * registration + runtime sendability against the OWNER's allowlist, the
 * provider identity, and the workspace wallet's billing gate.
 *
 * Read-only: it never reserves credit. The dispatcher calls it at the send
 * boundary; the messaging-number status route calls it so a teammate's
 * "can send" is exactly what a real send would decide.
 */
export async function evaluateWorkspaceSendReadiness(input: {
  db: SupabaseClient;
  ownerUserId: string;
  /** Target the workspace's own line (status checks). Wins over a house. */
  workspaceId?: string | null;
  propertyId?: string | null;
  workLineId?: string | null;
  /** Cents the wallet must still cover; 0 once credit is already reserved. */
  requiredCents: number;
  /** An `sms_runtime_config` row the caller already read, to save a round trip. */
  runtime?: RuntimeConfigResult | null;
  /**
   * The workspace stamped on a queued message. Read ONLY by the shared-line
   * branch (line_mode `shared`); under `per_workspace` it changes nothing.
   */
  sharedLineWorkspaceId?: string | null;
  now?: Date;
}): Promise<WorkspaceSendReadiness> {
  const { db, requiredCents } = input;
  const ownerId = input.ownerUserId.trim();
  const now = input.now ?? new Date();

  // One number for everyone: when the line is `shared` and this workspace is in
  // the pilot, the text leaves from the shared number instead of a work number.
  // Any trouble reading the line config reads as `per_workspace`, so this block
  // is inert until the rollout switch is deliberately flipped.
  const sharedConfig = await readSharedLineConfig(db);
  if (sharedConfig.mode === "shared") {
    const sharedWorkspaceId = await resolveSendWorkspaceId(db, ownerId, {
      workspaceId: input.sharedLineWorkspaceId ?? input.workspaceId ?? null,
      propertyId: input.propertyId ?? null,
    });
    if (sharedLineActiveFor(sharedConfig, sharedWorkspaceId)) {
      return evaluateSharedLineReadiness({
        db,
        ownerId,
        workspaceId: sharedWorkspaceId as string,
        sharedNumber: sharedConfig.sharedNumber as string,
        providerServiceSid: sharedConfig.messagingServiceSid,
        requiredCents,
        runtime: input.runtime ?? null,
      });
    }
  }

  const runtimeRead: Promise<RuntimeConfigResult> = input.runtime
    ? Promise.resolve(input.runtime)
    : (db
        .from("sms_runtime_config")
        .select("mode, pilot_manager_user_ids")
        .eq("singleton", true)
        .maybeSingle() as unknown as Promise<RuntimeConfigResult>);

  const [{ data: runtime, error: runtimeError }, { data: number, error: numberError }] = await Promise.all([
    runtimeRead,
    // One line per WORKSPACE: the message about a house goes out from the
    // line of the workspace that holds it; a house-less one from the owner's
    // default workspace's line.
    resolveOwnerSendNumberRow<SendNumberRow>(db, ownerId, SEND_NUMBER_COLUMNS, {
      propertyId: input.propertyId ?? null,
      workLineId: input.workLineId ?? null,
      workspaceId: input.workspaceId ?? null,
    }),
  ]);
  // A workspace with no work number of its own is a plain refusal ("This
  // workspace has no work number."), not an unreadable control plane: it is
  // never retried and never borrows another workspace's line.
  if (!runtimeError && runtime && !number && (numberError as { code?: string } | null)?.code === WORKSPACE_NO_WORK_NUMBER_CODE) {
    return { canSend: false, reason: WORKSPACE_NO_WORK_NUMBER_CODE };
  }
  if (runtimeError || numberError || !runtime || !number) {
    return { canSend: false, reason: "control_plane_unreadable" };
  }

  const runtimeRow = runtime as RuntimeRow;
  const numberRow = number as SendNumberRow;
  const allowlisted = (runtimeRow.pilot_manager_user_ids ?? []).includes(ownerId);
  const decision = evaluateManagerSmsNumberSendability(
    {
      provisionState: numberRow.provision_state as never,
      phoneNumber: numberRow.phone_number,
      registrationState: numberRow.registration_state as never,
      registrationRef: numberRow.registration_ref,
      attachmentState: numberRow.attachment_state,
      numberRegistrationState: numberRow.number_registration_state,
      graceStartedAt: numberRow.grace_started_at,
      graceExpiresAt: numberRow.grace_expires_at,
      quarantinedAt: numberRow.quarantined_at,
      quarantineReason: numberRow.quarantine_reason,
    },
    { runtimeMode: runtimeRow.mode, managerIsAllowlisted: allowlisted, now },
  );
  if (!decision.sendable) return { canSend: false, reason: decision.reason ?? "number_not_sendable" };

  const expectedServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const expectedCampaignSid = process.env.TWILIO_CAMPAIGN_SID?.trim();
  if (
    !expectedServiceSid ||
    !expectedCampaignSid ||
    numberRow.messaging_service_sid !== expectedServiceSid ||
    numberRow.campaign_sid !== expectedCampaignSid ||
    !numberRow.phone_number_sid
  ) {
    return { canSend: false, reason: "provider_identity_mismatch" };
  }

  // Credit is per workspace: the message spends from the wallet of the
  // workspace that holds the line it leaves on, not an account-wide balance.
  const sendWorkspaceId = String(numberRow.workspace_id ?? "").trim() || null;
  const billing = await evaluateManagerCommsBillingGate(db, ownerId, requiredCents, sendWorkspaceId);
  if (!billing.allowed) return { canSend: false, reason: `comms_billing_${billing.reason}` };

  return { canSend: true, numberRow, workspaceId: sendWorkspaceId, messagingServiceSid: expectedServiceSid };
}

/**
 * Readiness for a send on the shared line: the runtime kill switch and rollout
 * allowlist still apply, the consent ledger stays scoped to the deployment's
 * messaging service, and the workspace's own wallet still pays. There is no
 * per-workspace number row to check; the shared number is attached and
 * registered once, on the platform.
 */
async function evaluateSharedLineReadiness(input: {
  db: SupabaseClient;
  ownerId: string;
  workspaceId: string;
  sharedNumber: string;
  providerServiceSid: string | null;
  requiredCents: number;
  runtime: RuntimeConfigResult | null;
}): Promise<WorkspaceSendReadiness> {
  const { db, ownerId, workspaceId, sharedNumber } = input;
  const { data: runtime, error: runtimeError } = input.runtime
    ? input.runtime
    : ((await db
        .from("sms_runtime_config")
        .select("mode, pilot_manager_user_ids")
        .eq("singleton", true)
        .maybeSingle()) as unknown as RuntimeConfigResult);
  if (runtimeError || !runtime) return { canSend: false, reason: "control_plane_unreadable" };
  const mode = normalizeSmsRuntimeMode(String((runtime as RuntimeRow).mode ?? ""));
  if (mode === "paused") return { canSend: false, reason: "runtime_paused" };
  const allowlisted = ((runtime as RuntimeRow).pilot_manager_user_ids ?? []).includes(ownerId);
  if (!smsRuntimeAllowsManager(mode, allowlisted)) return { canSend: false, reason: "manager_not_allowlisted" };

  const consentServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const providerServiceSid = input.providerServiceSid || consentServiceSid;
  if (!consentServiceSid || !providerServiceSid) return { canSend: false, reason: "provider_identity_mismatch" };

  const billing = await evaluateManagerCommsBillingGate(db, ownerId, input.requiredCents, workspaceId);
  if (!billing.allowed) return { canSend: false, reason: `comms_billing_${billing.reason}` };

  const numberRow: SendNumberRow = {
    manager_user_id: ownerId,
    workspace_id: workspaceId,
    phone_number: sharedNumber,
    phone_number_sid: null,
    messaging_service_sid: consentServiceSid,
    campaign_sid: process.env.TWILIO_CAMPAIGN_SID?.trim() || null,
    provision_state: "active",
    registration_state: "approved",
    registration_ref: null,
    attachment_state: "attached",
    number_registration_state: "registered",
    grace_started_at: null,
    grace_expires_at: null,
    quarantined_at: null,
    quarantine_reason: null,
  };
  return {
    canSend: true,
    numberRow,
    workspaceId,
    messagingServiceSid: consentServiceSid,
    viaSharedLine: true,
    providerMessagingServiceSid: providerServiceSid,
  };
}

/**
 * A line that is fully provisioned, registered and carrier-approved but held
 * on the provider side. Nothing about it is unfinished, so it never borrows
 * the setup sentence.
 */
const PAUSED_LINE_REASONS = new Set([
  "number_quarantined",
  "number_in_grace",
  "number_grace_expired",
  "number_grace_invalid",
  "provider_identity_mismatch",
]);

/**
 * The refusal above, as the one word a UI may say about the line. Only a line
 * that genuinely is not provisioned/registered yet maps to `setup`, so
 * "Finishing setup" is never printed over a live, approved number that is held
 * up by this deployment's switch, by the workspace's wallet, or by a provider
 * quarantine or grace window.
 *
 * Both branches of the messaging-number status route word a blocked line
 * through this one map, over the reasons in the order
 * `evaluateWorkspaceSendReadiness` refuses in, so an owner and a teammate
 * looking at the same line read the same sentence.
 */
export function lineBlockForSendReadinessReason(
  reason: string | null | undefined,
): ManagerMessagingLineBlock {
  const value = String(reason ?? "").trim();
  if (value === "runtime_paused" || value === "manager_not_allowlisted") return "deployment";
  if (value.startsWith("comms_billing_")) return "billing";
  if (PAUSED_LINE_REASONS.has(value)) return "paused";
  if (value === "control_plane_unreadable" || value === "") return "unavailable";
  return "setup";
}
