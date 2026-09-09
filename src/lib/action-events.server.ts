import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationCategory } from "@/lib/notification-preferences";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { isWithinQuietHours } from "@/lib/sms/number-registration-policy";

export type ActionEventDomain =
  | "work_order"
  | "payment"
  | "lease"
  | "application"
  | "service_request"
  | "tour";
export type ActionEventAudience = "manager" | "resident" | "vendor";
export type ActionEventRendered = { subject: string; text: string; smsText?: string };
export type ActionEventRecipient = {
  audience: ActionEventAudience;
  userId?: string;
  email?: string;
  rendered: ActionEventRendered;
};

export type ActionDeliveryPolicy = { deferSms: boolean; digest: boolean; nextAttemptAt: string | null };

export function actionDeliveryPolicy(input: {
  now: Date;
  urgent?: boolean;
  recentEventCount: number;
}): ActionDeliveryPolicy {
  if (input.urgent) return { deferSms: false, digest: false, nextAttemptAt: null };
  const digest = input.recentEventCount >= 4;
  const quiet = isWithinQuietHours(input.now);
  if (!quiet && !digest) return { deferSms: false, digest: false, nextAttemptAt: null };
  const next = new Date(input.now);
  if (quiet) {
    next.setMinutes(0, 0, 0);
    do next.setHours(next.getHours() + 1); while (isWithinQuietHours(next));
  } else {
    next.setMinutes(next.getMinutes() + 10, 0, 0);
  }
  return { deferSms: true, digest, nextAttemptAt: next.toISOString() };
}

type ActionEventResult = { eventId: string; duplicate: boolean; delivered: number; submitted: number; deferred: number; failed: number };

async function deliverProjection(
  db: SupabaseClient,
  input: {
    deliveryId: string;
    eventKey: string;
    category: NotificationCategory;
    senderUserId: string;
    senderEmail: string;
    senderName?: string;
    recipient: Omit<ActionEventRecipient, "rendered">;
    rendered: ActionEventRendered;
    suppressSms: boolean;
    digest: boolean;
    retryMode?: "sms" | "email" | "both";
    attempts: number;
    now: Date;
    finalizeGuard?: { status: "pending" | "failed" | "email_failed" | "sms_failed" | "channels_failed" | "deferred"; dueAt: string };
  },
): Promise<"delivered" | "submitted" | "deferred" | "failed" | "email_failed" | "sms_failed" | "channels_failed" | "stale"> {
  const text = input.digest
    ? `Several updates were recorded. Open PropLane for the latest status.`
    : input.rendered.text;
  const result = await deliverPortalInboxMessage(db, {
    senderUserId: input.senderUserId,
    senderEmail: input.senderEmail,
    fromName: input.senderName?.trim() || "PropLane Portal",
    subject: input.rendered.subject,
    text,
    smsText: input.rendered.smsText,
    toUserIds: input.recipient.userId ? [input.recipient.userId] : undefined,
    toEmails: input.recipient.email ? [input.recipient.email] : undefined,
    eventCategory: input.category,
    suppressSms: input.suppressSms,
    suppressEmail: input.retryMode === "sms",
    suppressInbox: Boolean(input.retryMode),
    messageId: `action-event:${input.eventKey}:${input.recipient.audience}:${input.recipient.userId ?? input.recipient.email}`,
  }).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : "Delivery failed",
  }));
  const updatedAt = input.now.toISOString();
  if (!result.ok) {
    const retryStatus = input.retryMode === "sms" ? "sms_failed"
      : input.retryMode === "email" ? "email_failed"
        : input.retryMode === "both" ? "channels_failed" : "failed";
    const failedUpdate = db.from("action_event_deliveries").update({
      status: retryStatus,
      attempts: input.attempts + 1,
      last_error: result.error,
      next_attempt_at: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
      updated_at: updatedAt,
    }).eq("id", input.deliveryId);
    if (input.finalizeGuard) {
      const { data, error } = await failedUpdate.eq("status", input.finalizeGuard.status).eq("next_attempt_at", input.finalizeGuard.dueAt).select("id").maybeSingle();
      if (error) throw new Error(`Could not finalize action-event delivery: ${error.message}`);
      if (!data) return "stale";
    } else {
      const { error } = await failedUpdate;
      if (error) throw new Error(`Could not finalize action-event delivery: ${error.message}`);
    }
    return "failed";
  }
  const smsOutcomes = (result as typeof result & { smsOutcomes?: Array<{ status: string }> }).smsOutcomes ?? [];
  const emailOutcomes = (result as typeof result & { emailOutcomes?: Array<{ status: string }> }).emailOutcomes ?? [];
  const hasSmsFailure = smsOutcomes.some((outcome) => outcome.status === "failed" || outcome.status === "unavailable");
  const hasEmailFailure = emailOutcomes.some((outcome) => outcome.status === "failed");
  const hasAcceptedSms = smsOutcomes.some((outcome) => ["submitted", "queued", "deferred", "unknown"].includes(outcome.status));
  // Portal/email already succeeded when only SMS failed. Preserve that fact so
  // retry suppresses those completed legs. Accepted provider work is submitted,
  // not a claim that the handset received it.
  const status = hasEmailFailure && hasSmsFailure ? "channels_failed"
    : hasEmailFailure ? "email_failed"
      : hasSmsFailure ? "sms_failed"
        : hasAcceptedSms ? "submitted" : input.retryMode ? "delivered" : input.suppressSms ? "deferred" : "delivered";
  const retrySmsAt = new Date(input.now.getTime() + 5 * 60_000).toISOString();
  const retryChannels = status === "email_failed" || status === "sms_failed" || status === "channels_failed";
  const finalPayload = retryChannels ? {
    status, attempts: input.attempts + 1, last_error: `${status}_delivery_unavailable`,
    next_attempt_at: retrySmsAt, delivered_at: null, updated_at: updatedAt,
  } : status === "deferred" ? {
    status, attempts: input.attempts + 1, last_error: null, updated_at: updatedAt,
  } : {
    status, attempts: input.attempts + 1, last_error: null,
    next_attempt_at: null, delivered_at: status === "delivered" ? updatedAt : null, updated_at: updatedAt,
  };
  const successUpdate = db.from("action_event_deliveries").update(finalPayload).eq("id", input.deliveryId);
  if (input.finalizeGuard) {
    const { data, error } = await successUpdate.eq("status", input.finalizeGuard.status).eq("next_attempt_at", input.finalizeGuard.dueAt).select("id").maybeSingle();
    if (error) throw new Error(`Could not finalize action-event delivery: ${error.message}`);
    if (!data) return "stale";
  } else {
    const { error } = await successUpdate;
    if (error) throw new Error(`Could not finalize action-event delivery: ${error.message}`);
  }
  return status;
}

/** Record one fact and fan it out through one idempotent consumer per recipient. */
export async function emitActionEvent(
  db: SupabaseClient,
  input: {
    eventId: string;
    domain: ActionEventDomain;
    event: string;
    managerUserId: string;
    entityId: string;
    category: NotificationCategory;
    senderUserId: string;
    senderEmail: string;
    senderName?: string;
    payload?: Record<string, unknown>;
    recipients: ActionEventRecipient[];
    urgent?: boolean;
    occurredAt?: string;
    now?: Date;
  },
): Promise<ActionEventResult> {
  const eventKey = input.eventId.trim();
  if (!eventKey) throw new Error("emitActionEvent requires an idempotency eventId");
  const now = input.now ?? new Date();
  const { data: inserted, error: insertError } = await db.from("action_events").upsert({
    event_key: eventKey,
    domain: input.domain,
    event_type: input.event,
    category: input.category,
    manager_user_id: input.managerUserId,
    entity_id: input.entityId,
    sender_user_id: input.senderUserId,
    sender_email: input.senderEmail.trim().toLowerCase(),
    sender_name: input.senderName?.trim() || null,
    occurred_at: input.occurredAt ?? now.toISOString(),
    payload: input.payload ?? {},
  }, { onConflict: "event_key", ignoreDuplicates: true }).select("id").maybeSingle();
  if (insertError) throw new Error(`Could not record action event: ${insertError.message}`);
  let eventRow = inserted as { id: string } | null;
  const duplicate = !eventRow;
  if (!eventRow) {
    const { data, error } = await db.from("action_events").select("id").eq("event_key", eventKey).maybeSingle();
    if (error || !data) throw new Error(`Could not resolve action event: ${error?.message ?? "missing event"}`);
    eventRow = data as { id: string };
  }

  let delivered = 0;
  let submitted = 0;
  let deferred = 0;
  let failed = 0;
  for (const recipient of input.recipients) {
    const recipientKey = recipient.userId?.trim() || recipient.email?.trim().toLowerCase() || "";
    if (!recipientKey || !recipient.rendered.subject.trim() || !recipient.rendered.text.trim()) continue;
    const since = new Date(now.getTime() - 10 * 60_000).toISOString();
    const { count } = await db.from("action_event_deliveries").select("id", { count: "exact", head: true }).eq("recipient_key", recipientKey).gte("created_at", since);
    const policy = actionDeliveryPolicy({ now, urgent: input.urgent, recentEventCount: count ?? 0 });
    const initialStatus = policy.deferSms ? "deferred" : "pending";
    const { data: delivery } = await db.from("action_event_deliveries").upsert({
      event_id: eventRow.id,
      audience: recipient.audience,
      recipient_key: recipientKey,
      recipient_user_id: recipient.userId ?? null,
      recipient_email: recipient.email?.trim().toLowerCase() ?? null,
      status: initialStatus,
      next_attempt_at: policy.nextAttemptAt,
      rendered: recipient.rendered,
    }, { onConflict: "event_id,audience,recipient_key", ignoreDuplicates: true }).select("id,status,attempts").maybeSingle();
    if (!delivery) continue;
    const outcome = await deliverProjection(db, {
      deliveryId: String(delivery.id),
      eventKey,
      category: input.category,
      senderUserId: input.senderUserId,
      senderEmail: input.senderEmail,
      senderName: input.senderName,
      recipient,
      rendered: recipient.rendered,
      suppressSms: policy.deferSms,
      digest: policy.digest,
      retryMode: undefined,
      attempts: Number(delivery.attempts ?? 0),
      now,
    });
    if (outcome === "delivered") delivered++;
    else if (outcome === "submitted") submitted++;
    else if (outcome === "deferred") deferred++;
    else failed++;
  }
  await db.from("action_events").update({ processed_at: now.toISOString() }).eq("id", eventRow.id);
  return { eventId: eventKey, duplicate, delivered, submitted, deferred, failed };
}

/** Deliver due pending/failed/deferred projections. Deterministic message IDs make inbox
 * appends safe even when a previous attempt succeeded before its status write. */
export async function retryDueActionEventDeliveries(
  db: SupabaseClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ attempted: number; delivered: number; submitted: number; failed: number }> {
  const now = opts.now ?? new Date();
  const { data, error } = await db.from("action_event_deliveries")
    .select("id,event_id,audience,recipient_user_id,recipient_email,status,attempts,next_attempt_at,rendered")
    .in("status", ["pending", "failed", "email_failed", "sms_failed", "channels_failed", "deferred"])
    .lte("next_attempt_at", now.toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  if (error) throw new Error(`Could not load due action-event deliveries: ${error.message}`);
  let delivered = 0;
  let submitted = 0;
  let failed = 0;
  let attempted = 0;
  for (const row of data ?? []) {
    const priorNextAttemptAt = String(row.next_attempt_at ?? "");
    if (!priorNextAttemptAt) continue;
    // Start the lease when this row is actually processed. Earlier external
    // deliveries can make a batch several minutes old.
    const claimTime = opts.now ?? new Date();
    const claimUntil = new Date(claimTime.getTime() + 5 * 60_000).toISOString();
    const { data: claim, error: claimError } = await db.from("action_event_deliveries")
      .update({ next_attempt_at: claimUntil, updated_at: claimTime.toISOString() })
      .eq("id", row.id)
      .eq("next_attempt_at", priorNextAttemptAt)
      .eq("status", row.status)
      .select("id")
      .maybeSingle();
    if (claimError) throw new Error(`Could not claim action-event delivery: ${claimError.message}`);
    if (!claim) continue;
    attempted++;
    const { data: event, error: eventError } = await db.from("action_events")
      .select("event_key,category,sender_user_id,sender_email,sender_name")
      .eq("id", row.event_id)
      .maybeSingle();
    if (eventError || !event?.sender_user_id || !event.sender_email) {
      throw new Error(`Could not resolve action event: ${eventError?.message ?? "missing sender"}`);
    }
    const outcome = await deliverProjection(db, {
      deliveryId: String(row.id),
      eventKey: String(event.event_key),
      category: event.category as NotificationCategory,
      senderUserId: String(event.sender_user_id),
      senderEmail: String(event.sender_email),
      senderName: event.sender_name ? String(event.sender_name) : undefined,
      recipient: {
        audience: row.audience as ActionEventAudience,
        userId: row.recipient_user_id ? String(row.recipient_user_id) : undefined,
        email: row.recipient_email ? String(row.recipient_email) : undefined,
      },
      rendered: row.rendered as ActionEventRendered,
      suppressSms: row.status === "email_failed",
      digest: false,
      retryMode: row.status === "deferred" || row.status === "sms_failed"
        ? "sms" : row.status === "email_failed" ? "email" : row.status === "channels_failed" ? "both" : undefined,
      attempts: Number(row.attempts ?? 0),
      now: claimTime,
      finalizeGuard: { status: row.status as "pending" | "failed" | "email_failed" | "sms_failed" | "channels_failed" | "deferred", dueAt: claimUntil },
    });
    if (["failed", "email_failed", "sms_failed", "channels_failed"].includes(outcome)) failed++;
    else if (outcome === "submitted") submitted++;
    else if (outcome !== "stale") delivered++;
  }
  return { attempted, delivered, submitted, failed };
}
