import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadWorkspacePaymentSettingsForProperty, workspaceAutopayRetryEnabled } from "@/lib/workspace-payment-settings.server";
import {
  chargeAutopay,
  claimRun,
  listAutopayDueCharges,
  listFailedAutopayRunsEligibleForRetry,
  retryAutopayRun,
} from "@/lib/resident-autopay.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Daily autopay run. Idempotent by construction: `claimRun`'s unique
 * `charge_id` insert is the double-charge guard, so running this twice in one
 * day (a redelivered cron trigger, an overlapping manual invocation) never
 * charges a charge a second time — the second `claimRun` call for the same
 * charge just returns `claimed: false` and is skipped.
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

  const due = await listAutopayDueCharges(db, now);
  for (const item of due) {
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
  // manager's own workspace setting still allows it.
  let retried = 0;
  const retryCandidates = await listFailedAutopayRunsEligibleForRetry(db, now);
  for (const candidate of retryCandidates) {
    try {
      const workspaceSettings = await loadWorkspacePaymentSettingsForProperty(db, candidate.managerId, candidate.propertyId);
      if (!workspaceAutopayRetryEnabled(workspaceSettings)) continue;

      const { data: runRow } = await db
        .from("resident_autopay_runs")
        .select("id, updated_at, failure_reason")
        .eq("id", candidate.runId)
        .maybeSingle();
      if (!runRow) continue;

      const claim = await retryAutopayRun(
        db,
        {
          id: String(runRow.id),
          updatedAt: String(runRow.updated_at),
          failureReason: (runRow.failure_reason as string | null) ?? null,
        },
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
        attempt: 2,
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
