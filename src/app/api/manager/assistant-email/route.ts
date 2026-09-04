import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { getManagerPortalNavSubscriptionTier } from "@/lib/manager-access-server";
import {
  ensureManagerAssistantEmail,
  isAssistantEmailProvisioningEnabled,
  loadManagerAssistantEmail,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import {
  getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement,
} from "@/lib/sms/manager-sms-entitlement.server";
import { isPureCoManagerWorkspace } from "@/lib/sms/manager-workspace-role.server";

export const runtime = "nodejs";

async function buildStatus(
  db: SupabaseClient,
  userId: string,
): Promise<ManagerAssistantEmailStatus> {
  const [entitlement, planTierResult, row, pureCoManager] = await Promise.all([
    getEffectiveManagerSmsEntitlement(db, userId),
    getManagerPortalNavSubscriptionTier(userId),
    loadManagerAssistantEmail(db, userId),
    isPureCoManagerWorkspace(db, userId),
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
    planTier,
    entitlement,
    workspaceRole,
    address: row?.address ?? null,
    canRequest:
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

  const entitlement = await reconcileManagerSmsEntitlement(actor.db, actor.userId);
  if (!entitlement.eligible) {
    return NextResponse.json(
      { error: "A paid Pro or Business plan is required for a PropLane assistant email." },
      { status: 403 },
    );
  }

  const existing = await loadManagerAssistantEmail(actor.db, actor.userId);
  if (existing) {
    return NextResponse.json(await buildStatus(actor.db, actor.userId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  await ensureManagerAssistantEmail(actor.db, actor.userId);
  track("assistant_email_requested", actor.userId, {});
  return NextResponse.json(await buildStatus(actor.db, actor.userId), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
