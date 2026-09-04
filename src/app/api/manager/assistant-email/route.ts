import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
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
  getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement,
} from "@/lib/sms/manager-sms-entitlement.server";
import { isPureCoManagerWorkspace } from "@/lib/sms/manager-workspace-role.server";

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
  const [entitlement, planTierResult, row, pureCoManager, storageReady] = await Promise.all([
    getEffectiveManagerSmsEntitlement(db, userId),
    getManagerPortalNavSubscriptionTier(userId),
    loadManagerAssistantEmail(db, userId),
    isPureCoManagerWorkspace(db, userId),
    probeAssistantEmailStorageReady(db),
  ]);

  const planTier: ManagerAssistantEmailStatus["planTier"] =
    planTierResult === "free" ? "free" : planTierResult === null ? "unknown" : "paid";

  const sendEnvEnabled = Boolean(process.env.RESEND_API_KEY?.trim());
  const provisioningEnvEnabled = isAssistantEmailProvisioningEnabled();
  const workspaceRole = pureCoManager ? "co_manager" : "primary";

  const entitlementCanBeReconciled =
    entitlement.eligible ||
    entitlement.reason === "plan_unreadable" ||
    entitlement.reason === "legacy_unknown";

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
    // No `workspaceRole === "primary"` condition. That was the gate that
    // actually mattered: the POST refusal was visible, but this quietly made the
    // request button never appear for a co-manager, so removing only the
    // refusal would have left the feature unreachable. Every manager who clears
    // the plan check can request their own address.
    canRequest:
      storageReady &&
      entitlementCanBeReconciled &&
      provisioningEnvEnabled &&
      !row,
    canUse: entitlement.eligible && sendEnvEnabled && Boolean(row),
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
    return NextResponse.json({ error: "Unknown assistant-email action." }, { status: 400 });
  }

  if (action === "refresh_eligibility") {
    const current = await buildStatus(actor.db, actor.userId);
    const neverReconciled =
      !current.entitlement.eligible &&
      !(await hasStoredEntitlementRow(actor.db, actor.userId));
    if (!current.address && !neverReconciled) {
      return NextResponse.json(
        {
          ...current,
          error: "Request an assistant email before refreshing its eligibility.",
        },
        { status: 409 },
      );
    }
    await reconcileManagerSmsEntitlement(actor.db, actor.userId);
    return NextResponse.json(await buildStatus(actor.db, actor.userId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  // A co-manager gets their OWN assistant address, not the owner's.
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
      { error: "Assistant email setup is paused right now." },
      { status: 503 },
    );
  }

  const storageReady = await probeAssistantEmailStorageReady(actor.db);
  if (!storageReady) {
    return NextResponse.json(
      {
        error:
          "Assistant email storage is not ready on this environment yet. Ask your admin to apply the latest database migration.",
      },
      { status: 503 },
    );
  }

  const entitlement = await reconcileManagerSmsEntitlement(actor.db, actor.userId);
  const planTierResult = await getManagerPortalNavSubscriptionTier(actor.userId);
  const planTier: ManagerAssistantEmailStatus["planTier"] =
    planTierResult === "free" ? "free" : planTierResult === null ? "unknown" : "paid";
  if (!entitlement.eligible) {
    return NextResponse.json(
      { error: assistantEmailEligibilityError(planTier, entitlement) },
      { status: 403 },
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
          ? "Assistant email storage is not ready on this environment yet. Ask your admin to apply the latest database migration."
          : "Could not set up assistant email. Try again shortly.",
      },
      { status: tableMissing ? 503 : 500 },
    );
  }
  track("assistant_email_requested", actor.userId, {});
  return NextResponse.json(await buildStatus(actor.db, actor.userId), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
