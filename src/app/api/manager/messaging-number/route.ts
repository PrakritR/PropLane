import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { getManagerPortalNavSubscriptionTier } from "@/lib/manager-access-server";
import {
  managerCarrierRegistrationNeedsAttention,
  managerMessagingSenderPoolDiagnostic,
  type ManagerMessagingNumberStatus,
  type ManagerMessagingPlanTier,
  type ManagerMessagingRuntimeMode,
} from "@/lib/sms/manager-messaging-number";
import {
  getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement,
} from "@/lib/sms/manager-sms-entitlement.server";
import { isPureCoManagerWorkspace } from "@/lib/sms/manager-workspace-role.server";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
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
import {
  commsBillingBlockMessage,
  evaluateManagerCommsBillingGate,
} from "@/lib/comms-billing/eligibility.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";

export const runtime = "nodejs";

const NUMBER_SELECT =
  "phone_number, provision_state, registration_state, registration_ref, attachment_state, number_registration_state, registration_submitted_at, last_provider_event_at, grace_started_at, grace_expires_at, quarantined_at, quarantine_reason, last_error";

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
    planTierResult,
    numberResult,
    profileResult,
    pureCoManager,
    automationSettings,
  ] = await Promise.all([
    db
      .from("sms_runtime_config")
      .select("mode, pilot_manager_user_ids")
      .eq("singleton", true)
      .maybeSingle(),
    getEffectiveManagerSmsEntitlement(db, userId),
  // Nav tier inherits linked-owner paid plans for co-managers (matches portal locks).
    getManagerPortalNavSubscriptionTier(userId),
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
    isPureCoManagerWorkspace(db, userId),
    loadManagerAutomationSettings(db, userId).catch(() => null),
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

  // Unreadable plan → "unknown" (fail closed to no upsell, never the Free cap);
  // an explicit "free" tier → "free"; anything else (pro/business, or a null
  // tier backed by a live subscription) → "paid".
  const planTier: ManagerMessagingPlanTier =
    planTierResult === "free" ? "free" : planTierResult === null ? "unknown" : "paid";

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

  const paygBilling = isCommsPaygBillingEnabled()
    ? await evaluateManagerCommsBillingGate(db, userId)
    : null;
  const commsBillingAllowed = paygBilling ? paygBilling.allowed : entitlement.eligible;
  const canRequestBilling =
    paygBilling != null ? paygBilling.allowed : entitlementCanBeReconciled;

  return {
    mode,
    workspaceRole: pureCoManager ? "co_manager" : "primary",
    provisioningAvailable: provisioningEnvEnabled && modeAllowsManager,
    sendingAvailable: sendEnvEnabled && modeAllowsManager,
    planTier,
    entitlement,
    number,
    // A missing/stale entitlement row must not deadlock a genuinely paid
    // manager: POST performs the authoritative Stripe/Apple reconciliation.
    requestedAtSignup: automationSettings?.workNumberRequestedAtSignup === true,
    canRequest:
      canRequestBilling &&
      provisioningEnvEnabled &&
      modeAllowsManager &&
      requestableState,
    canSend:
      commsBillingAllowed &&
      sendEnvEnabled &&
      modeAllowsManager &&
      strictNumberReady,
    personalPhone: {
      phone:
        typeof profileResult.data?.phone === "string"
          ? profileResult.data.phone
          : null,
      verifiedAt:
        typeof profileResult.data?.phone_verified_at === "string"
          ? profileResult.data.phone_verified_at
          : null,
      // Mirrors of inbound texts go to the manager's own verified cell. The
      // number must be verified (an unverified `profiles.phone` is editable
      // free text) and the manager must not have opted out.
      forwardInbound:
        Boolean(profileResult.data?.phone_verified_at) &&
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
    sendingAvailable: status.sendingAvailable,
    planTier: status.planTier,
    entitlement: status.entitlement,
    number: status.number
      ? {
          ...status.number,
          lastError: managerMessagingSenderPoolDiagnostic(
            status.number.lastError,
          ),
        }
      : null,
    requestedAtSignup: status.requestedAtSignup,
    canRequest: status.canRequest,
    canSend: status.canSend,
    personalPhone: status.personalPhone,
  };
}

// Curated, non-sensitive provisioning failures the manager can act on. Anything
// not matched here (raw DB/provider text, internal sentinels) collapses to the
// generic message so an unexpected internal error is never surfaced. Each family
// tolerates the code/status identifiers being present, partial, or absent, since
// `twilioOperationError` emits only whichever exist.
const PUBLIC_PROVISIONING_ERROR_PATTERNS: RegExp[] = [
  /^Messaging Service attachment is not configured\. The purchased number (?:was released|release could not be confirmed; do not retry until PropLane reviews it)\.$/,
  /^Twilio work-number purchase failed(?: \((?:code [\w-]+(?:, HTTP \d{3})?|HTTP \d{3})\))?\. Provider ownership is unconfirmed; do not retry until PropLane reviews it\.$/,
  /^No SMS-capable numbers are available (?:in area code \d{3} right now|right now — try again shortly)\.$/,
  /^Provider setup is awaiting reconciliation\.$/,
  /^Provider cleanup requires review\.$/,
];

function publicProvisioningError(error: string): string {
  const value = error.trim();
  if (managerMessagingSenderPoolDiagnostic(value)) return value;
  if (PUBLIC_PROVISIONING_ERROR_PATTERNS.some((pattern) => pattern.test(value)))
    return value;
  return "We could not set up your messaging number. Try again later.";
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
  // Under pay-as-you-go a number is BOUGHT, not bundled: a card on file is what
  // qualifies a manager, on any plan including Free. The plan entitlement still
  // stands in when PAYG is off, so turning the flag off restores the old rule
  // rather than leaving the number ungated.
  if (isCommsPaygBillingEnabled()) {
    const gate = await evaluateManagerCommsBillingGate(actor.db, actor.userId);
    if (!gate.allowed) {
      return NextResponse.json(
        { error: commsBillingBlockMessage(gate.reason) },
        { status: 402 },
      );
    }
  } else if (!entitlement.eligible) {
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
  // Charge the one-time setup only once a number was actually bought. Billing
  // before provisioning would charge for a failed purchase; the idempotency key
  // carries the number, so a retry that returns the same one bills once.
  if (result.ok && isCommsPaygBillingEnabled() && result.number) {
    await recordManagerCommsUsage(actor.db, {
      managerUserId: actor.userId,
      meter: "work_number_setup",
      idempotencyKey: `work_number_setup:${actor.userId}:${result.number}`,
      metadata: { phoneNumber: result.number, areaCode: areaCode || null },
    });
  }
  const next = publicStatus(await buildStatus(actor.db, actor.userId));
  if (!result.ok) {
    return NextResponse.json(
      {
        ...next,
        error: publicProvisioningError(result.error),
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
