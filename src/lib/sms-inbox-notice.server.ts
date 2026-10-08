/**
 * Shared delivery helpers for SMS-originated manager notices, used by both
 * inbound-SMS paths (work-number → Axis inbox, and the proxy-pair relay
 * mirror) so the two never drift.
 *
 * Direct thread-row write (the notifyManagerFromAgent pattern) because
 * deliverPortalInboxMessage drops recipients whose email equals the sender's —
 * a self-addressed notice would silently deliver to no one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";
import { smsNoticePhone } from "@/lib/sms-inbox-identity";
import { buildConversationKey, SMS_COUNTERPARTY_ROLES } from "@/lib/sms-conversation-identity";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { resolveSmsConversationRef } from "@/lib/communication/conversation-key.server";
import { conversationRowData } from "@/lib/communication/conversation-thread.server";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

/** Exact original SMS evidence, attached to each notice message independently.
 * A phone-level notice thread may contain unrelated line/role histories. */
export type OriginalSmsNoticeEvent = {
  sourceNamespace: string;
  sourceEventId: string;
  ownerManagerUserId: string;
  counterpartyRole: string;
  workLineId: string;
  occurredAt: string;
  bodySha256: string;
};

/** Thread id of the SMS compatibility notice for one manager + counterparty phone. */
export function smsNoticeThreadId(managerUserId: string, phone: string): string {
  return `sms_notice_${createHash("sha256").update(`${managerUserId}:${phone}`).digest("hex")}`;
}

export async function upsertManagerInboxNotice(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    idPrefix: string;
    threadType: string;
    folder?: "inbox" | "sent";
    from: string;
    subject: string;
    preview: string;
    body: string;
    unread?: boolean;
    counterpartyPhone?: string;
    messageId?: string;
    originalSmsEvent?: OriginalSmsNoticeEvent;
  },
): Promise<{ threadId: string; messageId: string }> {
  const phone = smsNoticePhone(args.counterpartyPhone || args.from);
  const messageId = args.messageId || randomUUID();
  const threadId = phone
    ? smsNoticeThreadId(args.managerUserId, phone)
    : `${args.idPrefix}_${Date.now()}_${randomUUID()}`;
  const now = new Date();
  const stamp = formatInboxStamp(now);
  // The notice stays its own compatibility row (its id, archive controls and
  // source markers are keyed to the phone), but it carries the SAME conversation
  // key as the person's thread and the SMS projection, so the inbox shows one
  // conversation. Best-effort: no key is never an error.
  const ref = phone
    ? await resolveSmsConversationRef(db, {
        ownerManagerUserId: args.managerUserId,
        workLineId: args.originalSmsEvent?.workLineId ?? null,
        counterpartyPhone: phone,
      }).catch(() => null)
    : null;
  const incoming = {
    id: threadId, folder: args.folder ?? "inbox", from: args.from, email: "",
    subject: args.subject, preview: args.preview.slice(0, 100).replace(/\n/g, " "),
    body: args.body, rootAt: stamp, time: stamp, unread: args.unread ?? true,
    scope: MANAGER_INBOX_SCOPE, ownerUserId: args.managerUserId,
    threadType: args.threadType, smsNoticePhone: phone || undefined,
    rootMessageId: messageId, rootOutbound: args.folder === "sent",
    // Every turn here is a text. Stamped so the Communication composer replies
    // on the channel the person used (a text) instead of defaulting to In-app.
    rootChannel: "sms",
    ...(args.originalSmsEvent ? { rootOriginalSmsEvent: args.originalSmsEvent } : {}),
    ...conversationRowData(ref),
  };
  const controlKeys = phone ? SMS_COUNTERPARTY_ROLES.map((role) =>
    buildConversationKey({ ownerManagerUserId: args.managerUserId, role, counterpartyPhone: phone })) : [];
  const { data, error } = await db.rpc("append_manager_sms_inbox_notice", {
    p_owner: args.managerUserId,
    p_thread_id: threadId,
    p_thread_type: args.threadType,
    p_message_id: messageId,
    p_incoming: incoming,
    p_message: { id: messageId, from: args.from, body: args.body, at: stamp,
      outbound: args.folder === "sent", channel: "sms",
      ...(args.originalSmsEvent ? { originalSmsEvent: args.originalSmsEvent } : {}) },
    p_inbound: args.folder !== "sent",
    p_control_keys: controlKeys,
  });
  if (error || !data || data.threadId !== threadId || data.messageId !== messageId) {
    throw new Error("Could not append the SMS inbox notice.");
  }
  return { threadId, messageId };
}

export async function sendManagerNoticeEmail(args: {
  managerUserId: string;
  toEmail: string | null | undefined;
  subject: string;
  text: string;
}): Promise<void> {
  const managerEmail = String(args.toEmail ?? "").trim().toLowerCase();
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey || !managerEmail.includes("@") || managerEmail.endsWith("@axis.local")) return;
  await postResendEmail({
    apiKey: resendKey,
    actorUserId: args.managerUserId,
    effectSummary: "Manager SMS notice email captured for the test workspace.",
    payload: {
      from: process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>",
      to: [managerEmail],
      subject: args.subject,
      text: args.text,
    },
  }).catch(() => undefined);
}

/**
 * Record a reply the SERVER sent (the leasing/resident SMS agent, a template
 * answer) as an outbound turn on the person's SMS notice thread, so the
 * Communication thread shows the sent reply and `inboxThreadManagerReplyPending`
 * is false: the browser's AI-draft path must never also draft/send for an
 * inbound text a server agent already answered (one responder per inbound).
 *
 * Append-only and best-effort: it never creates a thread (an inbound notice that
 * failed to land has nothing to reply under) and never throws. Idempotent on
 * `auto_reply_<inboundMessageId>`, so a replayed delivery appends nothing twice.
 */
export async function recordAutoReplyOnSmsNotice(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    counterpartyPhone: string;
    text: string;
    /** The inbound text this answers (Twilio SID); makes the append idempotent. */
    inboundMessageId?: string | null;
  },
): Promise<boolean> {
  try {
    const phone = smsNoticePhone(args.counterpartyPhone);
    const text = args.text.trim();
    if (!phone || !text || !args.managerUserId.trim()) return false;
    const threadId = smsNoticeThreadId(args.managerUserId, phone);
    const { data: existing } = await db
      .from("portal_inbox_thread_records")
      .select("id, thread_type")
      .eq("id", threadId)
      .eq("owner_user_id", args.managerUserId)
      .maybeSingle();
    if (!existing) return false;
    const inboundId = args.inboundMessageId?.trim();
    await upsertManagerInboxNotice(db, {
      managerUserId: args.managerUserId,
      idPrefix: "sms_auto_reply",
      threadType: String((existing as { thread_type?: unknown }).thread_type ?? "claw_leasing_sms"),
      folder: "sent",
      // Same author name as `MANAGER_AGENT_NOTICE_FROM_NAME`, inlined to keep
      // this server module free of the inbox-list client imports.
      from: "PropLane Assistant",
      counterpartyPhone: phone,
      subject: "Reply",
      preview: text,
      body: text,
      unread: false,
      messageId: inboundId ? `auto_reply_${inboundId}` : undefined,
    });
    return true;
  } catch (error) {
    console.error("sms notice auto-reply record failed", error instanceof Error ? error.message : "unknown");
    return false;
  }
}

/** `recordAutoReplyOnSmsNotice` for a caller that holds no database client. */
export async function recordAutoReplyOnSmsNoticeFresh(
  args: Parameters<typeof recordAutoReplyOnSmsNotice>[1],
): Promise<boolean> {
  try {
    const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/service");
    return await recordAutoReplyOnSmsNotice(createSupabaseServiceRoleClient(), args);
  } catch {
    return false;
  }
}
