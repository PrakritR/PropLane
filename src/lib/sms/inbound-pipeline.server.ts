import { intakeResidentSmsPhotos } from "@/lib/inspections/attachment-intake.server";
import { after, NextResponse } from "next/server";
import { handleClawLeasingInbound } from "@/lib/claw-leasing-bot.server";
import { runInlineProspectBurst } from "@/lib/sms/prospect-sms-burst-job.server";
import { isClawSharedLineBridgeEnabled } from "@/lib/claw-leasing-links";
import { forwardResidentInboundToManagerCell } from "@/lib/sms/manager-relay.server";
import { resolveManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { ensureManagerInboundReplyConsent } from "@/lib/sms/manager-conversation-consent.server";
import { resolveWorkspaceOwnerForWorkNumber } from "@/lib/sms/manager-workspace-role.server";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";
import {
  deliverManagerSmsReply,
  runManagerSmsAgentTurn,
} from "@/lib/agent/manager-sms-agent.server";
import { inboundLogIdentityFields } from "@/lib/manager-sms-messages.server";
import { resolveResidentSmsAgentContext } from "@/lib/tools/resident-sms-context";
import {
  deliverResidentSmsReply,
  runResidentSmsAgentTurn,
} from "@/lib/agent/resident-sms-agent.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";
import {
  attachInboundOutbox,
  finishInboundClaim,
  loadInboundReplay,
  prepareInboundReply,
  type SmsInboundReplay,
} from "@/lib/sms/inbound-replay.server";
import { upsertManagerSmsContact } from "@/lib/sms/manager-sms-contacts.server";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";
import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";
import { randomUUID } from "node:crypto";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { resolveOwnedWorkNumber } from "@/lib/sms/resolve-owned-work-number.server";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Empty TwiML — replies are sent asynchronously via the Messaging API. */
export function twimlOk(reply?: string): NextResponse {
  const escaped = reply
    ? reply.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "";
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${escaped ? `<Message>${escaped}</Message>` : ""}</Response>`,
    {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    },
  );
}

/** Everything the post-claim pipeline needs, and exactly what a receipt
 * stores in `inbound_payload` so the recovery sweeper can rerun it. */
export type InboundPayload = {
  fromPhone: string;
  toPhone: string;
  body: string;
  workspaceId: string | null;
  /** Only `NumMedia` / `MediaUrlN` / `MediaContentTypeN` from the webhook. */
  media: Record<string, string>;
  /** Runtime that received the text. Staging runs on a production clone, so a
   * sweeper only replays receipts its own runtime stored. */
  runtime: string;
};

export function inboundRuntime(): string {
  return process.env.VERCEL_ENV?.trim() || "development";
}

export type ClaimedInbound = InboundPayload & {
  messageSid: string;
  /** Workspace owner the receipt was claimed under. */
  managerId: string;
  inboundWorkerId: string;
  mark: (step: string) => void;
};

export function inboundMediaParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => /^(NumMedia|MediaUrl\d+|MediaContentType\d+)$/.test(key)),
  );
}

/**
 * The one boundary for a claimed receipt. Twilio never retries a 5xx on our
 * webhook (its default retry policy is connect-failure only), so a claimed
 * receipt is recovered only by `recoverInboundReceipts`. Any throw below must
 * therefore release the claim as `retryable`, never escape as a bare 500.
 */
export async function runClaimedInbound(db: SupabaseClient, input: ClaimedInbound): Promise<NextResponse> {
  try {
    return await processClaimedInbound(db, input);
  } catch (error) {
    console.error("twilio inbound processing failed", input.messageSid, error instanceof Error ? error.message : String(error));
    await finishInboundClaim(db, input.messageSid, input.inboundWorkerId, "retryable").catch(() => false);
    return NextResponse.json({ error: "Inbound processing failed." }, { status: 503 });
  }
}

// ponytail: fixed cap and window; make them per-failure-kind if poison messages get common.
const MAX_INBOUND_ATTEMPTS = 5;
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECOVERY_BATCH = 10;
const LEASE_GRACE_MS = 60_000;

export type InboundRecoveryResult = { scanned: number; recovered: number; failed: number; dropped: number };

/**
 * Rerun claimed inbound texts whose attempt failed (`retryable`) or died
 * mid-flight (lease expired). Reuses the webhook's pipeline, so prepared
 * replies are resent rather than regenerated and agent turns stay idempotent
 * on the MessageSid.
 */
export async function recoverInboundReceipts(
  db: SupabaseClient,
  opts: { deadline: number; now?: number },
): Promise<InboundRecoveryResult> {
  const now = opts.now ?? Date.now();
  const { data, error } = await db
    .from("sms_inbound_receipts")
    .select("message_sid, manager_user_id, recipient_phone_key, status, lease_expires_at, inbound_payload")
    .in("status", ["processing", "retryable"])
    .not("inbound_payload", "is", null)
    .lt("attempt_count", MAX_INBOUND_ATTEMPTS)
    .gt("first_received_at", new Date(now - RECOVERY_WINDOW_MS).toISOString())
    .order("first_received_at", { ascending: true })
    .limit(RECOVERY_BATCH);
  if (error) throw new Error("Inbound receipts could not be read.", { cause: error });

  const result: InboundRecoveryResult = { scanned: data?.length ?? 0, recovered: 0, failed: 0, dropped: 0 };
  const { isShieldedRecipient } = await import("@/lib/protected-accounts.server");
  for (const row of data ?? []) {
    if (Date.now() >= opts.deadline) break;
    // The webhook's lease equals its maxDuration, so give a still-running
    // invocation time to be killed before taking its receipt over.
    if (row.status === "processing" && (!row.lease_expires_at || Date.parse(row.lease_expires_at) > now - LEASE_GRACE_MS)) continue;
    const payload = row.inbound_payload as InboundPayload;
    if (payload.runtime !== inboundRuntime()) continue;
    if ((await isShieldedRecipient({ phone: payload.fromPhone })) || (await isShieldedRecipient({ phone: payload.toPhone }))) continue;

    const inboundWorkerId = `inbound-recovery-${randomUUID()}`;
    const { data: claimed, error: claimError } = await db.rpc("claim_sms_inbound", {
      p_message_sid: row.message_sid,
      p_manager_user_id: row.manager_user_id,
      p_recipient_phone_key: row.recipient_phone_key,
      p_worker_id: inboundWorkerId,
      p_lease_seconds: 120,
    });
    if (claimError || claimed !== true) continue;

    // The work number may have been released or moved since the text arrived.
    // Answering from a line this workspace no longer owns is worse than silence.
    let ownerNow: string | null = null;
    try {
      const owned = await resolveOwnedWorkNumber(db, payload.toPhone);
      ownerNow = owned
        ? (await resolveWorkspaceOwnerForWorkNumber(db, owned.managerId, {
            throwOnError: true,
            workspaceId: owned.workspaceId ?? null,
          })).ownerUserId
        : null;
    } catch {
      ownerNow = null;
    }
    // `resolveOwnedWorkNumber` also returns null on a read error, so an
    // unresolved line is retried (bounded by the attempt cap), never dropped.
    if (ownerNow === null) {
      await finishInboundClaim(db, row.message_sid, inboundWorkerId, "retryable").catch(() => false);
      result.failed += 1;
      continue;
    }
    if (ownerNow !== row.manager_user_id || normalizeConsentPhone(payload.fromPhone) === null) {
      await finishInboundClaim(db, row.message_sid, inboundWorkerId, "completed").catch(() => false);
      result.dropped += 1;
      continue;
    }

    const response = await runClaimedInbound(db, {
      ...payload,
      messageSid: row.message_sid,
      managerId: row.manager_user_id,
      inboundWorkerId,
      mark: () => undefined,
    });
    if (response.status < 300) result.recovered += 1;
    else result.failed += 1;
  }
  return result;
}

async function processClaimedInbound(db: SupabaseClient, input: ClaimedInbound): Promise<NextResponse> {
  const { messageSid, managerId, fromPhone, toPhone, body, workspaceId, media, inboundWorkerId, mark } = input;
  // Preserve the incoming body before any billing read. An unavailable wallet
  // must not erase incoming communication while delivery retries are pending.
  const { error: inboundBodyError } = await db.from("inbound_sms_log").insert({
    manager_user_id: managerId, from_phone: fromPhone, to_phone: toPhone, body, message_sid: messageSid,
    ...inboundLogIdentityFields({ managerUserId: managerId, counterpartyRole: "unknown", fromPhone }),
  });
  if (inboundBodyError && inboundBodyError.code !== "23505") {
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: "Incoming message could not be saved." }, { status: 503 });
  }
  {
    const inboundSegments = estimateSmsSegments(body).segmentCount;
    await recordManagerCommsUsage(db, {
      managerUserId: managerId,
      meter: "sms_inbound_segment",
      quantity: inboundSegments,
      idempotencyKey: `sms_inbound:${messageSid}`,
      metadata: { messageSid },
    }).catch((error: unknown) => {
      // The body is already saved and the receipt claimed. Inbound cost is
      // unavoidable, so a wallet/RPC failure must never silence the reply:
      // an escaped throw here becomes an empty 500 Twilio never retries.
      // ponytail: the unbilled segment is dropped; add a reconcile sweep if it matters.
      const cause = error instanceof Error ? error.cause : undefined;
      console.warn("twilio inbound usage not recorded", messageSid, error instanceof Error ? error.message : String(error), cause);
    });
  }

  mark("logged");
  const replay = await loadInboundReplay(db, messageSid);
  mark("replay");
  if (!replay.ok) {
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: "Inbound replay state unavailable." }, { status: 503 });
  }

  /** Complete once a durable outbox row owns delivery; provider callbacks and
   * the dispatcher handle the rest, so Twilio must not rerun the agent turn. */
  const finishPreparedDelivery = async (
    receipt: SmsInboundReplay,
    delivered: { ok: boolean; error?: string; outboxId?: string; durablyAccepted?: boolean },
  ): Promise<NextResponse> => {
    const outboxId = receipt.outboxId ?? delivered.outboxId ?? null;
    if (outboxId && !receipt.outboxId) {
      const attached = await attachInboundOutbox(db, {
        messageSid,
        workerId: inboundWorkerId,
        outboxId,
      });
      if (!attached) {
        await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
        return NextResponse.json({ error: "Inbound outbox linkage unavailable." }, { status: 503 });
      }
    }
    if (outboxId || delivered.durablyAccepted || delivered.ok) {
      if (!(await finishInboundClaim(db, messageSid, inboundWorkerId, "completed"))) {
        return NextResponse.json({ error: "Inbound completion unavailable." }, { status: 503 });
      }
      return twimlOk();
    }
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: delivered.error ?? "Reply delivery failed." }, { status: 503 });
  };

  let managerInbound;
  try {
    managerInbound = await resolveManagerSmsInboundIdentity(db, {
      workNumberOwnerId: managerId, fromPhone, toPhone,
    });
  } catch {
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: "Manager identity unavailable." }, { status: 503 });
  }
  if (managerInbound) {
    const consent = await ensureManagerInboundReplyConsent(db, managerInbound, messageSid);
    if (consent === "unavailable") {
      await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
      return NextResponse.json({ error: "Reply consent unavailable." }, { status: 503 });
    }
    if (consent === "suppressed") {
      await finishInboundClaim(db, messageSid, inboundWorkerId, "completed");
      return twimlOk();
    }
  }

  // A prior worker completed the model/tool phase and persisted the exact
  // reply before transport. Re-send only that reply; never rerun the turn.
  if (replay.receipt?.replyBody) {
    if (replay.receipt.outboxId) {
      return finishPreparedDelivery(replay.receipt, {
        ok: true,
        outboxId: replay.receipt.outboxId,
        durablyAccepted: true,
      });
    }
    if (replay.receipt.routeKind === "manager_agent") {
      if (!managerInbound || managerInbound.actorUserId !== replay.receipt.counterpartyUserId) {
        await finishInboundClaim(db, messageSid, inboundWorkerId, "completed");
        return twimlOk();
      }
      const delivered = await deliverManagerSmsReply({
        managerUserId: managerId,
        actorUserId: managerInbound.actorUserId,
        toPhone: fromPhone,
        text: replay.receipt.replyBody,
        workNumber: normalizeE164(toPhone) ?? toPhone,
        inboundMessageSid: messageSid,
        traceId: replay.receipt.turnTraceId,
      });
      return finishPreparedDelivery(replay.receipt, delivered);
    }
    if (replay.receipt.routeKind === "resident_agent" && replay.receipt.counterpartyUserId) {
      const delivered = await deliverResidentSmsReply({
        ownerManagerUserId: managerId,
        residentUserId: replay.receipt.counterpartyUserId,
        toPhone: fromPhone,
        text: replay.receipt.replyBody,
        workNumber: normalizeE164(toPhone) ?? toPhone,
        inboundMessageSid: messageSid,
        traceId: replay.receipt.turnTraceId,
      });
      return finishPreparedDelivery(replay.receipt, delivered);
    }
    if (replay.receipt.routeKind === "leasing_agent" || replay.receipt.routeKind === "leasing_template") {
      const { deliverLeasingSmsReply } = await import("@/lib/agent/leasing-sms-agent.server");
      const delivered = await deliverLeasingSmsReply({
        landlordId: managerId,
        toPhone: fromPhone,
        text: replay.receipt.replyBody,
        workNumber: normalizeE164(toPhone) ?? toPhone,
        inboundMessageSid: messageSid,
        traceId: replay.receipt.turnTraceId,
      });
      return finishPreparedDelivery(replay.receipt, delivered);
    }
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: "Prepared inbound route unavailable." }, { status: 503 });
  }

  const workNumber = normalizeE164(toPhone) ?? toPhone;
  // Manager fork. When the sender is the work-number owner's verified cell, or
  // a verified co-manager of that owner, hand them the manager assistant rather
  // than treating them as a resident/prospect.
  //
  // `resolveManagerSmsInboundIdentity` is the identity gate (work number pins
  // the owner, then a verified `profiles.phone` must match `From` as that owner
  // or an assigned co-manager); the context resolver only fills in roles. On any
  // failure stay silent rather than texting an error to a phone we could not
  // attribute.
  mark("identity");
  if (managerInbound) {
    mark("route:manager");
    const managerIdentity = await resolveManagerSmsAgentContext(db, {
      managerUserId: managerInbound.workNumberOwnerId,
      actorUserId: managerInbound.actorUserId,
      access: managerInbound.access,
      workspaceId: workspaceId,
    });
    const turn = managerIdentity.ok
      ? await runManagerSmsAgentTurn(db, {
          ctx: managerIdentity.ctx,
          managerPhoneE164: normalizeE164(fromPhone) ?? fromPhone,
          inboundText: body,
          inboundMessageSid: messageSid,
          onInboundPersisted: async () => {
            const { error } = await db
              .from("inbound_sms_log")
              .delete()
              .eq("message_sid", messageSid)
              .eq("manager_user_id", managerId);
            return !error;
          },
        }).catch((error: unknown) => {
          console.error("twilio inbound manager assistant turn failed", error instanceof Error ? error.message : error);
          return null;
        })
      : null;
    if (!managerIdentity.ok) {
      console.info("twilio inbound manager agent identity unresolved", {
        managerUserId: managerId,
        actorUserId: managerInbound.actorUserId,
        reason: managerIdentity.reason,
      });
      if (managerIdentity.reason !== "lookup_failed") {
        const { error: cleanupError } = await db
          .from("inbound_sms_log")
          .delete()
          .eq("message_sid", messageSid)
          .eq("manager_user_id", managerId);
        if (!cleanupError && await finishInboundClaim(db, messageSid, inboundWorkerId, "completed")) {
          return twimlOk();
        }
      }
    }
    if (turn?.reply) {
      const prepared = await prepareInboundReply(db, {
        messageSid,
        workerId: inboundWorkerId,
        routeKind: "manager_agent",
        counterpartyUserId: managerInbound.actorUserId,
        agentSessionId: turn.sessionId,
        inboundAgentMessageId: turn.inboundMessageId,
        assistantAgentMessageId: turn.assistantMessageId,
        pendingActionId: turn.pendingActionId,
        turnTraceId: turn.traceId,
        replyBody: turn.reply,
      });
      if (!prepared) {
        await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
        return NextResponse.json({ error: "Reply preparation failed." }, { status: 503 });
      }
      const delivered = await deliverManagerSmsReply({
        managerUserId: managerInbound.workNumberOwnerId,
        actorUserId: managerInbound.actorUserId,
        toPhone: fromPhone,
        text: turn.reply,
        workNumber,
        inboundMessageSid: messageSid,
        traceId: turn.traceId,
      });
      const finished = await finishPreparedDelivery(
        {
          status: "processing",
          routeKind: "manager_agent",
          counterpartyUserId: managerInbound.actorUserId,
          agentSessionId: turn.sessionId,
          inboundAgentMessageId: turn.inboundMessageId ?? null,
          assistantAgentMessageId: turn.assistantMessageId ?? null,
          pendingActionId: turn.pendingActionId ?? null,
          turnTraceId: turn.traceId ?? null,
          replyBody: turn.reply,
          outboxId: null,
        },
        delivered,
      );
      if (finished.status !== 200) return finished;
    }
    if (turn) {
      if (!(await finishInboundClaim(db, messageSid, inboundWorkerId, "completed"))) {
        return NextResponse.json({ error: "Inbound completion unavailable." }, { status: 503 });
      }
      return twimlOk();
    }
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: "Manager assistant turn unavailable." }, { status: 503 });
  }

  // The destination work number scopes vendor sessions before a prospect fallback.
  const { resolveVendorAgentSessionForInbound, runVendorAgentSessionTurn } = await import("@/lib/agent/vendor-agent.server");
  const vendor = await resolveVendorAgentSessionForInbound(db, normalizeE164(fromPhone) ?? fromPhone, body, managerId);
  mark(`vendor:${vendor.kind}`);
  if (vendor.kind !== "unknown_phone") {
    await db.from("inbound_sms_log").update({ matched_sender_user_id: vendor.session.vendor_user_id,
      ...inboundLogIdentityFields({ managerUserId: managerId, counterpartyRole: "vendor", counterpartyUserId: vendor.session.vendor_user_id, fromPhone })
    }).eq("message_sid", messageSid).eq("manager_user_id", managerId);
    await runVendorAgentSessionTurn(db, vendor.session, body, "sms", { inboundMessageSid: messageSid,
      precomputedReply: vendor.kind === "reply" ? vendor.reply : null, reference: vendor.kind === "session" ? vendor.reference : null });
    if (!(await finishInboundClaim(db, messageSid, inboundWorkerId, "completed"))) throw new Error("Vendor inbound completion unavailable.");
    return twimlOk();
  }

  // Resident fork. A texter is only handed the resident tool catalog when their
  // phone is VERIFIED on a profile AND the owner of the work number they texted
  // is one of that resident's managers — both enforced inside
  // `resolveResidentSmsAgentContext`. Everyone else (prospects, unverified or
  // recycled numbers, someone texting the wrong manager) falls through to the
  // leasing agent below, which holds no personal data. That fall-through is why
  // this fork cannot regress today's behaviour for anyone.
  const residentIdentity = await resolveResidentSmsAgentContext(db, {
    fromPhone,
    ownerManagerUserId: managerId,
  });
  mark(residentIdentity.ok ? "route:resident" : "route:leasing");
  if (residentIdentity.ok) {
    await upsertManagerSmsContact(db, {
      managerUserId: managerId,
      phone: fromPhone,
      counterpartyRole: "resident",
      lastInboundAt: new Date().toISOString(),
    }).catch(() => ({ ok: false as const, error: "contact_upsert_failed" }));
    // Photo intake is additive. Every failure inside it (unconfigured Twilio
    // credentials, an oversized or unreadable media part, an unexpected redirect
    // host) must degrade to text-only rather than abort the turn — otherwise the
    // resident's message is never answered and Twilio retries the whole webhook.
    let photoRefs: string[] = [];
    let photoIntakeFailed = false;
    try {
      photoRefs = await intakeResidentSmsPhotos(db, {
        userId: residentIdentity.ctx.userId,
        ownerId: managerId,
        messageSid,
        params: media,
      });
    } catch (error) {
      photoIntakeFailed = (Number(media.NumMedia) || 0) > 0;
      console.error("twilio inbound resident photo intake failed", {
        manager: managerId,
        messageSid,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    const photoPrefix = photoRefs.length
      ? `Private inspection photo sources (not filed): ${photoRefs.join(", ")}. Ask which inspection/section if unclear; use file_inspection_photo with confirmation.\n`
      : photoIntakeFailed
        ? "The resident attached photos but they could not be received. Answer the text, say the photos did not come through, and ask them to resend or upload in the portal.\n"
        : "";
    const turn = await runResidentSmsAgentTurn(db, {
      ctx: residentIdentity.ctx,
      ownerManagerUserId: managerId,
      residentPhoneE164: normalizeE164(fromPhone) ?? fromPhone,
      inboundText: `${photoPrefix}${body}`,
      inboundMessageSid: messageSid,
    });
    if (turn) {
      const prepared = await prepareInboundReply(db, {
        messageSid,
        workerId: inboundWorkerId,
        routeKind: "resident_agent",
        counterpartyUserId: residentIdentity.ctx.userId,
        agentSessionId: turn.sessionId,
        inboundAgentMessageId: turn.inboundMessageId,
        assistantAgentMessageId: turn.assistantMessageId,
        pendingActionId: turn.pendingActionId,
        turnTraceId: turn.traceId,
        replyBody: turn.reply,
      });
      if (!prepared) {
        await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
        return NextResponse.json({ error: "Reply preparation failed." }, { status: 503 });
      }
      const delivered = await deliverResidentSmsReply({
        ownerManagerUserId: managerId,
        residentUserId: residentIdentity.ctx.userId,
        toPhone: fromPhone,
        text: turn.reply,
        workNumber,
        inboundMessageSid: messageSid,
        traceId: turn.traceId,
      });
      const finished = await finishPreparedDelivery(
        {
          status: "processing",
          routeKind: "resident_agent",
          counterpartyUserId: residentIdentity.ctx.userId,
          agentSessionId: turn.sessionId,
          inboundAgentMessageId: turn.inboundMessageId ?? null,
          assistantAgentMessageId: turn.assistantMessageId ?? null,
          pendingActionId: turn.pendingActionId ?? null,
          turnTraceId: turn.traceId ?? null,
          replyBody: turn.reply,
          outboxId: null,
        },
        delivered,
      );
      if (finished.status !== 200) return finished;
    }
    await db
      .from("inbound_sms_log")
      .update({
        manager_user_id: managerId,
        from_phone: fromPhone,
        to_phone: toPhone,
        matched_sender_user_id: residentIdentity.ctx.userId,
        body,
        message_sid: messageSid,
        ...inboundLogIdentityFields({
          managerUserId: managerId,
          counterpartyRole: "resident",
          counterpartyUserId: residentIdentity.ctx.userId,
          fromPhone,
        }),
      }).eq("message_sid", messageSid).eq("manager_user_id", managerId)
      .then(() => undefined, () => undefined);

    // Leg 1 for the resident agent fork. Without this, only prospect/leasing
    // traffic reached the manager's cell and a known resident's text — the one
    // most likely to need a human — was portal-only.
    if (!isClawSharedLineBridgeEnabled()) {
      await forwardResidentInboundToManagerCell(db, {
        managerUserId: managerId,
        workNumber,
        fromPhone,
        body,
        messageSid,
        counterpartyRole: "resident",
      }).catch(() => undefined);
    }
    if (turn) return twimlOk();
    if (!(await finishInboundClaim(db, messageSid, inboundWorkerId, "completed"))) {
      return NextResponse.json({ error: "Inbound completion unavailable." }, { status: 503 });
    }
    return twimlOk();
  }

  let handled;
  try {
    await upsertManagerSmsContact(db, {
      managerUserId: managerId,
      phone: fromPhone,
      counterpartyRole: "prospect",
      lastInboundAt: new Date().toISOString(),
    }).catch(() => ({ ok: false as const, error: "contact_upsert_failed" }));
    // A work number is the WORKSPACE's front door. A co-manager's line leases
    // the owner's houses — tenant records stay with the property owner, the
    // reply still goes out from the line that was texted — instead of turning
    // every prospect away with a "message your property manager" notice.
    const workspace = await resolveWorkspaceOwnerForWorkNumber(db, managerId, {
      throwOnError: true,
      workspaceId: workspaceId,
    });
    mark("leasing-start");
    handled = await handleClawLeasingInbound({
      from: fromPhone,
      text: body,
      messageId: messageSid,
      managerUserId: workspace.ownerUserId,
      workNumber,
      service: "SMS",
      durablyClaimed: true,
      onPreparedReply: (prepared) =>
        prepareInboundReply(db, {
          messageSid,
          workerId: inboundWorkerId,
          routeKind: prepared.routeKind,
          agentSessionId: prepared.agentSessionId,
          inboundAgentMessageId: prepared.inboundAgentMessageId,
          assistantAgentMessageId: prepared.assistantAgentMessageId,
          turnTraceId: prepared.turnTraceId,
          replyBody: prepared.replyBody,
        }),
    });
  } catch (e) {
    console.error("twilio inbound leasing handler failed", managerId, e);
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: "Inbound processing failed." }, { status: 503 });
  }
  mark("leasing-done");
  if (!handled.ok) {
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: handled.error ?? "Inbound processing failed." }, { status: 503 });
  }
  const inlineBurst = handled.inlineBurst;
  if (inlineBurst) {
    mark("inline-burst");
    after(() => runInlineProspectBurst(createSupabaseServiceRoleClient(), inlineBurst));
  }
  if (handled.outboxId) {
    const attached = await attachInboundOutbox(db, {
      messageSid,
      workerId: inboundWorkerId,
      outboxId: handled.outboxId,
    });
    if (!attached) {
      await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
      return NextResponse.json({ error: "Inbound outbox linkage unavailable." }, { status: 503 });
    }
  }

  // Leg 1 — forward the resident's text to the manager's own cell (labelled,
  // never the raw number). Only in the per-manager Twilio regime; the Claw
  // shared line has its own forward path, so this avoids a double forward.
  if (!isClawSharedLineBridgeEnabled()) {
    // The leasing responder handles prospects and anyone whose resident thread
    // could not be opened, so this mirror must not invite a texted-back reply.
    await forwardResidentInboundToManagerCell(db, {
      managerUserId: managerId,
      workNumber,
      fromPhone,
      body,
      messageSid,
      counterpartyRole: "prospect",
    }).catch(() => undefined);
  }

  // Belt-and-suspenders for the rare path where the leasing handler resolved no
  // identity at all: the body-preservation insert left `counterparty_role` as
  // `unknown`, so claim ONLY a row still carrying that placeholder. The handler
  // resolves residents on this same line, and overwriting its resolved identity
  // would rethread a resident's message into a prospect conversation.
  await db
    .from("inbound_sms_log")
    .update({
      manager_user_id: managerId,
      from_phone: fromPhone,
      to_phone: toPhone,
      matched_sender_user_id: null,
      body,
      message_sid: messageSid,
      ...inboundLogIdentityFields({ managerUserId: managerId, fromPhone }),
    })
    .eq("message_sid", messageSid)
    .eq("manager_user_id", managerId)
    .eq("counterparty_role", "unknown")
    .then(() => undefined, () => undefined);

  if (!(await finishInboundClaim(db, messageSid, inboundWorkerId, "completed"))) {
    return NextResponse.json({ error: "Inbound completion unavailable." }, { status: 503 });
  }

  return twimlOk();
}
