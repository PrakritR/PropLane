import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationCategory } from "@/lib/notification-preferences";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { isWithinQuietHours } from "@/lib/sms/number-registration-policy";
import { vendorTopicForEvent } from "@/lib/vendor-notification-settings";
import { loadAutomatedMessageSettings } from "@/lib/automated-messages-settings.server";
import { applyAutomatedMessageSetting } from "@/lib/automated-messages-settings";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { managerNotificationCategoryForEvent } from "@/lib/manager-notification-preferences";
import { postTeamThreadMessage, mirrorTeamThreadMessageToSms } from "@/lib/team-comms.server";

export type ActionEventDomain =
  | "work_order"
  | "payment"
  | "lease"
  | "application"
  | "service_request"
  | "tour"
  | "inspection"
  | "task"
  | "message"
  /** WS5: team-only, no resident/vendor/manager side. */
  | "availability";
/**
 * `team` (WS5): one rendered copy posted once into the manager's Team thread
 * (`team-comms.server.ts`), never fanned out per co-manager the way the other
 * three audiences are. `recipient.userId` for a `team` recipient is the
 * OWNING manager's user id (see `team-comms.server.ts` module doc for the
 * per-owner, not per-workspace, scope this implies).
 */
export type ActionEventAudience = "manager" | "resident" | "vendor" | "team";
export type ActionEventRendered = { subject: string; text: string; smsText?: string };
export type ActionEventRecipient = {
  audience: ActionEventAudience;
  userId?: string;
  email?: string;
  rendered: ActionEventRendered;
  /**
   * Resident/vendor only: route this recipient through manager-approval
   * draft-for-review instead of immediate send (WS5 decision: "party-facing
   * -> draft-for-review", per-workspace opt-in — see
   * `src/lib/automation-send-mode.ts`). Absent/false on every existing call
   * site, so this is purely additive — nothing auto-sends today changes
   * behavior unless a call site explicitly opts in.
   */
  draftForReview?: boolean;
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
    smsDeferredUntil?: string | null;
    /** `(domain, event_type)` so a vendor recipient's topic can be derived on both first send and retry. */
    domain?: string;
    eventType?: string;
    urgent?: boolean;
    draftForReview?: boolean;
    finalizeGuard?: { status: "pending" | "failed" | "email_failed" | "sms_failed" | "channels_failed" | "deferred"; dueAt: string };
  },
): Promise<"delivered" | "submitted" | "deferred" | "failed" | "email_failed" | "sms_failed" | "channels_failed" | "stale"> {
  const text = input.digest
    ? `Several updates were recorded. Open PropLane for the latest status.`
    : input.rendered.text;
  // Team (WS5): one copy, posted once into the manager's Team thread instead
  // of fanned out per recipient. Never digested — a digest placeholder in a
  // shared team channel would be meaningless without knowing whose events.
  if (input.recipient.audience === "team" && input.recipient.userId) {
    const updatedAt = input.now.toISOString();
    const messageId = `action-event:${input.eventKey}:team:${input.recipient.userId}`;
    try {
      const posted = await postTeamThreadMessage(db, {
        ownerManagerUserId: input.recipient.userId,
        actorUserId: input.senderUserId,
        actorName: input.senderName?.trim() || "PropLane Portal",
        subject: input.rendered.subject,
        text: input.rendered.text,
        smsText: input.rendered.smsText,
        messageId,
        urgent: input.urgent,
      });
      if (!posted.ok) throw new Error(posted.error);
      // Best-effort SMS mirror (WS6) — never fail the team-thread post over a text failure.
      await mirrorTeamThreadMessageToSms(db, {
        ownerManagerUserId: input.recipient.userId,
        actorUserId: input.senderUserId,
        subject: input.rendered.subject,
        text: input.rendered.smsText ?? input.rendered.text,
        messageId,
        urgent: input.urgent,
        now: input.now,
      }).catch(() => undefined);
      const { error } = await db.from("action_event_deliveries").update({
        status: "delivered", attempts: input.attempts + 1, last_error: null, next_attempt_at: null,
        delivered_at: updatedAt, sms_deferred_until: null, updated_at: updatedAt,
      }).eq("id", input.deliveryId);
      if (error) throw new Error(`Could not finalize action-event delivery: ${error.message}`);
      return "delivered";
    } catch (error) {
      const { error: updateError } = await db.from("action_event_deliveries").update({
        status: "failed", attempts: input.attempts + 1,
        last_error: error instanceof Error ? error.message : "Team post failed",
        next_attempt_at: new Date(input.now.getTime() + 5 * 60_000).toISOString(), updated_at: updatedAt,
      }).eq("id", input.deliveryId);
      if (updateError) throw new Error(`Could not finalize action-event delivery: ${updateError.message}`);
      return "failed";
    }
  }
  // Draft-for-review (WS5, opt-in): a resident/vendor recipient a call site
  // marked `draftForReview` lands as a manager-approval draft instead of an
  // immediate send. Queuing the draft IS the terminal, successful outcome for
  // this delivery — it must never retry into a real send later.
  if (input.draftForReview && (input.recipient.audience === "resident" || input.recipient.audience === "vendor")) {
    const updatedAt = input.now.toISOString();
    try {
      const { queueActionEventDraftForReview } = await import("@/lib/action-event-draft-review.server");
      const queued = await queueActionEventDraftForReview(db, {
        managerUserId: input.senderUserId,
        recipientEmail: input.recipient.email,
        recipientUserId: input.recipient.userId,
        subject: input.rendered.subject,
        text,
        origin: `automation:${input.domain ?? "unknown"}:${input.eventType ?? "unknown"}`,
        draftId: input.eventKey,
      });
      if (!queued.ok) throw new Error(queued.error);
      const { error } = await db.from("action_event_deliveries").update({
        status: "delivered", attempts: input.attempts + 1, last_error: null, next_attempt_at: null,
        delivered_at: updatedAt, sms_deferred_until: null, updated_at: updatedAt,
      }).eq("id", input.deliveryId);
      if (error) throw new Error(`Could not finalize action-event delivery: ${error.message}`);
      return "delivered";
    } catch (error) {
      const { error: updateError } = await db.from("action_event_deliveries").update({
        status: "failed", attempts: input.attempts + 1,
        last_error: error instanceof Error ? error.message : "Draft queue failed",
        next_attempt_at: new Date(input.now.getTime() + 5 * 60_000).toISOString(), updated_at: updatedAt,
      }).eq("id", input.deliveryId);
      if (updateError) throw new Error(`Could not finalize action-event delivery: ${updateError.message}`);
      return "failed";
    }
  }
  // A manager's own copy of an event they (or the system acting as them) sent
  // is a self-send, which the inbox drops as "No recipients selected". It is
  // really an Assistant notice — the same surface reminders use for the
  // manager — so route it there, where their alert destination applies.
  if (input.recipient.audience === "manager" && input.recipient.userId && input.recipient.userId === input.senderUserId) {
    const updatedAt = input.now.toISOString();
    try {
      await notifyManagerFromAgent(db, {
        landlordId: input.recipient.userId,
        subject: input.rendered.subject,
        text,
        externalText: input.rendered.smsText ?? text,
        threadType: "action_event",
        category: managerNotificationCategoryForEvent(input.category),
        idempotencyKey: `action-event:${input.eventKey}:manager:${input.recipient.userId}`,
      });
      const { error } = await db.from("action_event_deliveries").update({
        status: "delivered", attempts: input.attempts + 1, last_error: null, next_attempt_at: null,
        delivered_at: updatedAt, sms_deferred_until: null, updated_at: updatedAt,
      }).eq("id", input.deliveryId);
      if (error) throw new Error(`Could not finalize action-event delivery: ${error.message}`);
      return "delivered";
    } catch (error) {
      const { error: updateError } = await db.from("action_event_deliveries").update({
        status: "failed", attempts: input.attempts + 1,
        last_error: error instanceof Error ? error.message : "Assistant notice failed",
        next_attempt_at: new Date(input.now.getTime() + 5 * 60_000).toISOString(), updated_at: updatedAt,
      }).eq("id", input.deliveryId);
      if (updateError) throw new Error(`Could not finalize action-event delivery: ${updateError.message}`);
      return "failed";
    }
  }
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
    vendorTopic:
      input.recipient.audience === "vendor" && input.domain && input.eventType
        ? vendorTopicForEvent(input.domain, input.eventType)
        : undefined,
    urgent: input.urgent,
  }).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : "Delivery failed",
  }));
  const updatedAt = input.now.toISOString();
  if (!result.ok) {
    const retryStatus = input.retryMode === "email" && input.smsDeferredUntil ? "channels_failed"
      : input.retryMode === "sms" ? "sms_failed"
      : input.retryMode === "email" ? "email_failed"
        : input.retryMode === "both" ? "channels_failed" : "failed";
    const failedUpdate = db.from("action_event_deliveries").update({
      status: retryStatus,
      attempts: input.attempts + 1,
      last_error: result.error,
      sms_deferred_until: input.smsDeferredUntil ?? null,
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
  const status = input.smsDeferredUntil && hasEmailFailure ? "channels_failed"
    : hasEmailFailure && hasSmsFailure ? "channels_failed"
    : hasEmailFailure ? "email_failed"
      : hasSmsFailure ? "sms_failed"
        : hasAcceptedSms ? "submitted"
          : input.suppressSms && input.smsDeferredUntil ? "deferred"
            : input.retryMode ? "delivered" : input.suppressSms ? "deferred" : "delivered";
  const retrySmsAt = new Date(input.now.getTime() + 5 * 60_000).toISOString();
  const retryChannels = status === "email_failed" || status === "sms_failed" || status === "channels_failed";
  const finalPayload = retryChannels ? {
    status, attempts: input.attempts + 1, last_error: `${status}_delivery_unavailable`,
    next_attempt_at: retrySmsAt, delivered_at: null, updated_at: updatedAt,
    sms_deferred_until: input.smsDeferredUntil ?? null,
  } : status === "deferred" ? {
    status, attempts: input.attempts + 1, last_error: null, updated_at: updatedAt,
    ...(input.smsDeferredUntil ? { next_attempt_at: input.smsDeferredUntil } : {}),
    sms_deferred_until: null,
  } : {
    status, attempts: input.attempts + 1, last_error: null,
    next_attempt_at: null, delivered_at: status === "delivered" ? updatedAt : null,
    sms_deferred_until: null, updated_at: updatedAt,
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
    /**
     * Placeholder values for a manager-authored template of this event
     * (Settings → <area> → Messages sent automatically). Absent = the default
     * copy in `rendered` is what goes out.
     */
    templateContext?: Record<string, string>;
  },
): Promise<ActionEventResult> {
  const eventKey = input.eventId.trim();
  if (!eventKey) throw new Error("emitActionEvent requires an idempotency eventId");
  const now = input.now ?? new Date();
  // The manager's per-event switch and template. Loaded once per event; a read
  // failure means "defaults", never "silence".
  const automated = await loadAutomatedMessageSettings(db, input.managerUserId).catch(() => null);
  const recipients = input.recipients.flatMap((recipient) => {
    const applied = applyAutomatedMessageSetting(automated, {
      domain: input.domain,
      event: input.event,
      audience: recipient.audience,
      rendered: recipient.rendered,
      context: input.templateContext,
    });
    return applied ? [{ ...recipient, rendered: applied }] : [];
  });
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
  for (const recipient of recipients) {
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
      sms_deferred_until: policy.deferSms ? policy.nextAttemptAt : null,
      rendered: recipient.rendered,
      // Persisted so a retry of a FAILED draft-queue attempt re-queues the
      // draft rather than falling through to a real send — see
      // `retryDueActionEventDeliveries` below.
      draft_for_review: Boolean(recipient.draftForReview),
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
      smsDeferredUntil: policy.deferSms ? policy.nextAttemptAt : null,
      domain: input.domain,
      eventType: input.event,
      urgent: input.urgent,
      draftForReview: recipient.draftForReview,
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
    .select("id,event_id,audience,recipient_user_id,recipient_email,status,attempts,next_attempt_at,sms_deferred_until,rendered,draft_for_review")
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
      .select("event_key,category,sender_user_id,sender_email,sender_name,domain,event_type,payload")
      .eq("id", row.event_id)
      .maybeSingle();
    if (eventError || !event?.sender_user_id || !event.sender_email) {
      throw new Error(`Could not resolve action event: ${eventError?.message ?? "missing sender"}`);
    }
    const retainedSmsDue = row.sms_deferred_until ? String(row.sms_deferred_until) : null;
    const retryingQuietEmail = Boolean(retainedSmsDue && Date.parse(retainedSmsDue!) > claimTime.getTime());
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
      suppressSms: row.status === "email_failed" || retryingQuietEmail,
      digest: false,
      retryMode: row.status === "deferred" || row.status === "sms_failed"
        ? "sms"
        : row.status === "email_failed" || (row.status === "channels_failed" && retryingQuietEmail)
          ? "email"
          : row.status === "channels_failed" ? "both" : undefined,
      attempts: Number(row.attempts ?? 0),
      now: claimTime,
      smsDeferredUntil: retryingQuietEmail ? retainedSmsDue : null,
      domain: event.domain ? String(event.domain) : undefined,
      eventType: event.event_type ? String(event.event_type) : undefined,
      urgent: Boolean((event.payload as { emergency?: unknown } | null)?.emergency),
      draftForReview: Boolean(row.draft_for_review),
      finalizeGuard: { status: row.status as "pending" | "failed" | "email_failed" | "sms_failed" | "channels_failed" | "deferred", dueAt: claimUntil },
    });
    if (["failed", "email_failed", "sms_failed", "channels_failed"].includes(outcome)) failed++;
    else if (outcome === "submitted") submitted++;
    else if (outcome !== "stale") delivered++;
  }
  return { attempted, delivered, submitted, failed };
}
