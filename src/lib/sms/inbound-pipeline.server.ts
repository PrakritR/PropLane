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
import { buildConversationKey, type SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import {
  finishSmsProjectionRetry,
  listPendingSmsProjectionRetries,
  projectOriginalEvent,
  resolveSmsProjectionWorkLine,
  type SmsProjectionEventInput,
  type SmsProjectionSourceIntent,
} from "@/lib/sms/sms-projection.server";
import { projectManagerSmsEvent } from "@/lib/sms/project-manager-sms-event.server";
import { resolveInboundOriginal } from "@/lib/sms/resolve-inbound-original.server";
import { samePostgresInstant } from "@/lib/sms/postgres-instant.mjs";
import { isTwilioMessageSid } from "@/lib/sms/message-sid";
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

export type SmsProjectionRecoveryResult = { scanned: number; projected: number; failed: number };

function isSourceIntent(event: SmsProjectionEventInput | SmsProjectionSourceIntent): event is SmsProjectionSourceIntent {
  return (event.sourceRef?.table === "sms_inbound_receipts" || event.sourceRef?.table === "manager_sms_messages") && !("sourceEventId" in event);
}

/** Rebuild from the receipt on every attempt. Queued classification and time
 * are hints; the immutable webhook envelope remains the source of truth. */
async function hydrateReceiptRetry(
  db: SupabaseClient,
  ownerManagerUserId: string,
  sid: string,
  prior?: SmsProjectionEventInput,
  managerSourceRef?: Record<string, unknown>,
): Promise<SmsProjectionEventInput | null> {
  // Prospect bursts belong to the workspace owner even when a co-manager
  // holds the number and therefore owns the receipt/repair marker.
  const { data: ingressRows, error: ingressError } = await db.from("prospect_sms_ingress")
    .select("manager_user_id")
    .eq("source_message_id", sid).eq("channel", "twilio").limit(2);
  if (ingressError) throw new Error("receipt_ingress_unavailable");
  if ((ingressRows?.length ?? 0) > 1) throw new Error("receipt_ingress_ambiguous");
  const ingress = ingressRows?.[0];
  const projectedOwnerId = ingress ? String(ingress.manager_user_id) : ownerManagerUserId;
  const original = await resolveInboundOriginal(db, sid, projectedOwnerId);
  const receiptManagerId = original.receiptOwner;
  const { body, fromPhone, toPhone, occurredAt } = original;
  if (ownerManagerUserId !== receiptManagerId && ownerManagerUserId !== projectedOwnerId) {
    throw new Error("receipt_owner_mismatch");
  }
  if (original.ingress !== Boolean(ingress)) throw new Error("receipt_ingress_integrity_conflict");
  if (original.owner !== projectedOwnerId) throw new Error("receipt_owner_mismatch");
  const managerRef = managerSourceRef ?? (prior?.sourceRef?.table === "manager_sms_messages" ? prior.sourceRef : undefined);
  if (managerRef) {
    if (original.status !== "completed" || managerRef.table !== "manager_sms_messages" ||
        (managerRef.id !== undefined && typeof managerRef.id !== "string") ||
        (managerRef.source !== undefined && typeof managerRef.source !== "string") ||
        (managerRef.id === undefined && managerRef.source === undefined)) {
      throw new Error("receipt_manager_source_invalid");
    }
    const { data: rows, error } = await db.from("manager_sms_messages")
      .select("id,manager_user_id,message_sid,direction,body,from_phone,to_phone,created_at,resident_phone,resident_user_id,counterparty_role,source")
      .eq("manager_user_id", projectedOwnerId).eq("message_sid", sid).limit(2);
    if (error) throw new Error("receipt_projection_source_unavailable");
    if ((rows?.length ?? 0) > 1) throw new Error("receipt_projection_source_ambiguous");
    const row = rows?.[0];
    if (!row || row.manager_user_id !== projectedOwnerId || row.message_sid !== sid ||
        (managerRef.id !== undefined && row.id !== managerRef.id) ||
        (managerRef.source !== undefined && row.source !== managerRef.source) ||
        row.direction !== "inbound" || row.body !== body ||
        row.from_phone !== fromPhone || row.to_phone !== toPhone ||
        row.resident_phone !== fromPhone || row.counterparty_role !== original.role ||
        row.resident_user_id !== original.userId ||
        !samePostgresInstant(row.created_at, occurredAt)) {
      throw new Error("receipt_manager_source_conflict");
    }
  }
  if (prior && managerRef &&
      (prior.ownerManagerUserId !== projectedOwnerId || prior.sourceEventId !== sid ||
       prior.direction !== "inbound" ||
       prior.sourceNamespace !== `twilio:${projectedOwnerId}:${process.env.TWILIO_ACCOUNT_SID?.trim() || "unconfigured"}` ||
       prior.body !== body || !samePostgresInstant(prior.occurredAt, occurredAt) ||
       prior.fromPhone !== fromPhone || prior.toPhone !== toPhone ||
       prior.counterpartyPhone !== fromPhone ||
       prior.counterpartyRole !== original.role || prior.counterpartyUserId !== original.userId ||
       prior.identityKind !== (original.userId ? "user" : original.role === "unknown" ? "unresolved" : "phone") ||
       prior.identityKey !== (original.userId ? `user:${original.userId}` : original.role === "unknown" ? `unresolved:${sid}` : `phone:${fromPhone}`))) {
    throw new Error("receipt_queued_envelope_conflict");
  }
  const queuedEnvelopeBound = Boolean(prior &&
    prior.ownerManagerUserId === projectedOwnerId && prior.sourceEventId === sid &&
    prior.sourceRef?.table === "sms_inbound_receipts" && prior.sourceRef.id === sid &&
    prior.direction === "inbound" &&
    prior.sourceNamespace === `twilio:${projectedOwnerId}:${process.env.TWILIO_ACCOUNT_SID?.trim() || "unconfigured"}` &&
    prior.body === body && samePostgresInstant(prior.occurredAt, occurredAt) &&
    prior.fromPhone === fromPhone && prior.toPhone === toPhone);
  if (prior && !managerRef && (prior.counterpartyRole !== "unknown" || prior.counterpartyUserId) && !queuedEnvelopeBound) {
    throw new Error("receipt_queued_envelope_conflict");
  }
  if (prior && ((prior.counterpartyRole !== "unknown" && original.role !== "unknown" && prior.counterpartyRole !== original.role) ||
      (prior.counterpartyUserId && original.userId && prior.counterpartyUserId !== original.userId))) {
    throw new Error("receipt_classification_conflict");
  }
  // A classified producer can enrich a still-pending receipt whose durable
  // source has no user identity. A null source identity is unknown, not a
  // contradictory person; the exact queued envelope is required above.
  const queuedRoleEnrichment = Boolean(prior && prior.counterpartyRole !== "unknown" && original.role === "unknown");
  const queuedUserEnrichment = Boolean(prior?.counterpartyUserId && !original.userId);
  if ((queuedRoleEnrichment || queuedUserEnrichment) &&
      (!queuedEnvelopeBound || original.source !== "receipt_payload" || original.status === "completed" ||
       original.role === "prospect" ||
       (queuedUserEnrichment && prior?.counterpartyRole === "unknown"))) {
    throw new Error("receipt_classification_unproven");
  }
  const line = await resolveSmsProjectionWorkLine(db, {
    ownerManagerUserId: projectedOwnerId, phoneNumber: toPhone, occurredAt,
  });
  if (!line) throw new Error("receipt_work_line_unresolved");
  if (original.workLineId && line.workLineId !== original.workLineId) throw new Error("receipt_work_line_conflict");
  if (prior && managerRef && prior.workLineId && prior.workLineId !== line.workLineId) {
    throw new Error("receipt_work_line_conflict");
  }
  // The receipt trigger creates its repair intent before the inbound worker
  // identifies the sender. Do not publish one unresolved conversation per SID
  // while that worker (or a queued burst) is still processing the messages.
  // A classified producer retry may proceed; terminal unhandled receipts still
  // become visible, even if their identity remains unresolved.
  if (!prior && original.status !== "completed") {
    throw new Error("receipt_classification_pending");
  }
  // A completed live producer may already have recorded a more specific role.
  // Exact provider SID + immutable bytes/time makes the receipt intent done.
  const { data: existing, error: existingError } = await db.from("sms_projection_turns")
    .select("owner_manager_user_id,conversation_id,source_namespace,source_event_id,provider_sid,direction,body,occurred_at,from_phone,to_phone,source_ref")
    .eq("provider_sid", sid).limit(2);
  if (existingError) throw new Error("projection_lookup_unavailable");
  if ((existing?.length ?? 0) > 1) throw new Error("receipt_projection_sid_collision");
  if (existing?.length) {
    const turn = existing[0];
    const liveRef = turn.source_ref;
    const liveReceipt = liveRef?.table === "sms_inbound_receipts" && liveRef.id === sid;
    const liveIngress = liveRef?.table === "prospect_sms_ingress" && original.ingress &&
      liveRef.id === sid;
    let liveLog = false;
    if (liveRef?.table === "inbound_sms_log" && /^[0-9a-f-]{36}$/i.test(String(liveRef.id))) {
      const { data: sourceLog, error: sourceError } = await db.from("inbound_sms_log")
        .select("message_sid,manager_user_id").eq("id", liveRef.id).maybeSingle();
      if (sourceError) throw new Error("receipt_projection_source_unavailable");
      liveLog = sourceLog?.message_sid === sid && sourceLog?.manager_user_id === receiptManagerId;
    }
    let liveManagerLog = false;
    if (liveRef?.table === "manager_sms_messages" &&
        (liveRef.id === undefined || typeof liveRef.id === "string") &&
        (liveRef.source === undefined || typeof liveRef.source === "string")) {
      // The live producer's default reference has a source but no row ID.
      // Require one exact transport row even when an explicit ID is present.
      const { data: managerLogs, error: managerLogError } = await db.from("manager_sms_messages")
        .select("id,manager_user_id,message_sid,direction,body,from_phone,to_phone,created_at,resident_phone,resident_user_id,counterparty_role,source")
        .eq("manager_user_id", projectedOwnerId).eq("message_sid", sid).limit(2);
      if (managerLogError) throw new Error("receipt_projection_source_unavailable");
      if ((managerLogs?.length ?? 0) > 1) throw new Error("receipt_projection_source_ambiguous");
      const managerLog = managerLogs?.[0];
      const expectedRole = original.role !== "unknown" ? original.role : prior?.counterpartyRole || "unknown";
      const expectedUserId = original.userId || prior?.counterpartyUserId || null;
      liveManagerLog = Boolean(managerLog && managerLog.manager_user_id === projectedOwnerId &&
        managerLog.message_sid === sid &&
        (liveRef.id === undefined || liveRef.id === managerLog.id) &&
        (liveRef.source === undefined || liveRef.source === managerLog.source) &&
        managerLog.direction === "inbound" && managerLog.body === body &&
        managerLog.from_phone === fromPhone && managerLog.to_phone === toPhone &&
        managerLog.resident_phone === fromPhone &&
        managerLog.counterparty_role === expectedRole &&
        managerLog.resident_user_id === expectedUserId &&
        samePostgresInstant(managerLog.created_at, occurredAt));
    }
    const liveSource = turn.source_event_id === sid &&
      turn.source_namespace === `twilio:${projectedOwnerId}:${process.env.TWILIO_ACCOUNT_SID?.trim() || "unconfigured"}` &&
      (liveReceipt || liveIngress || liveLog || liveManagerLog);
    const historicalIngress = turn.source_namespace === "historical:prospect_sms_ingress" &&
      original.ingress && turn.source_event_id === sid &&
      turn.source_ref?.table === "prospect_sms_ingress" && turn.source_ref?.id === sid;
    let historicalLog = false;
    if (turn.source_namespace === "historical:inbound_sms_log" &&
        /^[0-9a-f-]{36}$/i.test(String(turn.source_event_id)) &&
        turn.source_ref?.table === "inbound_sms_log" && turn.source_ref?.id === turn.source_event_id) {
      const { data: sourceLog, error: sourceError } = await db.from("inbound_sms_log")
        .select("message_sid,manager_user_id").eq("id", turn.source_event_id).maybeSingle();
      if (sourceError) throw new Error("receipt_projection_source_unavailable");
      historicalLog = sourceLog?.message_sid === sid && sourceLog?.manager_user_id === receiptManagerId;
    }
    const historicalSource = historicalIngress || historicalLog;
    if (turn.owner_manager_user_id !== projectedOwnerId || turn.direction !== "inbound" ||
        turn.provider_sid !== sid || (!liveSource && !historicalSource) ||
        turn.body !== body || !samePostgresInstant(turn.occurred_at, occurredAt) ||
        turn.from_phone !== fromPhone || turn.to_phone !== toPhone) {
      throw new Error("receipt_projection_integrity_conflict");
    }
    const { data: conversation, error: conversationError } = await db.from("sms_projection_conversations")
      .select("owner_manager_user_id,counterparty_role,counterparty_user_id,counterparty_phone,identity_kind,identity_key,work_line_id")
      .eq("id", turn.conversation_id).maybeSingle();
    if (conversationError || !conversation) throw new Error("receipt_projection_conversation_unavailable");
    const role = original.role !== "unknown" ? original.role : prior?.counterpartyRole || "unknown";
    const userId = original.userId || prior?.counterpartyUserId || null;
    const identityKind = userId ? "user" : role === "unknown" ? "unresolved" : "phone";
    const identityKey = userId ? `user:${userId}` : role === "unknown" ? `unresolved:${sid}` : `phone:${fromPhone}`;
    if (conversation.owner_manager_user_id !== projectedOwnerId || conversation.work_line_id !== line.workLineId ||
        conversation.counterparty_role !== role || conversation.counterparty_user_id !== userId ||
        conversation.identity_kind !== identityKind || conversation.identity_key !== identityKey ||
        (identityKind === "phone" && conversation.counterparty_phone !== fromPhone)) {
      throw new Error("receipt_projection_identity_conflict");
    }
    return null;
  }
  const role = original.role !== "unknown" ? original.role : prior?.counterpartyRole || "unknown";
  const userId = original.userId || prior?.counterpartyUserId || null;
  return {
    ownerManagerUserId: projectedOwnerId,
    counterpartyRole: role as SmsCounterpartyRole,
    workLineId: line.workLineId,
    identityKey: userId ? `user:${userId}` : role === "unknown" ? `unresolved:${sid}` : `phone:${fromPhone}`,
    identityKind: userId ? "user" : role === "unknown" ? "unresolved" : "phone",
    counterpartyUserId: userId,
    counterpartyPhone: fromPhone,
    legacyConversationKey: (projectedOwnerId === receiptManagerId ? original.conversationKey : null) || prior?.legacyConversationKey || buildConversationKey({
      ownerManagerUserId: projectedOwnerId, role: role as SmsCounterpartyRole, counterpartyUserId: userId, counterpartyPhone: fromPhone,
    }),
    sourceNamespace: `twilio:${projectedOwnerId}:${process.env.TWILIO_ACCOUNT_SID?.trim() || "unconfigured"}`,
    sourceEventId: sid,
    direction: "inbound",
    body,
    occurredAt,
    fromPhone,
    toPhone,
    sourceRef: managerRef ?? { table: "sms_inbound_receipts", id: sid },
  };
}

/** Rebuild an accepted manager transport mirror by its immutable row UUID.
 * This path covers outbound accepted SIDs when the projection RPC and ordinary
 * retry upsert both failed; it never calls a provider or model. */
async function hydrateManagerLogRetry(
  db: SupabaseClient,
  ownerManagerUserId: string,
  rowId: string,
): Promise<SmsProjectionEventInput | null> {
  const { data: row, error } = await db.from("manager_sms_messages")
    .select("id,manager_user_id,resident_user_id,resident_phone,direction,body,from_phone,to_phone,message_sid,created_at,source,counterparty_role,conversation_key")
    .eq("id", rowId).eq("manager_user_id", ownerManagerUserId).maybeSingle();
  if (error || !row) throw new Error("manager_log_source_unavailable");
  const sid = String(row.message_sid ?? "");
  const direction = String(row.direction);
  const occurredAt = String(row.created_at ?? "");
  const fromPhone = row.from_phone ? String(row.from_phone) : null;
  const toPhone = row.to_phone ? String(row.to_phone) : null;
  const body = String(row.body ?? "");
  if (!isTwilioMessageSid(sid) || !["inbound", "outbound"].includes(direction) ||
      !Number.isFinite(Date.parse(occurredAt)) || !toPhone) {
    throw new Error("manager_log_envelope_invalid");
  }
  if (direction === "inbound") {
    return hydrateReceiptRetry(db, ownerManagerUserId, sid, undefined,
      { table: "manager_sms_messages", id: rowId });
  }
  const workPhone = direction === "inbound" ? toPhone : fromPhone;
  if (!workPhone) throw new Error("manager_log_work_line_unavailable");
  const line = await resolveSmsProjectionWorkLine(db, {
    ownerManagerUserId, phoneNumber: workPhone, occurredAt,
  });
  if (!line) throw new Error("manager_log_work_line_unresolved");
  const { data: existing, error: existingError } = await db.from("sms_projection_turns")
    .select("body,occurred_at,from_phone,to_phone")
    .eq("owner_manager_user_id", ownerManagerUserId).eq("provider_sid", sid).limit(1);
  if (existingError) throw new Error("projection_lookup_unavailable");
  if (existing?.length) {
    const turn = existing[0];
    if (turn.body !== body || Date.parse(String(turn.occurred_at)) !== Date.parse(occurredAt) ||
        turn.from_phone !== fromPhone || turn.to_phone !== toPhone) {
      throw new Error("manager_log_projection_integrity_conflict");
    }
    return null;
  }
  const role = (row.counterparty_role || "unknown") as SmsCounterpartyRole;
  const userId = row.resident_user_id ? String(row.resident_user_id) : null;
  const counterpartyPhone = String(row.resident_phone || (direction === "inbound" ? fromPhone : toPhone) || "");
  return {
    ownerManagerUserId,
    counterpartyRole: role,
    workLineId: line.workLineId,
    identityKey: userId ? `user:${userId}` : role === "unknown" ? `unresolved:${sid}` : `phone:${counterpartyPhone}`,
    identityKind: userId ? "user" : role === "unknown" ? "unresolved" : "phone",
    counterpartyUserId: userId,
    counterpartyPhone,
    legacyConversationKey: row.conversation_key ? String(row.conversation_key) : buildConversationKey({
      ownerManagerUserId, role, counterpartyUserId: userId, counterpartyPhone,
    }),
    sourceNamespace: `twilio:${ownerManagerUserId}:${process.env.TWILIO_ACCOUNT_SID?.trim() || "unconfigured"}`,
    sourceEventId: sid,
    direction: direction as "inbound" | "outbound",
    body,
    occurredAt,
    fromPhone,
    toPhone,
    sourceRef: { table: "manager_sms_messages", id: rowId },
  };
}

/** Repair the projection only. This worker never invokes an SMS provider or agent. */
export async function recoverSmsProjectionRetries(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<SmsProjectionRecoveryResult> {
  const retries = await listPendingSmsProjectionRetries(db, { limit: opts.limit ?? 25 });
  const result: SmsProjectionRecoveryResult = { scanned: retries.length, projected: 0, failed: 0 };
  for (const retry of retries) {
    let success = false;
    let reasonCode: string | undefined;
    try {
      let event: SmsProjectionEventInput | null;
      if (isSourceIntent(retry.event)) {
        event = retry.event.sourceRef.table === "sms_inbound_receipts"
          ? await hydrateReceiptRetry(db, retry.ownerManagerUserId, retry.event.sourceRef.id)
          : await hydrateManagerLogRetry(db, retry.ownerManagerUserId, retry.event.sourceRef.id);
      } else {
        event = retry.event;
        if (event.direction === "inbound" && event.sourceNamespace.startsWith("twilio:")) {
          event = await hydrateReceiptRetry(db, event.ownerManagerUserId, event.sourceEventId, event);
        }
      }
      if (event && !event.workLineId) {
        const phoneNumber = event.direction === "inbound" ? event.toPhone : event.fromPhone;
        const line = phoneNumber
          ? await resolveSmsProjectionWorkLine(db, {
              ownerManagerUserId: event.ownerManagerUserId,
              phoneNumber,
              occurredAt: event.occurredAt,
            })
          : null;
        if (!line) {
          reasonCode = "work_line_unresolved";
          throw new Error("work_line_unresolved");
        }
        event = { ...event, workLineId: line.workLineId };
      }
      if (event) await projectOriginalEvent(db, event);
      success = true;
      result.projected += 1;
    } catch (error) {
      reasonCode = error instanceof Error ? error.message.split(":")[0] : "projection_error";
      result.failed += 1;
    }
    try {
      await finishSmsProjectionRetry(db, {
        ownerManagerUserId: retry.ownerManagerUserId,
        sourceNamespace: retry.sourceNamespace,
        sourceEventId: retry.sourceEventId,
        claimToken: retry.claimToken,
        success,
        ...(reasonCode ? { reasonCode } : {}),
      });
    } catch (error) {
      result.failed += 1;
      if (success) result.projected -= 1;
      console.error("sms projection retry completion failed", { reason: error instanceof Error ? error.message.split(":")[0] : "unknown" });
    }
  }
  return result;
}

async function projectClassifiedInbound(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    role: SmsCounterpartyRole;
    counterpartyUserId: string | null;
    fromPhone: string;
    toPhone: string;
    messageSid: string;
    body: string;
    occurredAt: string;
  },
): Promise<string | null> {
  const occurredAt = args.occurredAt;
  const normalizedFrom = normalizeE164(args.fromPhone) ?? args.fromPhone;
  const normalizedTo = normalizeE164(args.toPhone) ?? args.toPhone;
  const legacyConversationKey = buildConversationKey({
    ownerManagerUserId: args.managerUserId,
    role: args.role,
    counterpartyUserId: args.counterpartyUserId,
    counterpartyPhone: normalizedFrom,
  });
  const projected = await projectManagerSmsEvent(db, {
    ownerManagerUserId: args.managerUserId,
    counterpartyRole: args.role,
    counterpartyUserId: args.counterpartyUserId,
    counterpartyPhone: normalizedFrom,
    workPhone: normalizedTo,
    legacyConversationKey,
    messageSid: args.messageSid,
    direction: "inbound",
    body: args.body,
    occurredAt,
    fromPhone: normalizedFrom,
    toPhone: normalizedTo,
    source: "work_number",
    sourceRef: { table: "sms_inbound_receipts", id: args.messageSid },
  });
  if (!projected) console.warn("sms inbound projection deferred", { reason: "projection_not_confirmed" });
  return occurredAt;
}

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
  const { messageSid, managerId, workspaceId, media, inboundWorkerId, mark } = input;
  const { data: receiptEnvelope, error: envelopeError } = await db.from("sms_inbound_receipts")
    .select("manager_user_id,first_received_at,inbound_payload")
    .eq("message_sid", messageSid).eq("manager_user_id", managerId).maybeSingle();
  const occurredAt = String(receiptEnvelope?.first_received_at ?? "");
  if (envelopeError || !receiptEnvelope || !Number.isFinite(Date.parse(occurredAt))) {
    await finishInboundClaim(db, messageSid, inboundWorkerId, "retryable").catch(() => false);
    return NextResponse.json({ error: "Original inbound receipt unavailable." }, { status: 503 });
  }
  const saved = receiptEnvelope.inbound_payload as InboundPayload | null;
  const fromPhone = saved?.fromPhone ?? input.fromPhone;
  const toPhone = saved?.toPhone ?? input.toPhone;
  const body = saved?.body ?? input.body;
  // Preserve the incoming body before any billing read. An unavailable wallet
  // must not erase incoming communication while delivery retries are pending.
  const { error: inboundBodyError } = await db.from("inbound_sms_log").insert({
    manager_user_id: managerId, from_phone: fromPhone, to_phone: toPhone, body, message_sid: messageSid,
    created_at: occurredAt,
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
    await projectClassifiedInbound(db, {
      managerUserId: managerId,
      role: "manager",
      counterpartyUserId: managerInbound.actorUserId,
      fromPhone,
      toPhone,
      messageSid,
      body,
      occurredAt,
    }).catch((error) => console.error("manager inbound projection failed", error instanceof Error ? error.message : "unknown"));
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
    await projectClassifiedInbound(db, {
      managerUserId: managerId,
      role: "vendor",
      counterpartyUserId: vendor.session.vendor_user_id,
      fromPhone,
      toPhone,
      messageSid,
      body,
      occurredAt,
    }).catch((error) => console.error("vendor inbound projection failed", error instanceof Error ? error.message : "unknown"));
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
    await projectClassifiedInbound(db, {
      managerUserId: managerId,
      role: "resident",
      counterpartyUserId: residentIdentity.ctx.userId,
      fromPhone,
      toPhone,
      messageSid,
      body,
      occurredAt,
    }).catch((error) => console.error("resident inbound projection failed", error instanceof Error ? error.message : "unknown"));
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
    const originalReceivedAt = await projectClassifiedInbound(db, {
      managerUserId: workspace.ownerUserId,
      role: "prospect",
      counterpartyUserId: null,
      fromPhone,
      toPhone,
      messageSid,
      body,
      occurredAt,
    }).catch((error) => {
      console.error("prospect inbound projection failed", error instanceof Error ? error.message : "unknown");
      return null;
    });
    mark("leasing-start");
    handled = await handleClawLeasingInbound({
      from: fromPhone,
      text: body,
      messageId: messageSid,
      receivedAt: originalReceivedAt,
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
