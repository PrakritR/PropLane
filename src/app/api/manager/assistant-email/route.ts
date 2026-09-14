import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { rateLimit } from "@/lib/rate-limit";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { getManagerPortalNavSubscriptionTier } from "@/lib/manager-access-server";
import { assistantEmailEligibilityError } from "@/lib/manager-assistant-email/assistant-email-eligibility-copy";
import {
  ensureManagerAssistantEmail,
  isAssistantEmailProvisioningEnabled,
  isAssistantEmailReceivingEnabled,
  isAssistantEmailSendingEnabled,
  isAssistantEmailStorageError,
  loadManagerAssistantEmail,
  probeAssistantEmailStorageReady,
  resolveWorkspaceWorkEmails,
  WorkspaceEmailSharedError,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import {
  managerCommsRequestIsOfferable,
  managerCommsUseIsAllowed,
} from "@/lib/comms-billing/manager-comms-eligibility.server";
import {
  getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement,
} from "@/lib/sms/manager-sms-entitlement.server";
import { isPureCoManagerWorkspace } from "@/lib/sms/manager-workspace-role.server";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";

export const runtime = "nodejs";

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
): Promise<ManagerAssistantEmailStatus> {
  // Read the entitlement EXACTLY the way the work number does — no
  // `preferPaid`, no trial demotion. Those two differences were what made a
  // manager who qualifies for a number fail to qualify for the email.
  const [entitlement, planTierResult, row, pureCoManager, storageReady, automationSettings] =
    await Promise.all([
      getEffectiveManagerSmsEntitlement(db, userId),
      getManagerPortalNavSubscriptionTier(userId),
      loadManagerAssistantEmail(db, userId),
      isPureCoManagerWorkspace(db, userId),
      probeAssistantEmailStorageReady(db),
      loadManagerAutomationSettings(db, userId).catch(() => null),
    ]);

  const planTier: ManagerAssistantEmailStatus["planTier"] =
    planTierResult === "free" ? "free" : planTierResult === null ? "unknown" : "paid";

  const sendEnvEnabled = isAssistantEmailSendingEnabled();
  const receiveEnvEnabled = isAssistantEmailReceivingEnabled();
  // "Working" is both directions. Production ran for a while with mail going
  // out and no way for a reply to come back in; the card said "Ready".
  const channelEnabled = sendEnvEnabled && receiveEnvEnabled;
  const provisioningEnvEnabled = isAssistantEmailProvisioningEnabled();
  const workspaceRole = pureCoManager ? "co_manager" : "primary";

  // One work email per workspace: a co-manager reads the owner's address and
  // never gets a Request button. Their own legacy row (requested before
  // addresses were workspace-owned) still shows under `address` so Settings
  // can say it is being retired, but it is never the address the UI leads with.
  let workspaceEmail: ManagerAssistantEmailStatus["workspaceEmail"] = null;
  if (pureCoManager) {
    const workspace = await resolveWorkspaceWorkEmails(db, userId).catch(() => null);
    const primary = workspace?.emails[0];
    if (primary) {
      workspaceEmail = {
        address: channelEnabled ? primary.address : null,
        ownerUserId: primary.ownerUserId,
        ownerName: primary.ownerName,
      };
    }
  }

  // Email is unmetered; an empty communication wallet never disables it.
  const canRequestBilling = managerCommsRequestIsOfferable({
    entitlement,
  });
  const commsBillingAllowed = managerCommsUseIsAllowed({
    entitlement,
  });

  const canUse = commsBillingAllowed && channelEnabled && Boolean(row);

  /**
   * What the card renders, in the work number's own vocabulary.
   *
   * `assigned_send_off` is the email's version of the number's "registered but
   * texting is switched off for this workspace": an address exists, but this
   * deployment cannot send mail, so it can neither reply nor be advertised.
   * Without it the card said "ready" for an address that silently swallowed
   * every message.
   *
   * `assigned_plan_hold` is the other reason the same address can go quiet — a
   * lapsed plan or a billing problem. They are deliberately separate states:
   * telling a manager "this is a PropLane setting, not something to chase" when
   * the truth is their card expired sends them to support instead of billing.
   */
  const state: ManagerAssistantEmailStatus["state"] = !storageReady
    ? "storage_unavailable"
    : row
      ? canUse
        ? "ready"
        : channelEnabled
          ? "assigned_plan_hold"
          : "assigned_send_off"
      : canRequestBilling && provisioningEnvEnabled
        ? "requestable"
        : "unavailable";

  return {
    provisioningAvailable: provisioningEnvEnabled,
    sendingAvailable: sendEnvEnabled,
    receivingAvailable: receiveEnvEnabled,
    storageReady,
    planTier,
    entitlement,
    workspaceRole,
    workspaceEmail,
    address: row?.address ?? null,
    state,
    // One address per workspace, exactly like the number: a pure co-manager
    // sends from the owner's address and never sees a Request button.
    canRequest:
      !pureCoManager && storageReady && canRequestBilling && provisioningEnvEnabled && !row,
    canUse,
    requestedAtSignup: automationSettings?.workEmailRequestedAtSignup === true,
  };
}

export async function GET() {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const status = await buildStatus(actor.db, actor.userId);
  return NextResponse.json(status, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const parsedBody = await req.json().catch(() => ({}) as unknown);
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? (parsedBody as { action?: unknown })
    : {};
  const action = body.action === undefined ? "request_address" : body.action;
  if (action !== "request_address" && action !== "refresh_eligibility") {
    return NextResponse.json({ error: "Unknown work-email action." }, { status: 400 });
  }

  if (action === "refresh_eligibility") {
    // Same throttle as the work number's refresh: this reaches the billing
    // provider, so it must not be a button a page can hold down.
    const limit = await rateLimit(`work-email-eligibility-refresh:${actor.userId}`, 3, 60_000);
    if (limit.unavailable) {
      return NextResponse.json(
        { error: "Work email eligibility checks are temporarily unavailable. Please try again shortly." },
        { status: 503, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" } },
      );
    }
    if (!limit.ok) {
      return NextResponse.json(
        { error: "Please wait a minute before refreshing work email eligibility again." },
        { status: 429, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" } },
      );
    }
    const current = await buildStatus(actor.db, actor.userId);
    const neverReconciled =
      !current.entitlement.eligible &&
      !(await hasStoredEntitlementRow(actor.db, actor.userId));
    if (!current.address && !neverReconciled) {
      return NextResponse.json(
        {
          ...current,
          error: "Request a work email before refreshing its eligibility.",
        },
        { status: 409 },
      );
    }
    await reconcileManagerSmsEntitlement(actor.db, actor.userId);
    return NextResponse.json(await buildStatus(actor.db, actor.userId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  // A work email belongs to the workspace, exactly like the work number. A
  // co-manager who owns no houses sends from the owner's address and may not
  // request a second one for the same workspace — refused before any billing
  // or storage work.
  //
  // Scope still comes from the assignment, not the address:
  // `resolveManagerEmailInboundIdentity` recognises the co-manager by their own
  // From address and `resolveManagerSmsAccess` scopes the turn to the houses
  // assigned to them — so writing to the shared address answers about their
  // assigned houses and nothing else, and their questions land in THEIR
  // Communication, not the owner's.
  let pureCoManager: boolean;
  try {
    pureCoManager = await isPureCoManagerWorkspace(actor.db, actor.userId, { throwOnError: true });
  } catch {
    return NextResponse.json({ error: "Workspace unavailable. Try again." }, { status: 503 });
  }
  if (pureCoManager) {
    return NextResponse.json(
      {
        error:
          "Your workspace already has a work email. Mail goes out from the address your workspace owner set up.",
        code: "workspace_email_shared",
      },
      { status: 409, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  if (!isAssistantEmailProvisioningEnabled()) {
    return NextResponse.json(
      { error: "Work email setup is paused right now." },
      { status: 503 },
    );
  }

  const storageReady = await probeAssistantEmailStorageReady(actor.db);
  if (!storageReady) {
    return NextResponse.json(
      {
        error:
          "Work email storage is not ready on this environment yet. Ask your admin to apply the latest database migration.",
      },
      { status: 503 },
    );
  }

  // Reconcile at the explicit-request boundary, not on GET — same as the number.
  const entitlement = await reconcileManagerSmsEntitlement(actor.db, actor.userId);
  const planTierResult = await getManagerPortalNavSubscriptionTier(actor.userId);
  const planTier: ManagerAssistantEmailStatus["planTier"] =
    planTierResult === "free" ? "free" : planTierResult === null ? "unknown" : "paid";

  if (!entitlement.eligible) {
    return NextResponse.json(
      { error: assistantEmailEligibilityError(planTier, entitlement) },
      { status: entitlement.reason === "plan_unreadable" || entitlement.reason === "legacy_unknown" ? 503 : 403 },
    );
  }

  const existing = await loadManagerAssistantEmail(actor.db, actor.userId);
  if (existing) {
    return NextResponse.json(await buildStatus(actor.db, actor.userId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  try {
    await ensureManagerAssistantEmail(actor.db, actor.userId);
  } catch (cause) {
    if (cause instanceof WorkspaceEmailSharedError) {
      return NextResponse.json(
        { error: cause.message, code: cause.code },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const message = cause instanceof Error ? cause.message : "";
    const tableMissing =
      (cause instanceof Error &&
        "code" in cause &&
        isAssistantEmailStorageError(cause as { code?: string; message?: string })) ||
      /manager_assistant_emails/i.test(message);
    return NextResponse.json(
      {
        error: tableMissing
          ? "Work email storage is not ready on this environment yet. Ask your admin to apply the latest database migration."
          : "Could not set up your work email. Try again shortly.",
      },
      { status: tableMissing ? 503 : 500 },
    );
  }
  track("assistant_email_requested", actor.userId, {});
  return NextResponse.json(await buildStatus(actor.db, actor.userId), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
