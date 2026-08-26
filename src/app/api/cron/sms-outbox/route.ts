import { NextResponse } from "next/server";
import {
  dispatchOwnerSmsOutbox,
  loadUnknownSmsInventory,
} from "@/lib/sms/owner-sms-dispatcher.server";
import { reconcilePendingManagerNumberOperations } from "@/lib/sms/manager-number-provisioning.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = req.headers.get("authorization") ?? "";
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const workerId = `cron-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  const db = createSupabaseServiceRoleClient();
  const provisioning = await reconcilePendingManagerNumberOperations(db, 5);
  const total = { claimed: 0, submitted: 0, blocked: 0, unknown: 0 };
  const infrastructureErrors = new Set<string>();
  let capacityReached = false;
  for (let batch = 0; batch < 10 && Date.now() - startedAt < 45_000; batch += 1) {
    const result = await dispatchOwnerSmsOutbox({ workerId, limit: 5 }, db);
    total.claimed += result.claimed;
    total.submitted += result.submitted;
    total.blocked += result.blocked;
    total.unknown += result.unknown;
    if (!result.ok) {
      for (const error of result.infrastructureErrors) infrastructureErrors.add(error);
      break;
    }
    if (batch === 9 && result.claimed === 5) capacityReached = true;
    if (result.claimed < 5) break;
  }
  if (provisioning.needsReview > 0 || provisioning.attachmentDrifted > 0) {
    console.error("sms provisioning reconciliation requires review", provisioning);
  }
  if (total.unknown > 0 || total.blocked > 0) {
    console.error("sms outbox contains terminal outcomes", total);
  }
  const unknownInventory = await loadUnknownSmsInventory(db);
  if (!unknownInventory.ok) {
    console.error("sms unknown-outcome inventory unavailable", {
      error: unknownInventory.error,
    });
  } else if (unknownInventory.count > 0) {
    console.error("sms unknown outcomes require operator review", {
      count: unknownInventory.count,
      outboxIds: unknownInventory.outboxIds,
    });
  }

  const nowIso = new Date().toISOString();
  const [{ count: dueBacklogCount, error: dueBacklogError }, { count: quarantinedNumberCount, error: quarantineError }] =
    await Promise.all([
      db
        .from("sms_outbox")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "deferred"])
        .lte("available_at", nowIso),
      db
        .from("manager_sms_numbers")
        .select("manager_user_id", { count: "exact", head: true })
        .not("quarantined_at", "is", null),
    ]);

  const alerts: string[] = [];
  if (infrastructureErrors.size > 0) alerts.push("dispatcher_infrastructure_unavailable");
  if (!unknownInventory.ok) alerts.push("unknown_inventory_unavailable");
  else if (unknownInventory.count > 0) alerts.push("unknown_submission_inventory_nonempty");
  if (dueBacklogError) alerts.push("due_backlog_inventory_unavailable");
  else if ((dueBacklogCount ?? 0) > 0 || capacityReached) alerts.push("due_outbox_backlog_nonempty");
  if (quarantineError) alerts.push("number_quarantine_inventory_unavailable");
  else if ((quarantinedNumberCount ?? 0) > 0) alerts.push("number_quarantine_inventory_nonempty");
  if (provisioning.needsReview > 0 || provisioning.attachmentDrifted > 0) {
    alerts.push("provisioning_review_required");
  }

  const response = {
    ok: alerts.length === 0,
    alerts,
    provisioning,
    unknownInventory,
    dueBacklogCount: dueBacklogCount ?? null,
    quarantinedNumberCount: quarantinedNumberCount ?? null,
    capacityReached,
    infrastructureErrors: [...infrastructureErrors],
    ...total,
  };
  if (alerts.length > 0) console.error("sms scheduler health gate failed", response);
  return NextResponse.json(response, { status: alerts.length > 0 ? 503 : 200 });
}
