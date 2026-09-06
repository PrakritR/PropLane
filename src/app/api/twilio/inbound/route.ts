import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { handleClawLeasingInbound } from "@/lib/claw-leasing-bot.server";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeConsentPhone, readSmsSuppressionState } from "@/lib/sms-consent";
import { isClawSharedLineBridgeEnabled } from "@/lib/claw-leasing-links";
import { forwardResidentInboundToManagerCell } from "@/lib/sms/manager-relay.server";
import { resolveManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";
import {
  deliverManagerSmsReply,
  runManagerSmsAgentTurn,
} from "@/lib/agent/manager-sms-agent.server";
import { twilioMediaUrls } from "@/lib/sms-media.server";
import { inboundLogIdentityFields } from "@/lib/manager-sms-messages.server";
import { relayInboundSms } from "@/lib/sms-relay.server";
import { resolveResidentSmsAgentContext } from "@/lib/tools/resident-sms-context";
import {
  deliverResidentSmsReply,
  runResidentSmsAgentTurn,
} from "@/lib/agent/resident-sms-agent.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";
import { fetchTwilioMessageCreatedAt, twilioWebhookAuthToken } from "@/lib/twilio-client.server";
import {
  attachInboundOutbox,
  finishInboundClaim,
  loadInboundReplay,
  prepareInboundReply,
  type SmsInboundReplay,
} from "@/lib/sms/inbound-replay.server";
import { upsertManagerSmsContact } from "@/lib/sms/manager-sms-contacts.server";
import { evaluateManagerCommsBillingGate } from "@/lib/comms-billing/eligibility.server";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Standard carrier/Twilio SMS control keywords. Twilio's Advanced Opt-Out sends
 * the compliance auto-replies; Axis records the resulting consent state so it
 * never texts an opted-out number again, and never leaks a control message into
 * anyone's inbox. Matched case-insensitively against the entire trimmed body.
 */
const SMS_STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const SMS_START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const SMS_HELP_KEYWORDS = new Set(["HELP", "INFO"]);

function digitsOf(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Common storage formats for one US number, for direct-column matching. */
function phoneVariants(raw: string): string[] {
  const d = digitsOf(raw);
  if (d.length !== 10) return [raw.trim()].filter(Boolean);
  return [
    `+1${d}`,
    d,
    `1${d}`,
    `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,
    `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,
    raw.trim(),
  ].filter(Boolean);
}

async function resolveOwnedWorkNumber(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  toPhone: string,
): Promise<{ managerId: string; messagingServiceSid: string } | null> {
  const expectedServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!expectedServiceSid) return null;
  const { data, error } = await db
    .from("manager_sms_numbers")
    .select("manager_user_id, messaging_service_sid, provision_state, grace_expires_at, updated_at")
    .in("phone_number", phoneVariants(toPhone))
    .eq("messaging_service_sid", expectedServiceSid)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (error) return null;
  const candidates = (data ?? []).filter((row) => {
    const graceActive = row.grace_expires_at && Date.parse(String(row.grace_expires_at)) > Date.now();
    return row.provision_state === "active" || row.provision_state === "provisioning" || graceActive;
  });
  // A recycled or duplicated assignment is unsafe to guess. Fail closed until
  // the control plane has one authoritative current owner.
  if (candidates.length !== 1) return null;
  const row = candidates[0];
  const managerId = String(row.manager_user_id ?? "").trim();
  return managerId ? { managerId, messagingServiceSid: expectedServiceSid } : null;
}

/** Empty TwiML — replies are sent asynchronously via the Messaging API. */
function twimlOk(reply?: string): NextResponse {
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

/**
 * Twilio inbound SMS webhook for manager work numbers.
 *
 * Any From phone is accepted (no allowlist). Managed-runtime messages route
 * through the durable receipt claim and then leasing bot / resident intents /
 * manager agent commands. The legacy relay pool is runtime-off only.
 *
 * Configure in Twilio: Messaging webhook → POST https://<host>/api/twilio/inbound
 * (must match TWILIO_WEBHOOK_URL when set, for signature validation).
 */
export async function POST(req: Request) {
  const authToken = twilioWebhookAuthToken();
  if (!authToken) return NextResponse.json({ error: "SMS not configured." }, { status: 503 });

  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw));

  // Signature check — reject spoofed webhook calls. Fail closed on Vercel.
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const url = process.env.TWILIO_WEBHOOK_URL?.trim() || req.url;
  const failClosed = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  if (!signature) {
    if (failClosed) return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  } else if (!twilio.validateRequest(authToken, signature, url, params)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }

  const fromPhone = String(params.From ?? "").trim();
  const toPhone = String(params.To ?? "").trim();
  const body = String(params.Body ?? "").trim();
  const messageSid = String(params.MessageSid ?? "").trim() || null;
  if (!fromPhone || !toPhone) return twimlOk();

  const db = createSupabaseServiceRoleClient();
  const ownedNumber = await resolveOwnedWorkNumber(db, toPhone);

  // Compliance controls run before traffic shedding so a legitimate STOP can
  // never be discarded by the ordinary inbound rate limiter.
  const keyword = body.toUpperCase();
  let controlKeyword: "STOP" | "START" | "HELP" | null = SMS_STOP_KEYWORDS.has(keyword)
    ? "STOP"
    : SMS_START_KEYWORDS.has(keyword)
      ? "START"
      : SMS_HELP_KEYWORDS.has(keyword)
        ? "HELP"
        : null;

  // "YES" is both a carrier opt-in synonym and the natural way to approve an
  // agent proposal by text. Compliance runs first, so without this the reply a
  // resident sends to confirm a rent payment is silently eaten as an opt-in and
  // the proposal is never confirmed.
  //
  // Precedence is resolved by STATE, not by guessing intent: opting in is only
  // meaningful for a phone that is currently opted OUT, and a suppressed phone
  // was never sent a proposal in the first place. So START keeps priority while
  // suppressed, and otherwise the message falls through to the agent. STOP and
  // HELP are never reinterpreted — those must work unconditionally.
  if (controlKeyword === "START") {
    const suppression = await readSmsSuppressionState(db, fromPhone);
    // Unreadable suppression falls back to carrier handling: treating an
    // unknown state as "not opted out" could swallow a genuine opt-in.
    if (suppression.ok && !suppression.optedOut) controlKeyword = null;
  }

  if (controlKeyword) {
    const phoneKey = normalizeConsentPhone(fromPhone);
    if (!messageSid || !phoneKey) {
      return NextResponse.json({ error: "Invalid control message." }, { status: 400 });
    }
    const providerOccurredAt = await fetchTwilioMessageCreatedAt(messageSid);
    if (!providerOccurredAt) {
      return NextResponse.json({ error: "Control message time unavailable." }, { status: 503 });
    }
    const { error: controlError } = await db.rpc("apply_sms_control_keyword", {
      p_message_sid: messageSid,
      p_recipient_phone_key: phoneKey,
      p_keyword: controlKeyword,
      p_provider_occurred_at: providerOccurredAt,
      p_manager_user_id: ownedNumber?.managerId ?? null,
      p_messaging_service_sid: ownedNumber?.messagingServiceSid ?? null,
    });
    if (controlError) {
      // Non-2xx asks Twilio to retry; the RPC is atomic and MessageSid-unique.
      return NextResponse.json({ error: "Control receipt unavailable." }, { status: 503 });
    }
    return twimlOk();
  }

  // The legacy pooled proxy relay predates the durable inbound receipt state
  // machine. It is deliberately excluded from the managed work-number launch:
  // otherwise a crash between its relay legs could acknowledge a partially
  // delivered message. Runtime-off installations retain the legacy behavior.
  if (process.env.SMS_RUNTIME_ENABLED?.trim() !== "1") {
    const limit = await rateLimit(`twilio-inbound:${fromPhone}`, 20, 60_000);
    if (limit.unavailable) return NextResponse.json({ error: "Rate limit store unavailable." }, { status: 503 });
    if (!limit.ok) {
      return twimlOk();
    }
    const mediaUrls = twilioMediaUrls(params);
    const relay = await relayInboundSms(db, { fromPhone, toPhone, body, messageSid, mediaUrls });
    if (relay.handled) {
      await db
        .from("inbound_sms_log")
        .insert({
          manager_user_id: relay.managerUserId ?? null,
          from_phone: fromPhone,
          to_phone: toPhone,
          matched_sender_user_id: relay.senderUserId ?? null,
          body,
          message_sid: messageSid,
          // Proxy-pair relay is always a bound resident ↔ manager thread.
          ...inboundLogIdentityFields({
            managerUserId: relay.managerUserId ?? null,
            counterpartyRole: "resident",
            counterpartyUserId: relay.senderUserId ?? null,
            fromPhone,
          }),
        })
        .then(() => undefined, () => undefined);
      return twimlOk(relay.reply);
    }
  }

  const managerId = ownedNumber?.managerId ?? "";
  if (!managerId) {
    const limit = await rateLimit(`twilio-inbound:${fromPhone}`, 20, 60_000);
    if (limit.unavailable) return NextResponse.json({ error: "Rate limit store unavailable." }, { status: 503 });
    if (!limit.ok) {
      return twimlOk();
    }
    await db
      .from("inbound_sms_log")
      .insert({
        from_phone: fromPhone,
        to_phone: toPhone,
        body,
        message_sid: messageSid,
        ...inboundLogIdentityFields({ managerUserId: null, counterpartyRole: "unknown", fromPhone }),
      })
      .then(() => undefined, () => undefined);
    return twimlOk();
  }

  if (isCommsPaygBillingEnabled()) {
    const billing = await evaluateManagerCommsBillingGate(db, managerId);
    if (!billing.allowed) {
      return twimlOk(
        "This number cannot receive messages right now. Please contact your property manager directly.",
      );
    }
  }

  if (!messageSid) {
    return NextResponse.json({ error: "MessageSid is required." }, { status: 400 });
  }
  const inboundPhoneKey = normalizeConsentPhone(fromPhone);
  if (!inboundPhoneKey) {
    return NextResponse.json({ error: "Invalid sender phone." }, { status: 400 });
  }

  // Count a provider MessageSid against the abuse limit only before its first
  // durable receipt exists. Twilio retries of a failed/leased message must not
  // consume the sender's quota and then get acknowledged before replay can
  // finish; that would turn a retry storm into silent message loss.
  const replayBeforeClaim = await loadInboundReplay(db, messageSid);
  if (!replayBeforeClaim.ok) {
    return NextResponse.json({ error: "Inbound replay state unavailable." }, { status: 503 });
  }
  if (!replayBeforeClaim.receipt) {
    const limit = await rateLimit(`twilio-inbound:${fromPhone}`, 20, 60_000);
    if (limit.unavailable) return NextResponse.json({ error: "Rate limit store unavailable." }, { status: 503 });
    if (!limit.ok) return twimlOk();
  }
  const inboundWorkerId = `inbound-${randomUUID()}`;
  const { data: inboundClaimed, error: inboundClaimError } = await db.rpc("claim_sms_inbound", {
    p_message_sid: messageSid,
    p_manager_user_id: managerId,
    p_recipient_phone_key: inboundPhoneKey,
    p_worker_id: inboundWorkerId,
    p_lease_seconds: 120,
  });
  if (inboundClaimError) {
    return NextResponse.json({ error: "Inbound receipt unavailable." }, { status: 503 });
  }
  if (inboundClaimed !== true) {
    // `false` can mean either a completed replay OR another worker/failed
    // completion still owns the lease. Acknowledging both would make Twilio
    // stop retrying a message whose reply was never durably completed.
    const { data: receipt, error: receiptError } = await db
      .from("sms_inbound_receipts")
      .select("status")
      .eq("message_sid", messageSid)
      .maybeSingle();
    if (receiptError || receipt?.status !== "completed") {
      return NextResponse.json({ error: "Inbound processing is still pending." }, { status: 503 });
    }
    return twimlOk();
  }

  if (isCommsPaygBillingEnabled()) {
    const inboundSegments = estimateSmsSegments(body).segmentCount;
    await recordManagerCommsUsage(db, {
      managerUserId: managerId,
      meter: "sms_inbound_segment",
      quantity: inboundSegments,
      idempotencyKey: `sms_inbound:${messageSid}`,
      metadata: { messageSid },
    });
  }

  const replay = await loadInboundReplay(db, messageSid);
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
      const delivered = await deliverManagerSmsReply({
        managerUserId: managerId,
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
  const managerInbound = await resolveManagerSmsInboundIdentity(db, {
    workNumberOwnerId: managerId,
    fromPhone,
    toPhone,
  });
  if (managerInbound) {
    const managerIdentity = await resolveManagerSmsAgentContext(db, {
      managerUserId: managerInbound.workNumberOwnerId,
      actorUserId: managerInbound.actorUserId,
      access: managerInbound.access,
    });
    const turn = managerIdentity.ok
      ? await runManagerSmsAgentTurn(db, {
          ctx: managerIdentity.ctx,
          managerPhoneE164: normalizeE164(fromPhone) ?? fromPhone,
          inboundText: body,
          inboundMessageSid: messageSid,
        })
      : null;
    if (!managerIdentity.ok) {
      console.info("twilio inbound manager agent identity unresolved", {
        managerUserId: managerId,
        actorUserId: managerInbound.actorUserId,
        reason: managerIdentity.reason,
      });
    }
    if (turn) {
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
    await db
      .from("inbound_sms_log")
      .insert({
        manager_user_id: managerId,
        from_phone: fromPhone,
        to_phone: toPhone,
        matched_sender_user_id: managerInbound.actorUserId,
        body,
        message_sid: messageSid,
        ...inboundLogIdentityFields({ managerUserId: managerId, counterpartyRole: "manager", fromPhone }),
      })
      .then(() => undefined, () => undefined);
    if (turn) return twimlOk();
    if (!(await finishInboundClaim(db, messageSid, inboundWorkerId, "completed"))) {
      return NextResponse.json({ error: "Inbound completion unavailable." }, { status: 503 });
    }
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
  if (residentIdentity.ok) {
    await upsertManagerSmsContact(db, {
      managerUserId: managerId,
      phone: fromPhone,
      counterpartyRole: "resident",
      lastInboundAt: new Date().toISOString(),
    }).catch(() => ({ ok: false as const, error: "contact_upsert_failed" }));
    const turn = await runResidentSmsAgentTurn(db, {
      ctx: residentIdentity.ctx,
      ownerManagerUserId: managerId,
      residentPhoneE164: normalizeE164(fromPhone) ?? fromPhone,
      inboundText: body,
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
      .insert({
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
      })
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
    handled = await handleClawLeasingInbound({
      from: fromPhone,
      text: body,
      messageId: messageSid,
      managerUserId: managerId,
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
  if (!handled.ok) {
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable");
    return NextResponse.json({ error: handled.error ?? "Inbound processing failed." }, { status: 503 });
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

  // Belt-and-suspenders: the leasing handler already logs inbound with its
  // resolved role (this insert dedups on the unique message_sid). Populate the
  // identity fields anyway for the rare path where the handler logged nothing.
  await db
    .from("inbound_sms_log")
    .insert({
      manager_user_id: managerId,
      from_phone: fromPhone,
      to_phone: toPhone,
      matched_sender_user_id: null,
      body,
      message_sid: messageSid,
      ...inboundLogIdentityFields({ managerUserId: managerId, fromPhone }),
    })
    .then(() => undefined, () => undefined);

  if (!(await finishInboundClaim(db, messageSid, inboundWorkerId, "completed"))) {
    return NextResponse.json({ error: "Inbound completion unavailable." }, { status: 503 });
  }

  return twimlOk();
}
