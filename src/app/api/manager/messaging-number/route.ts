import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { rateLimit } from "@/lib/rate-limit";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { getManagerPortalNavSubscriptionTier } from "@/lib/manager-access-server";
import {
  managerCarrierRegistrationNeedsAttention,
  managerMessagingSenderPoolDiagnostic,
  type ManagerMessagingLineBlock,
  type ManagerMessagingNumberStatus,
  type ManagerMessagingPlanTier,
  type ManagerMessagingRuntimeMode,
} from "@/lib/sms/manager-messaging-number";
import {
  getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement,
} from "@/lib/sms/manager-sms-entitlement.server";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { isServiceWorkspace, loadManagedWorkspaceIds, resolveServiceLine } from "@/lib/one-number/service-line.server";
import { PERSONAL_NUMBER_FREE_REFUSAL } from "@/lib/one-number/personal-number";
import { managerPersonalNumberEntitlement } from "@/lib/one-number/personal-number-entitlement.server";
import { getNumberAvailability } from "@/lib/number-subscription/availability.server";
import { isNumberSubscriptionEnabled } from "@/lib/number-subscription/constants";
import { resolveWorkspaceStatusLine, resolveWorkspaceWorkNumbers } from "@/lib/sms/manager-workspace-role.server";
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
  evaluateManagerSmsNumberSendability,
  normalizeProvisionState,
  normalizeRegistrationState,
  normalizeSmsNumberAttachmentState,
  normalizeSmsRuntimeMode,
  smsRuntimeAllowsManager,
} from "@/lib/sms/number-registration-policy";
import {
  evaluateManagerCommsBillingGate,
} from "@/lib/comms-billing/eligibility.server";
import {
  evaluateWorkspaceSendReadiness,
  lineBlockForSendReadinessReason,
} from "@/lib/sms/workspace-send-readiness.server";
import { resolveSmsScopeManagerIds } from "@/lib/manager-sms-messages.server";

export const runtime = "nodejs";

const NUMBER_SELECT =
  "phone_number, provision_state, registration_state, registration_ref, attachment_state, number_registration_state, registration_submitted_at, last_provider_event_at, grace_started_at, grace_expires_at, quarantined_at, quarantine_reason, last_error";

/** `?workspaceId=` override for GET/POST, same "selection never widens access" contract as the cookie. */
function workspaceIdFromQuery(req?: Request): string | undefined {
  if (!req) return undefined;
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
  req?: Request,
  bodyWorkspaceId?: string | null,
): Promise<ActiveWorkspace> {
  const selected = bodyWorkspaceId?.trim() || workspaceIdFromQuery(req);
  return selected
    ? resolveActiveWorkspace(db, userId, selected)
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
    lineConfig,
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
          // The workspace's work number is its LIVE row: a released one stays
          // behind for history (the uniqueness index covers live rows only), so
          // reading both would error here and show the released number as the
          // workspace's own, with no way to request a replacement.
          .is("released_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db
      .from("profiles")
      .select("phone, phone_verified_at, sms_forward_inbound")
      .eq("id", userId)
      .maybeSingle(),
    loadManagerAutomationSettings(db, userId).catch(() => null),
    resolveWorkspaceWorkNumbers(db, userId).catch(() => null),
    // Fails closed to per_workspace: then `sharedLine` stays null and nothing in Settings changes.
    loadSharedLineConfig(db).catch(() => null),
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

  // The set PropLane line, while it is live: which number every workspace texts from by default, and
  // whether THIS workspace is on it (a workspace with a number of its own is not).
  let sharedLine: ManagerMessagingNumberStatus["sharedLine"] =
    lineConfig && lineConfig.mode === "shared" && lineConfig.sharedNumber
      ? { number: lineConfig.sharedNumber, onSharedLine: workspaceOnSharedLine(lineConfig, workspace.id) }
      : null;
  // A PropLane-MANAGED workspace (`is_service`) texts on the PropLane line in BOTH line modes, even when it still holds a
  // number of its own (Oct 25): Settings shows that line, with its usual state, and offers no request or release. Read
  // failures draw nothing managed here; the send path stays fail-closed on its own.
  const managedIds = await loadManagedWorkspaceIds(db, [workspace.id, ...(all?.numbers ?? []).map((n) => n.workspaceId)]);
  const managedActive = managedIds?.has(workspace.id) === true;
  if (managedActive) {
    const serviceLine = await resolveServiceLine(db).catch(() => null);
    sharedLine = serviceLine?.ok ? { number: serviceLine.phoneNumber, onSharedLine: true } : null;
  }
  // (the add-on facts are filled in below, once the entitlement has been read)


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
  // Texting from a shared workspace runs on the OWNER's access: their line,
  // their allowlist seat. Gating a teammate on their own (absent) seat is what
  // reported the workspace's live number as still "Finishing setup".
  const sendModeAllowed = pureCoManager
    ? smsRuntimeAllowsManager(mode, allowlist.includes(workspace.ownerUserId))
    : modeAllowsManager;

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
  // A managed workspace's own old number is no longer its line, so Settings does not show it.
  const number = normalizedNumber && !managedActive
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
  const numberSendability = evaluateManagerSmsNumberSendability(normalizedNumber, {
    runtimeMode: mode,
    managerIsAllowlisted,
  });
  const strictNumberReady = numberSendability.sendable;

  // A teammate sends from the OWNER's line, so the LINE's readiness is the send
  // path's own decision for this workspace and its owner - not the viewer's
  // (empty) number or the viewer's wallet. Any error fails closed.
  //
  // This stays free of anything about who is looking: it is what the
  // work-number card reports, and folding the viewer's grant in here is what
  // described a live workspace line as "Finishing setup".
  let lineReady: boolean;
  // Why not, when not: the one word a UI may print about the line. A teammate
  // has no `number` row of their own, so without this every blocker read as
  // "Finishing setup" over a live, carrier-approved workspace number.
  let lineBlocked: ManagerMessagingLineBlock | null = null;
  // Whether the VIEWER may text from that line. The send path also demands
  // their own Communication (inbox) grant at EDIT level
  // (`manager-sms-send.server.ts`), so a read-only teammate must never be
  // offered a Text channel for a send that would come back 403.
  let viewerMayText: boolean;
  // The row readiness actually resolved, when it got that far: the line a send
  // would leave on, so the number shown and the number used are one read.
  let sendLine: { phoneNumber: string | null; provisionState: string | null } | null = null;
  if (pureCoManager) {
    // With the deployment's texting runtime off the answer is already no, so
    // the whole readiness chain (number + workspace + wallet) and the viewer's
    // grant read are both skipped.
    if (!sendEnvEnabled) {
      lineReady = false;
      lineBlocked = "deployment";
      viewerMayText = false;
    } else {
      const [readiness, mayText] = await Promise.all([
        evaluateWorkspaceSendReadiness({
          db,
          ownerUserId: workspace.ownerUserId,
          workspaceId: workspace.id,
          requiredCents: 3,
          runtime: runtimeResult,
        }).then(
          (value) => value,
          () => null,
        ),
        resolveSmsScopeManagerIds(db, userId, "edit")
          .then((ids) => ids.includes(String(workspace.ownerUserId ?? "").trim()))
          .catch(() => false),
      ]);
      lineReady = readiness?.canSend === true;
      lineBlocked = lineReady
        ? null
        : lineBlockForSendReadinessReason(readiness && !readiness.canSend ? readiness.reason : null);
      viewerMayText = mayText;
      if (readiness?.canSend)
        sendLine = {
          phoneNumber: readiness.numberRow.phone_number,
          provisionState: readiness.numberRow.provision_state,
        };
    }
  } else if (sharedLine?.onSharedLine || managedActive) {
    // On the set PropLane line there is no per-workspace number row to check: the send path's own
    // shared-line decision (runtime switch, rollout seat, the workspace wallet) is the answer. A managed workspace
    // always asks the send path, whichever line mode is live.
    const readiness = await evaluateWorkspaceSendReadiness({
      db,
      ownerUserId: workspace.ownerUserId,
      workspaceId: workspace.id,
      requiredCents: 3,
      runtime: runtimeResult,
    }).catch(() => null);
    lineReady = sendEnvEnabled && readiness?.canSend === true;
    lineBlocked = lineReady
      ? null
      : !sendEnvEnabled
        ? "deployment"
        : lineBlockForSendReadinessReason(readiness && !readiness.canSend ? readiness.reason : null);
    viewerMayText = true;
  } else {
    const billing = await evaluateManagerCommsBillingGate(db, userId, 3);
    lineReady = billing.allowed && sendEnvEnabled && modeAllowsManager && strictNumberReady;
    // The order `evaluateWorkspaceSendReadiness` refuses in - the deployment's
    // switch, then the line's own sendability (which covers the runtime mode
    // and the allowlist seat), then the wallet that pays - worded through the
    // same map a teammate's reason goes through, so an owner and a teammate
    // read the identical line state identically.
    lineBlocked = lineReady
      ? null
      : !sendEnvEnabled
        ? "deployment"
        : lineBlockForSendReadinessReason(
            numberSendability.reason ??
              (billing.allowed ? null : `comms_billing_${billing.reason}`),
          );
    viewerMayText = true;
  }
  const canSend = lineReady && viewerMayText;
  // The standalone PropLane Number subscription lets a Free manager hold a number too. Read only while
  // the shared line is live (otherwise Settings is exactly what it always was).
  const personalNumber = lineConfig?.mode === "shared" && lineConfig.sharedNumber && !pureCoManager && !managedActive
    ? await managerPersonalNumberEntitlement(db, userId)
    : null;
  const addOnActive = Boolean(personalNumber?.ok && personalNumber.entitled && personalNumber.via === "add_on");
  const canRequestBilling = entitlementCanBeReconciled || addOnActive;
  // What "Get your own number" can buy for this workspace: the plan includes it (`canRequest` runs the
  // request), or the standalone PropLane Number subscription (`available` = checkout is on and a
  // number can actually be delivered), or it is already subscribed (`active`).
  let addOn: { available: boolean; active: boolean } | null = null;
  if (sharedLine?.onSharedLine && personalNumber?.ok) {
    const byPlan = personalNumber.entitled && personalNumber.via === "plan";
    const deliverable =
      !byPlan && !addOnActive && isNumberSubscriptionEnabled()
        ? (await getNumberAvailability(db, "manager").catch(() => ({ available: false }))).available
        : false;
    addOn = { available: deliverable, active: addOnActive };
  }

  // One work number per workspace: a co-manager reads the owner's line and
  // never gets a Request button. Their own legacy row (bought before numbers
  // were workspace-owned) still shows under `number` so Settings can say it is
  // being retired, but it is never the number the UI leads with.
  let workspaceNumber: ManagerMessagingNumberStatus["workspaceNumber"] = null;
  if (pureCoManager) {
    const shared = all?.numbers.find((n) => n.workspaceId === workspace.id);
    let line = sendLine;
    if (!line?.phoneNumber && shared && !managedActive && normalizeProvisionState(shared.provisionState) === "active")
      line = { phoneNumber: shared.phoneNumber, provisionState: shared.provisionState };
    // `resolveWorkspaceWorkNumbers` only sees a workspace's HOME row. A line
    // the workspace holds by sharing, or the owner's legacy unplaced row, is
    // what a send would really leave on — read it the same way "can send"
    // does, so a sendable workspace is never shown "No work number yet".
    if (!line?.phoneNumber) {
      const resolved = await resolveWorkspaceStatusLine(db, workspace.ownerUserId, workspace.id).catch(
        () => null,
      );
      if (resolved && normalizeProvisionState(resolved.provisionState) === "active")
        line = resolved;
    }
    workspaceNumber = {
      phoneNumber: line?.phoneNumber ?? null,
      ownerUserId: shared?.ownerUserId ?? workspace.ownerUserId,
      ownerName: shared?.ownerName ?? null,
    };
  }

  return {
    mode,
    sharedLine: sharedLine && addOn ? { ...sharedLine, addOn } : sharedLine,
    workspaceRole: pureCoManager ? "co_manager" : "primary",
    workspaceNumber,
    workspace: { id: workspace.id, name: workspace.name, owned: workspace.owned, isDefault: workspace.isDefault },
    workspaces: (all?.numbers ?? []).map((n) => ({
      workspaceId: n.workspaceId,
      workspaceName: n.workspaceName,
      owned: n.owned,
      isDefault: n.isDefault,
      ownerName: n.ownerName,
      // A managed workspace lists no number of its own: its line is the PropLane line (`sharedLine`).
      phoneNumber: !managedIds?.has(n.workspaceId) && normalizeProvisionState(n.provisionState) === "active" ? n.phoneNumber : null,
      provisionState: managedIds?.has(n.workspaceId) ? null : n.provisionState,
      numbers: n.owned ? (managedIds?.has(n.workspaceId) ? [] : heldByWorkspace.get(n.workspaceId) ?? []) : undefined,
    })),
    provisioningAvailable: provisioningEnvEnabled && modeAllowsManager,
    sendingAvailable: sendEnvEnabled && sendModeAllowed,
    planTier,
    entitlement,
    number,
    // A missing/stale entitlement row must not deadlock a genuinely paid
    // manager: POST performs the authoritative Stripe/Apple reconciliation.
    requestedAtSignup: automationSettings?.workNumberRequestedAtSignup === true,
    lineReady,
    lineBlocked,
    canRequest:
      !pureCoManager &&
      !managedActive &&
      canRequestBilling &&
      provisioningEnvEnabled &&
      modeAllowsManager &&
      requestableState,
    canSend,
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
    sharedLine: status.sharedLine ?? null,
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
    lineReady: status.lineReady,
    lineBlocked: status.lineBlocked ?? null,
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
  /^This workspace texts from the PropLane line\.$/,
  /^Your plan uses the PropLane line\. A number of your own needs a paid plan or the \$5 PropLane Number\.$/,
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
  const body = parsedBody as { action?: unknown; areaCode?: unknown; workspaceId?: unknown };
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
    workspace = await resolveRequestedWorkspace(
      actor.db,
      actor.userId,
      req,
      typeof body.workspaceId === "string" ? body.workspaceId : null,
    );
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

  // A PropLane-managed workspace texts on the PropLane line: it never requests a number of its own. A workspace that
  // cannot be proven unmanaged is refused too.
  const managedWorkspace = await isServiceWorkspace(actor.db, workspace.id);
  if (managedWorkspace !== false) {
    return managedWorkspace === null
      ? NextResponse.json({ error: "Workspace unavailable. Try again." }, { status: 503, headers: { "Cache-Control": "private, no-store" } })
      : NextResponse.json(
          { error: "This workspace texts from the PropLane line.", code: "workspace_on_propLane_line" },
          { status: 403, headers: { "Cache-Control": "private, no-store" } },
        );
  }

  // Reconcile at the explicit-request boundary, not on GET. Status checks stay
  // read-only and billing/provider work happens only after a manager asks.
  // Only a paid Pro or Business workspace may take a personalized number; a Free workspace simply
  // texts from the PropLane line.
  let entitlement: Awaited<ReturnType<typeof reconcileManagerSmsEntitlement>> = await reconcileManagerSmsEntitlement(actor.db, actor.userId);
  if (!entitlement.eligible) {
    // A Free (or trialing) account may still hold a number through the standalone PropLane Number
    // subscription; every other Pro feature stays locked.
    const personal = await managerPersonalNumberEntitlement(actor.db, actor.userId);
    if (personal.ok && personal.entitled && personal.via === "add_on") {
      entitlement = { eligible: true, tier: "free", source: "none" };
    }
  }
  if (!entitlement.eligible) {
    if (entitlement.reason === "free") {
      return NextResponse.json(PERSONAL_NUMBER_FREE_REFUSAL, { status: 403, headers: { "Cache-Control": "private, no-store" } });
    }
    // A trial is a definite, not a transient, refusal — a work number is a paid
    // feature and this account is not paying yet (`refuseTrialForNumber`
    // already collapsed an eligible trial to `reason: "trialing"` above). Give
    // that its own plain 403 instead of the generic "try again" the messaging
    // panel's other, genuinely transient reasons (`plan_unreadable`,
    // `legacy_unknown`) still use below.
    if (entitlement.reason === "trialing") {
      return NextResponse.json(
        {
          error: "A free trial cannot buy a work number. Start Pro to continue.",
          code: "trial_cannot_buy_number",
        },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: "We could not verify your communication plan. Try again." }, { status: 503 });
  }

  // Messaging eligibility alone is not enough for a NUMBER (captain, Oct 28): a payment-waiver (FREE100) grant or an
  // admin comp is messaging-eligible but keeps the PropLane line; only a billable plan, the $5 PropLane Number, or a
  // number that already existed (grandfathered) entitles one. An unreadable answer falls through: the provisioning
  // call below re-checks and fails closed.
  const numberGate = await managerPersonalNumberEntitlement(actor.db, actor.userId);
  if (numberGate.ok && !numberGate.entitled) {
    return NextResponse.json(PERSONAL_NUMBER_FREE_REFUSAL, { status: 403, headers: { "Cache-Control": "private, no-store" } });
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
      { status: "code" in result && result.code === "not_entitled" ? 403 : result.state === "pending_registration" ? 503 : 502 },
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

  // A PropLane-managed workspace holds no number of its own, so nothing is shared into it or removed from it.
  const managedWorkspace = await isServiceWorkspace(actor.db, workspaceId);
  if (managedWorkspace !== false) {
    return managedWorkspace === null
      ? NextResponse.json({ error: "Workspace unavailable. Try again." }, { status: 503, headers: { "Cache-Control": "private, no-store" } })
      : NextResponse.json(
          { error: "This workspace texts from the PropLane line.", code: "workspace_on_propLane_line" },
          { status: 403, headers: { "Cache-Control": "private, no-store" } },
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
