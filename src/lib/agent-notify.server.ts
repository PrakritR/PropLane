/**
 * Inbox + push (+ optional SMS) notice to the owning manager, sent as "PropLane
 * Assistant". Direct thread-row write like executeSendRentReminder because
 * deliverPortalInboxMessage skips sender==recipient by design. Standalone
 * module so both the dispatch pipeline and the vendor agent's escalate tool
 * can use it without an import cycle.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { sendPushToUser } from "@/lib/push-notifications.server";
import {
  resolveManagerNotificationChannels,
  sendManagerNotificationSms,
} from "@/lib/manager-notification-routing.server";
import type { ManagerNotificationCategory } from "@/lib/manager-notification-preferences";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

export async function notifyManagerFromAgent(
  db: SupabaseClient,
  args: {
    landlordId: string;
    subject: string;
    text: string;
    threadType?: string;
    url?: string;
    category?: ManagerNotificationCategory;
    notify?: { push: boolean; sms: boolean };
    /** Stable identity for retryable notices. Makes inbox + SMS retries idempotent. */
    idempotencyKey?: string;
    /** PII-minimized copy for push/SMS lock screens. Inbox keeps the full text. */
    externalText?: string;
  },
): Promise<{ delivered: boolean; suppressed: boolean }> {
  const channels = await resolveManagerNotificationChannels(
    db,
    args.landlordId,
    args.category ?? "messages",
  );
  const nowIso = new Date().toISOString();
  /**
   * ONE PropLane Assistant thread per manager.
   *
   * Every notice used to mint its own id — `Date.now()` plus a random suffix
   * when no idempotency key was supplied — so the inbox filled with a separate
   * "PropLane Assistant" conversation per notification. Reported as "there are
   * so many proplane assisntnts not sure why. there should be one sinuglar
   * proplane assisntants that you can message" (AXI-150).
   *
   * Notices are now turns in a single conversation. `idempotencyKey` keeps
   * doing its job at the MESSAGE level instead of the thread level: a retry
   * carries the same message id and is skipped rather than appended twice.
   */
  const threadId = `agent_notice_${args.landlordId}`;
  const messageId = args.idempotencyKey
    ? `agent_notice_msg_${createHash("sha256").update(`${args.landlordId}:${args.idempotencyKey}`).digest("hex").slice(0, 24)}`
    : `agent_notice_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  let inboxDelivered = false;
  if (channels.inbox) {
    const { data: existingRow } = await db
      .from("portal_inbox_thread_records")
      .select("row_data")
      .eq("id", threadId)
      .maybeSingle();

    const existing = (existingRow?.row_data ?? null) as
      | { messages?: { id?: string }[]; folder?: string }
      | null;
    const priorMessages = Array.isArray(existing?.messages) ? existing.messages : [];
    const alreadySent = priorMessages.some((m) => m?.id === messageId);

    if (alreadySent) {
      // A retry of a notice already in the thread. Delivered, nothing appended.
      inboxDelivered = true;
    } else {
      const preview = args.text.slice(0, 100).replace(/\n/g, " ");
      const { error } = await db.from("portal_inbox_thread_records").upsert(
        {
          id: threadId,
          scope: MANAGER_INBOX_SCOPE,
          owner_user_id: args.landlordId,
          participant_email: null,
          thread_type: args.threadType ?? "agent_notice",
          row_data: {
            id: threadId,
            // A new notice pulls the thread back out of trash — the manager is
            // being told something now, not being shown an old conversation.
            folder: "inbox",
            from: "PropLane Assistant",
            email: "",
            subject: args.subject,
            preview,
            body: args.text,
            unread: true,
            scope: MANAGER_INBOX_SCOPE,
            messages: [
              ...priorMessages,
              { id: messageId, from: "PropLane Assistant", body: args.text, at: nowIso, outbound: false },
            ],
          },
          updated_at: nowIso,
        },
        { onConflict: "id" },
      );
      if (error) throw error;
      inboxDelivered = true;
    }
  }

  if (channels.inbox && args.notify?.push !== false) {
    try {
      await sendPushToUser(args.landlordId, {
        title: args.subject,
        body: (args.externalText ?? args.text).slice(0, 120).replace(/\n/g, " "),
        url: args.url ?? "/portal/communication/inbox/unopened",
      });
    } catch {
      /* push is best-effort; the inbox row is the durable notice */
    }
  }

  const smsRequested = channels.sms && args.notify?.sms !== false;
  let smsDelivered = false;
  if (smsRequested) {
    const sms = await sendManagerNotificationSms(db, {
      managerUserId: args.landlordId,
      category: args.category ?? "messages",
      subject: args.subject,
      text: args.externalText ?? args.text,
      purpose: `manager_agent_notification_${args.category ?? "messages"}`,
      dedupeKey: args.idempotencyKey
        ? `manager-agent:${args.landlordId}:${args.idempotencyKey}`
        : undefined,
    });
    smsDelivered = sms.sent;
    if (!smsDelivered) throw new Error("Manager SMS was not accepted for delivery.");
  }

  const suppressed = !channels.inbox && !smsRequested;
  return { delivered: inboxDelivered || smsDelivered, suppressed };
}
