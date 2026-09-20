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
import { captureSmsTestDelivery } from "@/lib/sms/sms-test-transport.server";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const MANAGER_AGENT_FROM_NAME = "PropLane Assistant";

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
    inboxAlreadySent = alreadySent;

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
          // This remains an assistant conversation even when the latest
          // notice is an escalation. Changing the routing type made its next
          // reply fall through to human-recipient validation with no recipient.
          thread_type: "agent_notice",
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
            threadType: "agent_notice",
            messages: [
              ...priorMessages,
              { id: messageId, from: "PropLane Assistant", body: args.text, at: nowIso, outbound: false,
                ...(args.threadType ? { noticeType: args.threadType } : {}) },
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

  if (channels.inbox && args.notify?.push !== false && !inboxAlreadySent) {
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
