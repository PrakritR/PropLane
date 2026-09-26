import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleClawLeasingInbound } from "@/lib/claw-leasing-bot.server";
import { claimProspectSmsBurst, completeProspectSmsBurst, type InlineProspectBurst } from "@/lib/sms/prospect-sms-burst.server";
import { resolveInboundOriginal } from "@/lib/sms/resolve-inbound-original.server";
import {
  loadConfirmedProspectTourBooking,
  recoverProspectTourBookingForBurst,
} from "@/lib/prospect-tour-booking-recovery.server";

/** One claimed, revision-fenced run of a prospect burst. The QStash callback,
 * the inbound QStash-outage fallback and the recovery cron all run exactly this,
 * so the database claim is the single arbiter of who replies. */
export async function runProspectSmsBurstJob(
  db: SupabaseClient,
  burstId: string,
  revision: number,
): Promise<NextResponse> {
  const claim = await claimProspectSmsBurst(db, { burstId, revision });
  if (!claim.ok) {
    // A duplicate callback may be genuinely obsolete. A live lease or any
    // persistence error is retryable: acknowledging it would strand the turn.
    const { data: state, error } = await db.from("prospect_sms_bursts")
      .select("revision,status,handled_revision,due_at").eq("id", burstId).maybeSingle();
    if (!error && state && (Number(state.revision) !== revision || Number(state.handled_revision) >= revision || ["suppressed", "dispatched"].includes(String(state.status)))) {
      return NextResponse.json({ ok: true, stale: true });
    }
    // A revision that exhausted its retries stays failed until a new text; one
    // backing off after a failure is republished by the recovery sweep when due.
    // Neither is contention, so a queue retry would only burn delivery quota.
    if (!error && state?.status === "failed") return NextResponse.json({ ok: false, failed: true });
    if (!error && state?.status === "queued" && Date.parse(String(state.due_at)) > Date.now()) {
      return NextResponse.json({ ok: true, deferred: true });
    }
    return NextResponse.json({ error: "Burst claim is busy or unavailable." }, { status: 503 });
  }
  const { data: burst, error: burstError } = await db.from("prospect_sms_bursts")
    .select("manager_user_id,counterparty_phone_e164,reply_from_number,reply_transport,shared_catalog,channel")
    .eq("id", burstId).eq("revision", revision).maybeSingle();
  const { data: ingress, error: ingressError } = await db.from("prospect_sms_ingress")
    .select("source_message_id,body,received_at,channel").eq("burst_id", burstId).in("source_message_id", claim.sourceIds).order("received_at", { ascending: true });
  if (burstError || ingressError || !burst || !ingress?.length) {
    await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
    return NextResponse.json({ error: "Burst state unavailable." }, { status: 503 });
  }
  if (String(burst.reply_transport) === "claw") {
    await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
    return NextResponse.json({ ok: false, unsupported: true, error: "retired_transport_unsupported" });
  }
  const sourceIds = ingress.map((row) => String(row.source_message_id));
  // The ingress queue is recorded after the webhook receipt. Its received_at
  // is processing time, not the original transport time used by the live
  // projector. Rehydrate Twilio originals from their immutable receipts so a
  // burst can never replay the same SID with a later queue timestamp/body.
  let originals: { messageId: string; body: string; receivedAt: string }[];
  try {
    if (burst.channel !== "sms" || ingress.length !== new Set(sourceIds).size ||
        ingress.some((row) => row.channel !== "twilio")) throw new Error("burst_transport_conflict");
    originals = [];
    for (const row of ingress) {
      const messageId = String(row.source_message_id);
      const original = await resolveInboundOriginal(db, messageId, String(burst.manager_user_id));
      if (!original.ingress || original.fromPhone !== burst.counterparty_phone_e164 ||
          original.toPhone !== burst.reply_from_number || original.role !== "prospect") {
        throw new Error("burst_original_conflict");
      }
      originals.push({ messageId, body: original.body, receivedAt: original.occurredAt });
    }
  } catch {
    await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
    return NextResponse.json({ error: "Original burst envelopes unavailable." }, { status: 503 });
  }
  const committedBooking = await loadConfirmedProspectTourBooking(db, {
    managerUserId: String(burst.manager_user_id),
    burstId,
  });
  if (committedBooking) {
    const recovered = await recoverProspectTourBookingForBurst(db, {
      booking: committedBooking,
      workerId: claim.workerId,
      recipientPhone: String(burst.counterparty_phone_e164),
      workNumber: burst.reply_from_number ? String(burst.reply_from_number) : null,
      transport: "twilio",
    });
    if (!recovered.ok) {
      await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
      return NextResponse.json({ error: recovered.error }, { status: 503 });
    }
    // A newer inbound must not strand a committed confirmation just because it
    // superseded the mutable burst row. Recover that booking, then still let
    // the current inbound receive its own ordinary burst-fenced response.
    if (committedBooking.burst_revision === revision) {
      await completeProspectSmsBurst(db, {
        burstId,
        revision,
        workerId: claim.workerId,
        status: "dispatched",
        outboxId: recovered.outboxId || undefined,
      });
      return NextResponse.json({
        ok: true,
        replied: true,
        recoveredBooking: true,
        outboxStatus: recovered.outboxStatus,
      });
    }
  }
  let result;
  try {
    result = await handleClawLeasingInbound({
    from: String(burst.counterparty_phone_e164), text: originals.map((row) => row.body).join("\n"),
    messageId: sourceIds.at(-1) ?? null, mergedMessageIds: sourceIds, managerUserId: String(burst.manager_user_id),
    originalMessages: originals,
    workNumber: burst.reply_from_number ? String(burst.reply_from_number) : null,
    durableBurstWorker: true,
    durablyClaimed: true,
    prospectBurst: {
      burstId, revision, workerId: claim.workerId, claimedSourceIds: sourceIds,
      snapshotCutoff: ingress.map((row) => String(row.received_at)).sort().at(-1),
      transport: burst.reply_transport === "claw" ? "claw" : "twilio",
      sharedCatalog: burst.shared_catalog === true,
    },
    });
  } catch {
    await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
    return NextResponse.json({ error: "Burst execution failed." }, { status: 503 });
  }
  if (!result.ok) {
    await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
    return NextResponse.json({ error: result.error ?? "Burst delivery failed." }, { status: 503 });
  }
  if (result.suppressed || result.completedWithoutReply === "quiet_handoff") {
    const completed = await completeProspectSmsBurst(db, {
      burstId, revision, workerId: claim.workerId, status: "suppressed",
    });
    return completed
      ? NextResponse.json({
          ok: true,
          replied: false,
          ...(result.suppressed ? { suppressed: true } : { completedWithoutReply: "quiet_handoff" }),
        })
      : NextResponse.json({ ok: true, stale: true });
  }
  if (result.outboxId) {
    // prepare_prospect_sms_outbox transferred ownership to the outbox. A
    // deferred/queued row is a durable retry, while submitting and later are
    // already beyond the no-retry transport boundary.
    const { data: outbox, error: outboxError } = await db.from("sms_outbox")
      .select("status").eq("id", result.outboxId).maybeSingle();
    if (outboxError || !outbox) return NextResponse.json({ error: "Outbox state unavailable." }, { status: 503 });
    const status = String(outbox.status);
    if (["queued", "claimed", "deferred", "submitting", "submitted", "sent", "delivered", "unknown"].includes(status)) {
      await db.from("prospect_tour_bookings").update({
        confirmation_outbox_id: result.outboxId,
        confirmation_status: ["submitted", "sent", "delivered"].includes(status)
          ? "submitted"
          : status === "unknown"
            ? "blocked"
            : "prepared",
        updated_at: new Date().toISOString(),
      }).eq("burst_id", burstId).eq("burst_revision", revision).eq("status", "confirmed");
      const { data: booking } = await db.from("prospect_tour_bookings")
        .select("id")
        .eq("burst_id", burstId)
        .eq("burst_revision", revision)
        .eq("status", "confirmed")
        .maybeSingle();
      if (booking) {
        await completeProspectSmsBurst(db, {
          burstId,
          revision,
          workerId: claim.workerId,
          status: "dispatched",
          outboxId: result.outboxId,
        });
      }
      return NextResponse.json({ ok: true, replied: Boolean(result.replied), outboxStatus: status });
    }
    if (status === "blocked") return NextResponse.json({ ok: true, stale: true });
  }
  await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
  return NextResponse.json({ error: "Burst produced no durable delivery outcome." }, { status: 503 });
}

// ponytail: quiet window is 10s; the bound keeps wait + turn inside the route's maxDuration.
const MAX_INLINE_WAIT_MS = 15_000;

/** QStash-outage fallback: wait out the burst's quiet window, then run it here.
 * Safe alongside a late queue delivery or the cron: whoever claims the revision
 * first replies, and a newer text supersedes this revision entirely. */
export async function runInlineProspectBurst(
  db: SupabaseClient,
  burst: InlineProspectBurst,
): Promise<void> {
  const dueMs = burst.dueAt ? Date.parse(burst.dueAt) : NaN;
  const waitMs = Number.isFinite(dueMs) ? Math.min(MAX_INLINE_WAIT_MS, Math.max(0, dueMs - Date.now())) : 0;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  try {
    const res = await runProspectSmsBurstJob(db, burst.burstId, burst.revision);
    if (res.status >= 500) {
      console.warn("inline prospect burst left for recovery", {
        burstId: burst.burstId,
        revision: burst.revision,
        status: res.status,
        error: String((await res.clone().json().catch(() => ({})) as { error?: unknown }).error ?? ""),
      });
    }
  } catch (error) {
    console.error("inline prospect burst failed", { burstId: burst.burstId, revision: burst.revision }, error);
  }
}
