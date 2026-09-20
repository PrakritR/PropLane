import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  loadWorkspacePaymentSettingsForProperty,
  workspaceAutopayEnabled,
  workspaceAutopayRetryEnabled,
  type WorkspacePaymentSettings,
} from "@/lib/workspace-payment-settings.server";
import {
  chargeAutopay,
  claimRun,
  listAutopayDueCharges,
  listFailedAutopayRunsEligibleForRetry,
  retryAutopayRun,
} from "@/lib/resident-autopay.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Same rule as comms-billing-invoice: preview deployments are public and
    // hold real credentials, so secretless access is a localhost convenience
    // only. This one moves money, so it fails closed everywhere else.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Daily autopay run. Idempotent by construction: `claimRun`'s unique
 * `charge_id` insert is the double-charge guard, so running this twice in one
 * day (a redelivered cron trigger, an overlapping manual invocation) never
 * charges a charge a second time — the second `claimRun` call for the same
 * charge just returns `claimed: false` and is skipped. Both passes re-read the
 * manager's workspace setting per property: a manager who turns autopay off
 * after residents enrolled stops every debit, not just new enrollments.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const now = new Date();
  let charged = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  const workspaceSettingsCache = new Map<string, Promise<WorkspacePaymentSettings>>();
  const workspaceSettingsFor = (managerId: string, propertyId: string) => {
    const key = `${managerId}|${propertyId}`;
    let pending = workspaceSettingsCache.get(key);
    if (!pending) {
      pending = loadWorkspacePaymentSettingsForProperty(db, managerId, propertyId);
      workspaceSettingsCache.set(key, pending);
    }
    return pending;
  };

  const due = await listAutopayDueCharges(db, now);
  for (const item of due) {
    try {
      if (!workspaceAutopayEnabled(await workspaceSettingsFor(item.managerId, item.propertyId))) {
        skipped++;
        continue;
      }
    } catch (e) {
      skipped++;
      errors.push(`${item.chargeId}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const claim = await claimRun(db, {
      chargeId: item.chargeId,
      residentUserId: item.residentUserId,
      managerId: item.managerId,
    });
    if (!claim.claimed) {
      skipped++;
      continue;
    }
    try {
      const result = await chargeAutopay(db, {
        id: claim.runId,
        chargeId: item.chargeId,
        residentUserId: item.residentUserId,
        residentEmail: item.residentEmail,
        managerId: item.managerId,
        paymentMethodId: item.paymentMethodId,
        attempt: 1,
      });
      if (result.ok) {
        charged++;
        track("autopay_run_result", item.residentUserId, { status: "succeeded" });
      } else {
        failed++;
        track("autopay_run_result", item.residentUserId, { status: "failed" });
      }
    } catch (e) {
      failed++;
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${item.chargeId}: ${message}`);
    }
  }

  // The one allowed retry, three-plus days after a decline, and only when the
  // manager's own workspace settings still allow autopay AND the retry.
  let retried = 0;
  const retryCandidates = await listFailedAutopayRunsEligibleForRetry(db, now);
  for (const candidate of retryCandidates) {
    try {
      const workspaceSettings = await workspaceSettingsFor(candidate.managerId, candidate.propertyId);
      if (!workspaceAutopayEnabled(workspaceSettings) || !workspaceAutopayRetryEnabled(workspaceSettings)) continue;

      const claim = await retryAutopayRun(
        db,
        { id: candidate.runId, updatedAt: candidate.updatedAt, attempt: candidate.attempt },
        now,
      );
      if (!claim.retried) continue;

      const result = await chargeAutopay(db, {
        id: candidate.runId,
        chargeId: candidate.chargeId,
        residentUserId: candidate.residentUserId,
        residentEmail: candidate.residentEmail,
        managerId: candidate.managerId,
        paymentMethodId: candidate.paymentMethodId,
        attempt: claim.attempt,
      });
      retried++;
      track("autopay_run_result", candidate.residentUserId, { status: result.ok ? "succeeded" : "failed" });
      if (result.ok) charged++;
      else failed++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`retry ${candidate.chargeId}: ${message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    due: due.length,
    charged,
    skipped,
    failed,
    retried,
    errors: errors.length ? errors : undefined,
  });
}
