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
  isAssistantEmailStorageError,
  loadManagerAssistantEmail,
  probeAssistantEmailStorageReady,
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

  const sendEnvEnabled = Boolean(process.env.RESEND_API_KEY?.trim());
  const provisioningEnvEnabled = isAssistantEmailProvisioningEnabled();
  const workspaceRole = pureCoManager ? "co_manager" : "primary";

  // Email is unmetered; an empty communication wallet never disables it.
  const canRequestBilling = managerCommsRequestIsOfferable({
    entitlement,
  });
  const commsBillingAllowed = managerCommsUseIsAllowed({
    entitlement,
  });

  const canUse = commsBillingAllowed && sendEnvEnabled && Boolean(row);

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
        : sendEnvEnabled
          ? "assigned_plan_hold"
          : "assigned_send_off"
      : canRequestBilling && provisioningEnvEnabled
        ? "requestable"
        : "unavailable";

  return {
    // Same reasoning as `canRequest` below — provisioning is available to any
    // manager account, co-manager included.
    provisioningAvailable: provisioningEnvEnabled,
    sendingAvailable: sendEnvEnabled,
    storageReady,
    planTier,
    entitlement,
    workspaceRole,
    address: row?.address ?? null,
    state,
    // No `workspaceRole === "primary"` condition. That was the gate that
    // actually mattered: the POST refusal was visible, but this quietly made the
    // request button never appear for a co-manager, so removing only the
    // refusal would have left the feature unreachable. Every manager who clears
    // the plan check can request their own address.
    canRequest: storageReady && canRequestBilling && provisioningEnvEnabled && !row,
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

  // A co-manager gets their OWN work email, not the owner's.
  //
  // They were refused here and told to email the account owner's address, which
  // meant two people shared one mailbox and one assistant identity: the owner
  // saw the co-manager's questions in their own thread, and the co-manager had
  // nothing to hand a resident. Every manager who sets one up now has their own.
  //
  // Scope is unchanged and comes from the assignment, not the address:
  // `resolveManagerEmailInboundIdentity` resolves the mailbox owner and then
  // `resolveManagerSmsAccess` scopes the turn to the houses assigned to them —
  // so a co-manager's address answers about their assigned houses across every
  // owner who assigned them, and about nothing else.
  //
  // `mailbox_local` is allocated uniquely (`allocateAssistantMailboxLocal`), so
  // two managers never share an address.

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
