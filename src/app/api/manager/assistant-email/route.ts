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
    provisioningAvailable: provisioningEnvEnabled && workspaceRole === "primary",
    sendingAvailable: sendEnvEnabled,
    storageReady,
    planTier,
    entitlement,
    workspaceRole,
    address: row?.address ?? null,
    canRequest:
      storageReady &&
      entitlementCanBeReconciled &&
      provisioningEnvEnabled &&
      workspaceRole === "primary" &&
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

  const pureCoManager = await isPureCoManagerWorkspace(actor.db, actor.userId);
  if (pureCoManager) {
    return NextResponse.json(
      { error: "Co-managers use the account owner's assistant email." },
      { status: 403 },
    );
  }

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
