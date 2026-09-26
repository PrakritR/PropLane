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
    ? `sms_notice_${createHash("sha256").update(`${args.managerUserId}:${phone}`).digest("hex")}`
    : `${args.idPrefix}_${Date.now()}_${randomUUID()}`;
  const now = new Date();
  const stamp = formatInboxStamp(now);
  const incoming = {
    id: threadId, folder: args.folder ?? "inbox", from: args.from, email: "",
    subject: args.subject, preview: args.preview.slice(0, 100).replace(/\n/g, " "),
    body: args.body, rootAt: stamp, time: stamp, unread: args.unread ?? true,
    scope: MANAGER_INBOX_SCOPE, ownerUserId: args.managerUserId,
    threadType: args.threadType, smsNoticePhone: phone || undefined,
    rootMessageId: messageId, rootOutbound: args.folder === "sent",
    ...(args.originalSmsEvent ? { rootOriginalSmsEvent: args.originalSmsEvent } : {}),
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
      outbound: args.folder === "sent",
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
