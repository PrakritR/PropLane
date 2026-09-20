import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { rateLimit } from "@/lib/rate-limit";
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
import { resolveWorkspaceWorkNumbers } from "@/lib/sms/manager-workspace-role.server";
import { resolveActiveWorkspace, resolveActiveWorkspaceFromRequest, type ActiveWorkspace } from "@/lib/workspaces/active.server";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import {
  assignNumberToWorkspace,
  listWorkspaceNumbers,
  provisionNumberForWorkspace,
  unassignNumber,
} from "@/lib/sms/work-numbers.server";
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
  evaluateManagerCommsBillingGate,
} from "@/lib/comms-billing/eligibility.server";

export const runtime = "nodejs";

const NUMBER_SELECT =
  "phone_number, provision_state, registration_state, registration_ref, attachment_state, number_registration_state, registration_submitted_at, last_provider_event_at, grace_started_at, grace_expires_at, quarantined_at, quarantine_reason, last_error";

/** `?workspaceId=` override for GET/POST, same "selection never widens access" contract as the cookie. */
function workspaceIdFromQuery(req: Request): string | undefined {
  try {
    const raw = new URL(req.url).searchParams.get("workspaceId");
    return raw?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function resolveRequestedWorkspace(
  db: SupabaseClient,
  userId: string,
  req: Request,
): Promise<ActiveWorkspace> {
  const queryId = workspaceIdFromQuery(req);
  return queryId
    ? resolveActiveWorkspace(db, userId, queryId)
    : resolveActiveWorkspaceFromRequest(db, userId);
}

async function buildStatus(
  db: SupabaseClient,
  userId: string,
  workspace: ActiveWorkspace,
): Promise<ManagerMessagingNumberStatus> {
  // Everything below is about the ACTIVE workspace: an owned workspace's own
  // row (none = none, never a neighbour's), a shared workspace's owner line.
  // The switcher decides; co-manager links do not.
  const [
    runtimeResult,
    entitlement,
    planTierResult,
    numberResult,
    profileResult,
    automationSettings,
    all,
  ] = await Promise.all([
    db
      .from("sms_runtime_config")
      .select("mode, pilot_manager_user_ids")
      .eq("singleton", true)
      .maybeSingle(),
    getEffectiveManagerSmsEntitlement(db, userId),
  // Nav tier inherits linked-owner paid plans for co-managers (matches portal locks).
    getManagerPortalNavSubscriptionTier(userId),
    workspace.owned
      ? db
          .from("manager_sms_numbers")
          .select(NUMBER_SELECT)
          .eq("workspace_id", workspace.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db
      .from("profiles")
      .select("phone, phone_verified_at, sms_forward_inbound")
      .eq("id", userId)
      .maybeSingle(),
    loadManagerAutomationSettings(db, userId).catch(() => null),
    resolveWorkspaceWorkNumbers(db, userId).catch(() => null),
  ]);
  // Full per-workspace number lists (up to 2, sharing included) for the
  // grouped Settings → Communication → Work numbers view. Only fetched for
  // workspaces the viewer OWNS — a shared workspace's single line still
  // comes from `workspaceNumber` below.
  const heldByWorkspace = new Map(
    await Promise.all(
      (all?.numbers ?? [])
        .filter((n) => n.owned)
        .map(async (n) => [n.workspaceId, await listWorkspaceNumbers(db, n.workspaceId).catch(() => [])] as const),
    ),
  );

  const pureCoManager = !workspace.owned;

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

  const billing = await evaluateManagerCommsBillingGate(db, userId, 3);
  const commsBillingAllowed = billing.allowed;
  const canRequestBilling = entitlementCanBeReconciled;

  // One work number per workspace: a co-manager reads the owner's line and
  // never gets a Request button. Their own legacy row (bought before numbers
  // were workspace-owned) still shows under `number` so Settings can say it is
  // being retired, but it is never the number the UI leads with.
  let workspaceNumber: ManagerMessagingNumberStatus["workspaceNumber"] = null;
  if (pureCoManager) {
    const shared = all?.numbers.find((n) => n.workspaceId === workspace.id);
    if (shared) {
      workspaceNumber = {
        phoneNumber:
          normalizeProvisionState(shared.provisionState) === "active" ? shared.phoneNumber : null,
        ownerUserId: shared.ownerUserId,
        ownerName: shared.ownerName,
      };
    }
  }

  return {
    mode,
    workspaceRole: pureCoManager ? "co_manager" : "primary",
    workspaceNumber,
    workspace: { id: workspace.id, name: workspace.name, owned: workspace.owned, isDefault: workspace.isDefault },
    workspaces: (all?.numbers ?? []).map((n) => ({
      workspaceId: n.workspaceId,
      workspaceName: n.workspaceName,
      owned: n.owned,
      isDefault: n.isDefault,
      ownerName: n.ownerName,
      phoneNumber: normalizeProvisionState(n.provisionState) === "active" ? n.phoneNumber : null,
      provisionState: n.provisionState,
      numbers: n.owned ? heldByWorkspace.get(n.workspaceId) ?? [] : undefined,
    })),
    provisioningAvailable: provisioningEnvEnabled && modeAllowsManager,
    sendingAvailable: sendEnvEnabled && modeAllowsManager,
    planTier,
    entitlement,
    number,
    // A missing/stale entitlement row must not deadlock a genuinely paid
    // manager: POST performs the authoritative Stripe/Apple reconciliation.
    requestedAtSignup: automationSettings?.workNumberRequestedAtSignup === true,
    canRequest:
      !pureCoManager &&
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
    workspaceNumber: status.workspaceNumber ?? null,
    workspace: status.workspace ?? null,
    workspaces: status.workspaces ?? [],
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
  /^A workspace can hold at most 2 work numbers\.$/,
  /^This workspace already has its own number\. Share a number in from another workspace instead of buying a second one\.$/,
  /^You're at your included work numbers\. Add an extra work number in Billing & plan to buy another\.$/,
  /^You cannot request a number for that workspace\.$/,
];

function publicProvisioningError(error: string): string {
  const value = error.trim();
  if (managerMessagingSenderPoolDiagnostic(value)) return value;
  if (PUBLIC_PROVISIONING_ERROR_PATTERNS.some((pattern) => pattern.test(value)))
    return value;
  return "We could not set up your messaging number. Try again later.";
}

/** Read-only manager messaging status. Never seeds a row or contacts a provider. */
export async function GET(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let workspace: ActiveWorkspace;
  try {
    workspace = await resolveRequestedWorkspace(actor.db, actor.userId, req);
  } catch {
    return NextResponse.json({ error: "Workspace unavailable. Try again." }, { status: 503 });
  }
  const status = await buildStatus(actor.db, actor.userId, workspace);
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
  let workspace: ActiveWorkspace;
  try {
    workspace = await resolveRequestedWorkspace(actor.db, actor.userId, req);
  } catch {
    return NextResponse.json({ error: "Workspace unavailable. Try again." }, { status: 503 });
  }

  if (action === "refresh_eligibility") {
    // Explicit refresh must recover stale Free/trial snapshots after an
    // upgrade, even before a number exists. Bound billing reads by time,
    // never permanently by the existence of an old snapshot.
    const limit = await rateLimit(`messaging-eligibility-refresh:${actor.userId}`, 3, 60_000);
    if (limit.unavailable) {
      return NextResponse.json(
        { error: "Messaging eligibility checks are temporarily unavailable. Please try again shortly." },
        { status: 503, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" } },
      );
    }
    if (!limit.ok) {
      return NextResponse.json(
        { error: "Please wait a minute before refreshing messaging eligibility again." },
        { status: 429, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" } },
      );
    }
    await reconcileManagerSmsEntitlement(actor.db, actor.userId);
    // This branch deliberately returns before every runtime/provisioning gate.
    // It may update the stored billing snapshot, but it can never buy a number.
    return NextResponse.json(
      publicStatus(await buildStatus(actor.db, actor.userId, workspace)),
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  // A work number belongs to the workspace, and only its OWNER may buy one.
  // Inside a workspace someone else shares with you, texts go out from the
  // owner's line — refused before any billing or provider work.
  if (!workspace.owned) {
    return NextResponse.json(
      {
        error:
          "This workspace already has a work number. Texts go out from the number its owner set up.",
        code: "workspace_not_owned",
      },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  // Reconcile at the explicit-request boundary, not on GET. Status checks stay
  // read-only and billing/provider work happens only after a manager asks.
  const entitlement = await reconcileManagerSmsEntitlement(
    actor.db,
    actor.userId,
  );
  if (!entitlement.eligible) {
    return NextResponse.json({ error: "We could not verify your communication plan. Try again." }, { status: 503 });
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

  const result = await provisionNumberForWorkspace(
    actor.db,
    actor.userId,
    { workspaceId: workspace.id, ...(areaCode ? { areaCode } : {}) },
  );
  const next = publicStatus(await buildStatus(actor.db, actor.userId, workspace));
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

/**
 * Share a number into a second workspace, or remove it from one. Both ids are
 * re-derived server-side (`assignNumberToWorkspace` / `unassignNumber`) —
 * the request body never grants authority on its own.
 */
export async function PATCH(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const parsedBody = await req.json().catch(() => ({}) as unknown);
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const body = parsedBody as { numberId?: unknown; workspaceId?: unknown; action?: unknown };
  const numberId = typeof body.numberId === "string" ? body.numberId.trim() : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const action = body.action;
  if (!numberId || !workspaceId || (action !== "assign" && action !== "unassign")) {
    return NextResponse.json(
      { error: "numberId, workspaceId, and action (\"assign\" or \"unassign\") are required." },
      { status: 400 },
    );
  }

  const result =
    action === "assign"
      ? await assignNumberToWorkspace(actor.db, actor.userId, { numberId, workspaceId })
      : await unassignNumber(actor.db, actor.userId, { numberId, workspaceId });

  if (!result.ok) {
    const status =
      result.code === "not_authorized" ? 403 : result.code === "not_found" ? 404 : 409;
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  let workspace: ActiveWorkspace;
  try {
    workspace = await resolveActiveWorkspace(actor.db, actor.userId, workspaceId);
  } catch {
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const next = publicStatus(await buildStatus(actor.db, actor.userId, workspace));
  return NextResponse.json(next, { headers: { "Cache-Control": "private, no-store" } });
}
