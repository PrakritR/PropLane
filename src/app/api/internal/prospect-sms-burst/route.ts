import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { handleClawLeasingInbound } from "@/lib/claw-leasing-bot.server";
import { claimProspectSmsBurst, completeProspectSmsBurst, durableProspectSmsHealth } from "@/lib/sms/prospect-sms-burst.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  loadConfirmedProspectTourBooking,
  recoverProspectTourBookingForBurst,
} from "@/lib/prospect-tour-booking-recovery.server";

export const runtime = "nodejs";
export const maxDuration = 60;

function validCallbackSecret(got: string | null): boolean {
  const expected = process.env.PROSPECT_SMS_BURST_CALLBACK_SECRET?.trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected); const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** QStash gets only the opaque burst id/revision. All routing identity and text
 * are loaded from service-only rows, and a forwarded per-job secret prevents a
 * caller from forging a worker invocation. */
export async function POST(req: Request) {
  const health = durableProspectSmsHealth();
  if (!health.ok) return NextResponse.json({ error: health.error }, { status: 503 });
  const raw = await req.text();
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  const signature = req.headers.get("upstash-signature")?.trim();
  if (!currentSigningKey || !nextSigningKey || !signature || !validCallbackSecret(req.headers.get("x-prospect-sms-burst-secret"))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  let verified = false;
  try {
    verified = await new Receiver({ currentSigningKey, nextSigningKey }).verify({ signature, body: raw, url: req.url });
  } catch {
    verified = false;
  }
  if (!verified) return NextResponse.json({ error: "Invalid queue signature." }, { status: 401 });
  const payload = JSON.parse(raw) as { burstId?: unknown; revision?: unknown } | null;
  const burstId = typeof payload?.burstId === "string" ? payload.burstId : "";
  const revision = typeof payload?.revision === "number" ? payload.revision : NaN;
  if (!burstId || !Number.isSafeInteger(revision)) return NextResponse.json({ error: "Invalid job." }, { status: 400 });
  const db = createSupabaseServiceRoleClient();
  const claim = await claimProspectSmsBurst(db, { burstId, revision });
  if (!claim.ok) {
    // A duplicate callback may be genuinely obsolete. A live lease or any
    // persistence error is retryable: acknowledging it would strand the turn.
    const { data: state, error } = await db.from("prospect_sms_bursts")
      .select("revision,status,handled_revision").eq("id", burstId).maybeSingle();
    if (!error && state && (Number(state.revision) !== revision || Number(state.handled_revision) >= revision || ["suppressed", "dispatched"].includes(String(state.status)))) {
      return NextResponse.json({ ok: true, stale: true });
    }
    return NextResponse.json({ error: "Burst claim is busy or unavailable." }, { status: 503 });
  }
  const { data: burst, error: burstError } = await db.from("prospect_sms_bursts")
    .select("manager_user_id,counterparty_phone_e164,reply_from_number,reply_transport,shared_catalog,channel")
    .eq("id", burstId).eq("revision", revision).maybeSingle();
  const { data: ingress, error: ingressError } = await db.from("prospect_sms_ingress")
    .select("source_message_id,body,received_at").eq("burst_id", burstId).in("source_message_id", claim.sourceIds).order("received_at", { ascending: true });
  if (burstError || ingressError || !burst || !ingress?.length) {
    await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
    return NextResponse.json({ error: "Burst state unavailable." }, { status: 503 });
  }
  if (String(burst.reply_transport) === "claw") {
    await completeProspectSmsBurst(db, { burstId, revision, workerId: claim.workerId, status: "failed" });
    return NextResponse.json({ ok: false, unsupported: true, error: "retired_transport_unsupported" });
  }
  const sourceIds = ingress.map((row) => String(row.source_message_id));
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
    from: String(burst.counterparty_phone_e164), text: ingress.map((row) => String(row.body)).join("\n"),
    messageId: sourceIds.at(-1) ?? null, mergedMessageIds: sourceIds, managerUserId: String(burst.manager_user_id),
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
