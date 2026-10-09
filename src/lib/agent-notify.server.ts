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
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  managerAgentNoticeThreadId,
  type ManagerAssistantWorkspace,
} from "@/lib/communication-manager-assistant-thread";
import { resolveActiveWorkspaceFromRequest } from "@/lib/workspaces/active.server";
import { appendSmsTurnToManagerAssistantThread } from "@/lib/sms/manager-assistant-thread-mirror.server";
import { captureSmsTestDelivery } from "@/lib/sms/sms-test-transport.server";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const MANAGER_AGENT_FROM_NAME = "PropLane Assistant";
/** Compare-and-retry attempts on the shared Assistant thread row. */
const NOTICE_APPEND_ATTEMPTS = 4;

/**
 * Jittered pause before a retry. Back-to-back compare-and-set attempts burn all
 * four inside a millisecond, which loses to the SMS mirror appending to the same
 * row; the jitter also keeps two notices landing at once from retrying in step.
 */
function noticeAppendBackoff(attempt: number): Promise<void> {
  const base = 25 * 2 ** (attempt - 1);
  return new Promise((resolve) => setTimeout(resolve, base + Math.floor(Math.random() * base)));
}

async function managerNoticeWorkspace(
  db: SupabaseClient,
  landlordId: string,
  propertyId?: string | null,
): Promise<ManagerAssistantWorkspace | null> {
  const houseId = propertyId?.trim();
  if (houseId) {
    const { data } = await db
      .from("manager_property_records")
      .select("workspace_id")
      .eq("id", houseId)
      .maybeSingle();
    const workspaceId = typeof data?.workspace_id === "string" ? data.workspace_id.trim() : "";
    if (workspaceId) {
      const { data: workspace } = await db
        .from("portal_workspaces")
        .select("id, is_default")
        .eq("id", workspaceId)
        .maybeSingle();
      if (workspace?.id) {
        return { id: String(workspace.id), isDefault: Boolean(workspace.is_default) };
      }
      return { id: workspaceId, isDefault: false };
    }
  }
  try {
    const active = await resolveActiveWorkspaceFromRequest(db, landlordId);
    return { id: active.id, isDefault: active.isDefault };
  } catch {
    return null;
  }
}

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
    /** When set, the notice lands in that house's workspace assistant chat. */
    propertyId?: string | null;
  },
): Promise<{ delivered: boolean; suppressed: boolean }> {
  if (captureSmsTestDelivery({
    kind: "manager_notification",
    summary: args.subject.trim() || "Manager notification captured in the test conversation.",
    status: "captured",
    metadata: {
      category: args.category ?? "messages",
      pushRequested: args.notify?.push !== false,
      smsRequested: args.notify?.sms !== false,
    },
  })) {
    return { delivered: true, suppressed: false };
  }
  const channels = await resolveManagerNotificationChannels(
    db,
    args.landlordId,
    args.category ?? "messages",
  );
  const nowIso = new Date().toISOString();
  /**
   * ONE PropLane Assistant thread per manager per workspace. Legacy
   * `agent_notice_{userId}` stays the default workspace's chat.
   */
  const workspace = await managerNoticeWorkspace(db, args.landlordId, args.propertyId);
  const threadId = managerAgentNoticeThreadId(args.landlordId, workspace);
  const messageId = args.idempotencyKey
    ? `agent_notice_msg_${createHash("sha256").update(`${args.landlordId}:${args.idempotencyKey}`).digest("hex").slice(0, 24)}`
    : `agent_notice_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  let inboxDelivered = false;
  let inboxAlreadySent = false;
  if (channels.inbox) {
    const preview = args.text.slice(0, 100).replace(/\n/g, " ");
    // Read-modify-write on a row the SMS mirror also appends to: guard the write
    // on the `updated_at` we read and retry, or a turn mirrored in between is
    // silently overwritten.
    for (let attempt = 0; attempt < NOTICE_APPEND_ATTEMPTS && !inboxDelivered; attempt += 1) {
      if (attempt > 0) await noticeAppendBackoff(attempt);
      const { data: existingRow, error: readError } = await db
        .from("portal_inbox_thread_records")
        .select("row_data, updated_at")
        .eq("id", threadId)
        .maybeSingle();
      if (readError) throw readError;

      const existing = (existingRow?.row_data ?? null) as
        | { messages?: { id?: string }[]; folder?: string }
        | null;
      const priorMessages = Array.isArray(existing?.messages) ? existing.messages : [];
      if (priorMessages.some((m) => m?.id === messageId)) {
        // A retry of a notice already in the thread. Delivered, nothing appended.
        inboxAlreadySent = true;
        inboxDelivered = true;
        break;
      }

      const rowData = {
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
        threadType: "agent_notice",
        messages: [
          ...priorMessages,
          { id: messageId, from: "PropLane Assistant", body: args.text, at: nowIso, outbound: false,
            ...(args.threadType ? { noticeType: args.threadType } : {}) },
        ],
      };

      if (!existingRow) {
        const { error } = await db.from("portal_inbox_thread_records").insert({
          id: threadId,
          scope: MANAGER_INBOX_SCOPE,
          owner_user_id: args.landlordId,
          participant_email: null,
          // This remains an assistant conversation even when the latest
          // notice is an escalation. Changing the routing type made its next
          // reply fall through to human-recipient validation with no recipient.
          thread_type: "agent_notice",
          row_data: rowData,
          updated_at: nowIso,
        });
        // Someone else created the thread first: re-read and append to theirs.
        if (error && error.code !== "23505") throw error;
        if (!error) inboxDelivered = true;
        continue;
      }

      let update = db
        .from("portal_inbox_thread_records")
        .update({
          scope: MANAGER_INBOX_SCOPE,
          owner_user_id: args.landlordId,
          thread_type: "agent_notice",
          row_data: rowData,
          updated_at: nowIso,
        })
        .eq("id", threadId);
      // Optimistic guard: a concurrent append moves updated_at and we re-read.
      update = existingRow.updated_at ? update.eq("updated_at", existingRow.updated_at) : update;
      const { data: written, error } = await update.select("id");
      if (error) throw error;
      if ((Array.isArray(written) ? written.length : written ? 1 : 0) > 0) inboxDelivered = true;
    }
    // Never report a notice as delivered that no row holds — but a contended
    // thread must not also cost the manager their text: fall through to the SMS
    // path and let `delivered` come from whichever channel actually carried it.
    if (!inboxDelivered) {
      console.error("manager notice could not be appended to the PropLane Assistant thread", {
        landlordId: args.landlordId,
        threadId,
        attempts: NOTICE_APPEND_ATTEMPTS,
      });
    }
  }

  // Only a notice a row actually holds may be pushed: the push opens Communication, and
  // a tap that lands on a thread without the message is worse than no push at all.
  if (channels.inbox && inboxDelivered && args.notify?.push !== false && !inboxAlreadySent) {
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
    // The notice went to their phone too: keep ONE Assistant thread with the
    // in-app copy marked SMS (or, when the destination is SMS-only, the copy
    // itself). Same message id as the inbox write, so a retry appends nothing.
    const mirrored = await appendSmsTurnToManagerAssistantThread(db, {
      ownerUserId: args.landlordId,
      workspaceId: workspace?.id ?? null,
      messageId,
      author: "assistant",
      body: args.text,
      ...(args.threadType ? { noticeType: args.threadType } : {}),
    });
    // The text already went out; never throw here (a retry would risk a resend).
    if (!mirrored.ok) console.error("manager notice SMS sent but Assistant thread copy failed", mirrored.error);
  }

  const suppressed = !channels.inbox && !smsRequested;
  // smsDelivered is true here when requested (a refused SMS threw above); the thread copy never decides delivery.
  return { delivered: inboxDelivered || smsDelivered, suppressed };
}

/**
 * Create the manager's PropLane Assistant inbox thread if missing.
 *
 * Idempotent on the manager+workspace thread id so Communication always has a
 * conversation to open even before the first agent notification lands.
 */
export async function ensureManagerAgentNoticeThread(
  db: SupabaseClient,
  landlordId: string,
  workspace?: ManagerAssistantWorkspace | null,
): Promise<string> {
  const resolved = workspace ?? (await managerNoticeWorkspace(db, landlordId));
  const threadId = managerAgentNoticeThreadId(landlordId.trim(), resolved);
  const { data: existing } = await db
    .from("portal_inbox_thread_records")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (existing) return threadId;

  const when = formatPacificDateTime(new Date());
  const intro = [
    "Hi — I am PropLane Assistant.",
    "",
    "Ask me about residents, leases, maintenance, tours, or anything else in your portfolio.",
    "When something needs your OK, I will show you exactly what it is before anything happens.",
  ].join("\n");

  const { error } = await db.from("portal_inbox_thread_records").upsert(
    {
      id: threadId,
      scope: MANAGER_INBOX_SCOPE,
      owner_user_id: landlordId,
      participant_email: null,
      thread_type: "agent_notice",
      row_data: {
        id: threadId,
        folder: "inbox",
        from: MANAGER_AGENT_FROM_NAME,
        email: "",
        subject: "PropLane Assistant",
        preview: intro.slice(0, 100).replace(/\n/g, " "),
        time: when,
        unread: false,
        scope: MANAGER_INBOX_SCOPE,
        threadType: "agent_notice",
        body: intro,
        messages: [],
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw error;
  return threadId;
}
