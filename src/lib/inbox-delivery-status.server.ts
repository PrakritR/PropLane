import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mergeDelivery,
  placeholderEmailDelivery,
  type InboxDeliveryChannel,
  type InboxDeliveryState,
  type InboxMessageDelivery,
} from "@/lib/inbox-delivery-status";
import { isPlaceholderMailbox, isSandboxEmail } from "@/lib/inbox-delivery-status";
import { WORKSPACE_NO_WORK_NUMBER_CODE, WORKSPACE_NO_WORK_NUMBER_MESSAGE } from "@/lib/sms/workspace-no-work-number";

/**
 * Server writers for per-message delivery status (see docs/agents/communication-inbox.md § Delivery status).
 * Everything here is best-effort: a failure to record status never fails or retries the send itself.
 */

const MAX_ATTEMPTS = 5;

export type InboxMessageTarget = { threadId: string; messageId: string };

type ThreadRow = { id: string; row_data: Record<string, unknown> | null; updated_at: string | null };

/**
 * Read the thread, rewrite ONE message's deliveries, write it back with a compare-and-set on `updated_at`
 * (a concurrent append makes this re-read instead of overwriting it). Returns false when the thread or the
 * message is gone (a merged or deleted conversation): there is nothing to update.
 */
async function updateMessageDeliveries(
  db: SupabaseClient,
  target: InboxMessageTarget,
  apply: (current: InboxMessageDelivery[] | undefined) => InboxMessageDelivery[],
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("id, row_data, updated_at")
      .eq("id", target.threadId)
      .maybeSingle();
    const row = data as ThreadRow | null;
    if (error || !row?.row_data) return false;
    const rowData = row.row_data;
    const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as Record<string, unknown>[])] : [];
    const index = messages.findIndex((m) => m?.id === target.messageId);
    let nextRowData: Record<string, unknown>;
    if (index >= 0) {
      const current = messages[index]!;
      const next = apply(current.deliveries as InboxMessageDelivery[] | undefined);
      if (next === current.deliveries) return true;
      messages[index] = { ...current, deliveries: next };
      nextRowData = { ...rowData, messages };
    } else if (rowData.rootMessageId === target.messageId || target.messageId === `${row.id}-root`) {
      const current = rowData.rootDeliveries as InboxMessageDelivery[] | undefined;
      const next = apply(current);
      if (next === current) return true;
      nextRowData = { ...rowData, rootDeliveries: next };
    } else {
      return false;
    }
    const nowIso = new Date().toISOString();
    const prior = row.updated_at;
    // Strictly after the row we read, so the compare-and-set of any concurrent writer can see this write.
    const updatedAt = prior && Date.parse(prior) >= Date.parse(nowIso) ? new Date(Date.parse(prior) + 1).toISOString() : nowIso;
    let query = db.from("portal_inbox_thread_records").update({ row_data: nextRowData, updated_at: updatedAt }).eq("id", row.id);
    query = prior ? query.eq("updated_at", prior) : query.is("updated_at", null);
    const { data: written, error: writeError } = await query.select("id");
    if (writeError) return false;
    if ((written ?? []).length > 0) return true;
  }
  return false;
}

/**
 * What a message already recorded, per channel. Used by a retry of the SAME send (one `sendId`, so one
 * `messageId`): a channel the provider already took must not be charged and delivered twice, while a
 * channel with nothing recorded — a first attempt that died before its provider call — still goes out,
 * and so does one whose recorded attempt is `failed`. The caller decides which statuses suppress it.
 * A thread or message that is gone reads as nothing recorded.
 */
export async function readMessageDeliveries(
  db: SupabaseClient,
  target: InboxMessageTarget | null | undefined,
): Promise<InboxMessageDelivery[]> {
  if (!target?.threadId || !target.messageId) return [];
  try {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("id, row_data")
      .eq("id", target.threadId)
      .maybeSingle();
    const row = data as Pick<ThreadRow, "id" | "row_data"> | null;
    if (error || !row?.row_data) return [];
    const rowData = row.row_data;
    const messages = Array.isArray(rowData.messages) ? (rowData.messages as Record<string, unknown>[]) : [];
    const message = messages.find((m) => m?.id === target.messageId);
    const recorded = message
      ? message.deliveries
      : rowData.rootMessageId === target.messageId || target.messageId === `${row.id}-root`
        ? rowData.rootDeliveries
        : null;
    return Array.isArray(recorded) ? (recorded as InboxMessageDelivery[]) : [];
  } catch {
    return [];
  }
}

async function rememberProviderRef(
  db: SupabaseClient,
  ref: { providerId: string; channel: InboxDeliveryChannel } & InboxMessageTarget,
): Promise<void> {
  try {
    await db.from("inbox_message_provider_refs").upsert(
      { provider_id: ref.providerId, thread_record_id: ref.threadId, message_id: ref.messageId, channel: ref.channel },
      { onConflict: "provider_id" },
    );
  } catch {
    /* a missing ref only means a later status callback finds nothing to update */
  }
}

/**
 * Record what a send attempt did on one channel: the provider id and `sent`, or `failed` with the reason.
 * With a provider id, also remembers which message it belongs to so the status callback can find it.
 */
export async function recordInboxMessageDelivery(
  db: SupabaseClient,
  target: InboxMessageTarget | null | undefined,
  entry: Omit<InboxMessageDelivery, "at"> & { at?: string },
): Promise<InboxMessageDelivery> {
  const full: InboxMessageDelivery = { ...entry, at: entry.at ?? new Date().toISOString() };
  if (!target?.threadId || !target.messageId) return full;
  try {
    if (full.providerId) {
      await rememberProviderRef(db, { ...target, providerId: full.providerId, channel: full.channel });
    }
    await updateMessageDeliveries(db, target, (current) => mergeDelivery(current, full));
  } catch (error) {
    console.error("inbox delivery status not recorded", error instanceof Error ? error.message : error);
  }
  return full;
}

/** The provider-ref key of a text that was queued or deferred: it has no provider id until the dispatcher sends it. */
export function outboxProviderRef(outboxId: string): string {
  return `outbox:${outboxId}`;
}

/**
 * A text the outbox only ACCEPTED (deferred, queued) had no provider id when it was recorded, so its inbox message
 * was remembered under the outbox row instead (`outboxProviderRef`). When the dispatcher finally hands it to the
 * provider, the first status callback carries a MessageSid nobody recorded: find the outbox row that holds that sid,
 * follow it to the message, and remember the real sid so every later callback is a direct hit.
 */
async function refFromDeferredOutbox(
  db: SupabaseClient,
  providerId: string,
  channel: InboxDeliveryChannel,
): Promise<{ thread_record_id?: string; message_id?: string } | null> {
  try {
    const { data: outbox } = await db
      .from("sms_outbox")
      .select("id")
      .eq("provider_message_sid", providerId)
      .limit(1)
      .maybeSingle();
    const outboxId = String((outbox as { id?: unknown } | null)?.id ?? "").trim();
    if (!outboxId) return null;
    const { data } = await db
      .from("inbox_message_provider_refs")
      .select("thread_record_id, message_id")
      .eq("provider_id", outboxProviderRef(outboxId))
      .maybeSingle();
    const ref = data as { thread_record_id?: string; message_id?: string } | null;
    if (!ref?.thread_record_id || !ref.message_id) return null;
    await rememberProviderRef(db, {
      providerId,
      channel,
      threadId: ref.thread_record_id,
      messageId: ref.message_id,
    });
    return ref;
  } catch {
    return null;
  }
}

/**
 * A provider callback (Twilio status, Resend webhook): find the message this id was recorded against and
 * advance its delivery. Idempotent; an id nobody recorded is ignored.
 */
export async function applyProviderDeliveryStatus(
  db: SupabaseClient,
  args: {
    providerId: string;
    channel: InboxDeliveryChannel;
    status: InboxDeliveryState;
    error?: string;
  },
): Promise<{ updated: boolean }> {
  const providerId = args.providerId.trim();
  if (!providerId) return { updated: false };
  const { data } = await db
    .from("inbox_message_provider_refs")
    .select("thread_record_id, message_id")
    .eq("provider_id", providerId)
    .maybeSingle();
  let ref = data as { thread_record_id?: string; message_id?: string } | null;
  if (!ref?.thread_record_id && args.channel === "sms") {
    ref = await refFromDeferredOutbox(db, providerId, args.channel);
  }
  if (!ref?.thread_record_id || !ref.message_id) return { updated: false };
  const entry: InboxMessageDelivery = {
    channel: args.channel,
    providerId,
    status: args.status,
    ...(args.status === "failed" && args.error ? { error: args.error } : {}),
    at: new Date().toISOString(),
  };
  const updated = await updateMessageDeliveries(
    db,
    { threadId: ref.thread_record_id, messageId: ref.message_id },
    (current) => mergeDelivery(current, entry),
  );
  return { updated };
}

/** Outcome of one email attempt, as `sendPortalConversationEmails` reports it. */
export async function recordEmailAttempt(
  db: SupabaseClient,
  target: InboxMessageTarget | null | undefined,
  email: string,
  result: { sent: boolean; resendId: string | null } | undefined,
): Promise<InboxMessageDelivery | null> {
  // Sandbox accounts skip mail on purpose; that is not a failed delivery.
  if (isSandboxEmail(email)) return null;
  if (isPlaceholderMailbox(email)) {
    return recordInboxMessageDelivery(db, target, placeholderEmailDelivery(new Date().toISOString()));
  }
  if (result?.sent) {
    return recordInboxMessageDelivery(db, target, {
      channel: "email",
      status: "sent",
      ...(result.resendId ? { providerId: result.resendId } : {}),
    });
  } else {
    return recordInboxMessageDelivery(db, target, {
      channel: "email",
      status: "failed",
      error: "Email couldn't be sent",
    });
  }
}

/** Placeholder addresses are never sent to: record each as failed "Not a real mailbox" on its message. */
export async function recordPlaceholderEmailFailures(
  db: SupabaseClient,
  targets: ReadonlyMap<string, InboxMessageTarget>,
  emails: readonly string[],
): Promise<InboxMessageDelivery[]> {
  const recorded: InboxMessageDelivery[] = [];
  for (const email of emails) {
    if (isSandboxEmail(email) || !isPlaceholderMailbox(email)) continue;
    recorded.push(await recordInboxMessageDelivery(db, targets.get(email), placeholderEmailDelivery(new Date().toISOString())));
  }
  return recorded;
}

/** Outcome of one text attempt, as `sendResidentOutboundSms` reports it. */
export async function recordSmsAttempt(
  db: SupabaseClient,
  target: InboxMessageTarget | null | undefined,
  result: { sent: boolean; accepted?: boolean; sid?: string | null; error?: string | null; outboxId?: string | null } | null,
): Promise<InboxMessageDelivery> {
  if (result?.sent) {
    return recordInboxMessageDelivery(db, target, {
      channel: "sms",
      status: "sent",
      ...(result.sid ? { providerId: result.sid } : {}),
    });
  } else if (result?.accepted) {
    // Queued or deferred, not yet sent: there is no provider id, so the message is remembered under the outbox row and
    // the first status callback after the dispatcher sends it finds the message again (`refFromDeferredOutbox`).
    // Without it this stays "Sending…" for good.
    if (result.outboxId && target?.threadId && target.messageId) {
      await rememberProviderRef(db, { ...target, providerId: outboxProviderRef(result.outboxId), channel: "sms" });
    }
    return recordInboxMessageDelivery(db, target, { channel: "sms", status: "sending" });
  } else {
    return recordInboxMessageDelivery(db, target, {
      channel: "sms",
      status: "failed",
      error: smsSendErrorText(result?.error),
    });
  }
}

export function smsSendErrorText(error: string | null | undefined): string {
  const code = String(error ?? "").trim();
  if (code === "recipient_opted_out") return "They opted out of texts (replied STOP)";
  if (code === "invalid_to") return "That isn't a valid phone number";
  if (code === WORKSPACE_NO_WORK_NUMBER_CODE) return WORKSPACE_NO_WORK_NUMBER_MESSAGE;
  if (code === "control_plane_unreadable" || code === "line_unreadable") return "Couldn't check the work number. Try again";
  if (code.startsWith("comms_billing_")) return "Not enough text credit";
  if (code === "quiet_hours") return "Not sent during quiet hours (9 pm to 8 am Pacific)";
  if (code === "scoped_consent_missing") return "They haven't opted in to texts from this number";
  return "Text couldn't be sent";
}
