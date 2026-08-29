import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  managerCarrierRegistrationNeedsAttention,
  type ManagerMessagingNumberStatus,
  type ManagerMessagingRuntimeMode,
} from "@/lib/sms/manager-messaging-number";
import {
  getStoredManagerSmsEntitlement,
  reconcileManagerSmsEntitlement,
} from "@/lib/sms/manager-sms-entitlement.server";
import { provisionManagerNumber } from "@/lib/sms/manager-number-provisioning.server";
import {
  effectiveRegistrationState,
  isProvisioningEnabled,
  managerSmsNumberIsSendable,
  normalizeProvisionState,
  normalizeRegistrationState,
  normalizeSmsNumberAttachmentState,
  normalizeSmsRuntimeMode,
  smsRuntimeAllowsManager,
} from "@/lib/sms/number-registration-policy";

export const runtime = "nodejs";

const NUMBER_SELECT =
  "phone_number, provision_state, registration_state, registration_ref, attachment_state, number_registration_state, registration_submitted_at, last_provider_event_at, grace_started_at, grace_expires_at, quarantined_at, quarantine_reason, last_error";

async function isPureCoManager(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const [
    { data: owned, error: ownedError },
    { data: incoming, error: incomingError },
  ] = await Promise.all([
    db
      .from("manager_property_records")
      .select("id")
      .eq("manager_user_id", userId)
      .limit(1),
    db
      .from("account_link_invites")
      .select("id")
      .eq("invitee_user_id", userId)
      .eq("status", "accepted")
      .limit(1),
  ]);

  if ((owned ?? []).length > 0) return false;
  // Fail closed: when the route cannot prove workspace ownership, it must not
  // provision a number under a possible co-manager's personal account id.
  if (ownedError || incomingError) return true;
  // New managers with no links still own their empty workspace and may proceed.
  return (incoming ?? []).length > 0;
}

/**
 * Whether this manager has ANY stored entitlement snapshot. Distinguishes "we
 * have never checked this account" from "the check failed" - both of which
 * `getStoredManagerSmsEntitlement` collapses into `plan_unreadable`.
 * Fails closed (reports a row) so a read error never opens a billing re-read.
 */
async function hasStoredEntitlementRow(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("sms_manager_entitlements")
    .select("manager_user_id")
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (error) return true;
  return Boolean(data);
}

async function buildStatus(
  db: SupabaseClient,
  userId: string,
): Promise<ManagerMessagingNumberStatus> {
  const [
    runtimeResult,
    entitlement,
    numberResult,
    profileResult,
    pureCoManager,
  ] = await Promise.all([
    db
      .from("sms_runtime_config")
      .select("mode, pilot_manager_user_ids")
      .eq("singleton", true)
      .maybeSingle(),
    getStoredManagerSmsEntitlement(db, userId),
    db
      .from("manager_sms_numbers")
      .select(NUMBER_SELECT)
      .eq("manager_user_id", userId)
      .maybeSingle(),
    db
      .from("profiles")
      .select("phone, phone_verified_at, sms_forward_inbound")
      .eq("id", userId)
      .maybeSingle(),
    isPureCoManager(db, userId),
  ]);

  const configuredMode = runtimeResult.error
    ? "paused"
    : normalizeSmsRuntimeMode(runtimeResult.data?.mode);
  const provisioningEnvEnabled = isProvisioningEnabled();
  const sendEnvEnabled =
    process.env.SMS_RUNTIME_ENABLED?.trim() === "1" &&
    process.env.SMS_OUTBOX_SCHEDULER_READY?.trim() === "1";
  // Provisioning and sending have independent hard kills: pausing new number
  // purchases must not disable an already-active manager number.
  const mode: ManagerMessagingRuntimeMode = configuredMode;
  const allowlist = Array.isArray(runtimeResult.data?.pilot_manager_user_ids)
    ? runtimeResult.data.pilot_manager_user_ids.map(String)
    : [];
  const managerIsAllowlisted = allowlist.includes(userId);
  const modeAllowsManager = smsRuntimeAllowsManager(mode, managerIsAllowlisted);

  const rawNumber = numberResult.error ? null : numberResult.data;
  const normalizedNumber = rawNumber
    ? {
        provisionState: normalizeProvisionState(rawNumber.provision_state),
        registrationState: normalizeRegistrationState(
          rawNumber.registration_state,
        ),
        registrationRef: rawNumber.registration_ref ?? null,
        attachmentState: normalizeSmsNumberAttachmentState(
          rawNumber.attachment_state,
        ),
        numberRegistrationState: rawNumber.number_registration_state,
        phoneNumber:
          typeof rawNumber.phone_number === "string"
            ? rawNumber.phone_number
            : null,
        graceStartedAt: rawNumber.grace_started_at ?? null,
        graceExpiresAt: rawNumber.grace_expires_at ?? null,
        quarantinedAt: rawNumber.quarantined_at ?? null,
        quarantineReason: rawNumber.quarantine_reason ?? null,
      }
    : null;
  const number = normalizedNumber
    ? {
        state: normalizedNumber.provisionState,
        registrationState: effectiveRegistrationState(normalizedNumber),
        carrierRegistrationState: normalizedNumber.numberRegistrationState,
        attachmentState: normalizedNumber.attachmentState,
        phoneNumber: normalizedNumber.phoneNumber,
        lastError:
          typeof rawNumber?.last_error === "string"
            ? rawNumber.last_error
            : null,
        setupNeedsAttention:
          Boolean(normalizedNumber.quarantinedAt) ||
          managerCarrierRegistrationNeedsAttention({
            provisionState: normalizedNumber.provisionState,
            carrierRegistrationState:
              normalizedNumber.numberRegistrationState,
            registrationSubmittedAt: rawNumber?.registration_submitted_at,
            lastProviderEventAt: rawNumber?.last_provider_event_at,
          }),
      }
    : null;

  const requestableState =
    number === null ||
    number.state === "pending_registration" ||
    number.state === "failed";
  const entitlementCanBeReconciled =
    entitlement.eligible ||
    entitlement.reason === "plan_unreadable" ||
    entitlement.reason === "legacy_unknown";
  const strictNumberReady = managerSmsNumberIsSendable(normalizedNumber, {
    runtimeMode: mode,
    managerIsAllowlisted,
  });

  return {
    mode,
    workspaceRole: pureCoManager ? "co_manager" : "primary",
    provisioningAvailable: provisioningEnvEnabled && modeAllowsManager,
    entitlement,
    number,
    // A missing/stale entitlement row must not deadlock a genuinely paid
    // manager: POST performs the authoritative Stripe/Apple reconciliation.
    canRequest:
      entitlementCanBeReconciled &&
      provisioningEnvEnabled &&
      modeAllowsManager &&
      requestableState &&
      !pureCoManager,
    canSend:
      entitlement.eligible &&
      sendEnvEnabled &&
      modeAllowsManager &&
      strictNumberReady &&
      !pureCoManager,
    personalPhone: {
      phone:
        typeof profileResult.data?.phone === "string"
          ? profileResult.data.phone
          : null,
      verifiedAt:
        typeof profileResult.data?.phone_verified_at === "string"
          ? profileResult.data.phone_verified_at
          : null,
      forwardInbound:
        process.env.SMS_RUNTIME_ENABLED?.trim() !== "1" &&
        profileResult.data?.sms_forward_inbound !== false,
    },
  };
}

function publicStatus(
  status: ManagerMessagingNumberStatus,
): ManagerMessagingNumberStatus {
  return {
    mode: status.mode,
    workspaceRole: status.workspaceRole,
    provisioningAvailable: status.provisioningAvailable,
    entitlement: status.entitlement,
    number: status.number,
    canRequest: status.canRequest,
    canSend: status.canSend,
    personalPhone: status.personalPhone,
  };
}

/** Read-only manager messaging status. Never seeds a row or contacts a provider. */
export async function GET() {
  const actor = await requireManagerRouteUser();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const status = await buildStatus(actor.db, actor.userId);
  return NextResponse.json(publicStatus(status), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

/**
 * Explicitly request the authenticated primary manager's work number. The DB
 * runtime mode and `SMS_PROVISIONING_ENABLED=1` must both allow the request;
 * with either kill switch off, this route never reaches provider provisioning.
 */
export async function POST(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  if (await isPureCoManager(actor.db, actor.userId)) {
    return NextResponse.json(
      {
        error:
          "Messaging numbers must be set up by the primary property manager for this workspace.",
      },
      { status: 409 },
    );
  }

  const parsedBody = await req.json().catch(() => ({}) as unknown);
  if (
    !parsedBody ||
    typeof parsedBody !== "object" ||
    Array.isArray(parsedBody)
  ) {
    return NextResponse.json(
      { error: "Request body must be a JSON object." },
      { status: 400 },
    );
  }
  const body = parsedBody as { action?: unknown; areaCode?: unknown };
  const action = body.action === undefined ? "request_number" : body.action;
  if (action !== "request_number" && action !== "refresh_eligibility") {
    return NextResponse.json(
      { error: "Unknown messaging-number action." },
      { status: 400 },
    );
  }
  const areaCode =
    typeof body.areaCode === "string" ? body.areaCode.trim() : "";
  if (areaCode && !/^\d{3}$/.test(areaCode)) {
    return NextResponse.json(
      { error: "Area code must be 3 digits." },
      { status: 400 },
    );
  }

  if (action === "refresh_eligibility") {
    const current = await buildStatus(actor.db, actor.userId);
    // A manager with no number may still check ONCE, when their plan has never
    // been reconciled at all: a new account has no `sms_manager_entitlements`
    // row, which reads back as `plan_unreadable`, and this action is the only
    // thing that settles it.
    //
    // The gate keys on the ABSENCE OF THE ROW, not on the reason, because
    // `plan_unreadable` is sticky - every failing purchase read returns it - so
    // a reason-keyed gate would be opened by exactly the condition it can never
    // close, and each press would re-hit billing. Reconciling writes a row on
    // every resolved outcome (free included), so the first successful check
    // closes this permanently and status checks cannot become a billing ping.
    const neverReconciled =
      !current.entitlement.eligible &&
      !(await hasStoredEntitlementRow(actor.db, actor.userId));
    if (!current.number?.phoneNumber && !neverReconciled) {
      return NextResponse.json(
        {
          ...publicStatus(current),
          error:
            "Request a messaging number before refreshing its eligibility.",
        },
        { status: 409 },
      );
    }
    await reconcileManagerSmsEntitlement(actor.db, actor.userId);
    // This branch deliberately returns before every runtime/provisioning gate.
    // It may update the stored billing snapshot, but it can never buy a number.
    return NextResponse.json(
      publicStatus(await buildStatus(actor.db, actor.userId)),
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  // Reconcile at the explicit-request boundary, not on GET. Status checks stay
  // read-only and billing/provider work happens only after a manager asks.
  const entitlement = await reconcileManagerSmsEntitlement(
    actor.db,
    actor.userId,
  );
  if (!entitlement.eligible) {
    return NextResponse.json(
      {
        error:
          "A paid Pro or Business plan is required for a dedicated messaging number.",
      },
      { status: 403 },
    );
  }

  const { data: runtimeConfig, error: runtimeError } = await actor.db
    .from("sms_runtime_config")
    .select("mode, pilot_manager_user_ids")
    .eq("singleton", true)
    .maybeSingle();
  const mode = runtimeError
    ? "paused"
    : normalizeSmsRuntimeMode(runtimeConfig?.mode);
  if (!isProvisioningEnabled() || mode === "paused") {
    return NextResponse.json(
      {
        error:
          "Messaging number requests are paused right now. Your plan remains unchanged.",
      },
      { status: 503 },
    );
  }
  const allowlist = Array.isArray(runtimeConfig?.pilot_manager_user_ids)
    ? runtimeConfig.pilot_manager_user_ids.map(String)
    : [];
  if (
    mode === "allowlisted_self_service" &&
    !allowlist.includes(actor.userId)
  ) {
    return NextResponse.json(
      {
        error: "Messaging number setup is not available for this account yet.",
      },
      { status: 403 },
    );
  }

  const result = await provisionManagerNumber(
    actor.db,
    actor.userId,
    areaCode ? { areaCode } : undefined,
  );
  const next = publicStatus(await buildStatus(actor.db, actor.userId));
  if (!result.ok) {
    return NextResponse.json(
      {
        ...next,
        error: "We could not set up your messaging number. Try again later.",
      },
      { status: result.state === "pending_registration" ? 503 : 502 },
    );
  }

  if (!result.alreadyProvisioned) {
    track("messaging_number_requested", actor.userId, { state: result.state });
  }
  return NextResponse.json(next, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
