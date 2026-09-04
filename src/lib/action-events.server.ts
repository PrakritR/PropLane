import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationCategory } from "@/lib/notification-preferences";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { isWithinQuietHours } from "@/lib/sms/number-registration-policy";

export type ActionEventDomain = "work_order" | "payment" | "lease";
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

type ActionEventResult = { eventId: string; duplicate: boolean; delivered: number; deferred: number; failed: number };

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
    smsOnly?: boolean;
    attempts: number;
    now: Date;
  },
): Promise<"delivered" | "deferred" | "failed"> {
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
    suppressEmail: input.smsOnly,
    suppressInbox: input.smsOnly,
    messageId: `action-event:${input.eventKey}:${input.recipient.audience}:${input.recipient.userId ?? input.recipient.email}`,
  }).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : "Delivery failed",
  }));
  const updatedAt = input.now.toISOString();
  if (!result.ok) {
    await db.from("action_event_deliveries").update({
      status: "failed",
      attempts: input.attempts + 1,
      last_error: result.error,
      next_attempt_at: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
      updated_at: updatedAt,
    }).eq("id", input.deliveryId);
    return "failed";
  }
  const status = input.suppressSms ? "deferred" : "delivered";
  await db.from("action_event_deliveries").update({
    status,
    attempts: input.attempts + 1,
    last_error: null,
    delivered_at: updatedAt,
    updated_at: updatedAt,
  }).eq("id", input.deliveryId);
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
      smsOnly: false,
      attempts: Number(delivery.attempts ?? 0),
      now,
    });
    if (outcome === "delivered") delivered++;
    else if (outcome === "deferred") deferred++;
    else failed++;
  }
  await db.from("action_events").update({ processed_at: now.toISOString() }).eq("id", eventRow.id);
  return { eventId: eventKey, duplicate, delivered, deferred, failed };
}

/** Retry due failed/deferred projections. Deterministic message IDs make inbox
 * appends safe even when a previous attempt succeeded before its status write. */
export async function retryDueActionEventDeliveries(
  db: SupabaseClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const now = opts.now ?? new Date();
  const { data, error } = await db.from("action_event_deliveries")
    .select("id,event_id,audience,recipient_user_id,recipient_email,status,attempts,next_attempt_at,rendered")
    .in("status", ["failed", "deferred"])
    .lte("next_attempt_at", now.toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  if (error) throw new Error(`Could not load due action-event deliveries: ${error.message}`);
  let delivered = 0;
  let failed = 0;
  let attempted = 0;
  for (const row of data ?? []) {
    const priorNextAttemptAt = String(row.next_attempt_at ?? "");
    if (!priorNextAttemptAt) continue;
    // Compare-and-swap the due timestamp. Only one overlapping cron worker can
    // claim this projection; a crashed worker naturally becomes due again.
    const claimUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
    const { data: claim } = await db.from("action_event_deliveries")
      .update({ next_attempt_at: claimUntil, updated_at: now.toISOString() })
      .eq("id", row.id)
      .eq("next_attempt_at", priorNextAttemptAt)
      .in("status", ["failed", "deferred"])
      .select("id")
      .maybeSingle();
    if (!claim) continue;
    attempted++;
    const { data: event } = await db.from("action_events")
      .select("event_key,category,sender_user_id,sender_email,sender_name")
      .eq("id", row.event_id)
      .maybeSingle();
    if (!event?.sender_user_id || !event.sender_email) continue;
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
      suppressSms: false,
      digest: false,
      smsOnly: row.status === "deferred",
      attempts: Number(row.attempts ?? 0),
      now,
    });
    if (outcome === "failed") failed++;
    else delivered++;
  }
  return { attempted, delivered, failed };
}
