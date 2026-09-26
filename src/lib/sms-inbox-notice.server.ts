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
  },
): Promise<void> {
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
  };
  // Ignore the insert conflict, then append under compare-and-swap. Parallel
  // webhooks must never overwrite each other's message history.
  const { data: inserted, error: insertError } = await db.from("portal_inbox_thread_records")
    .upsert({ id: threadId, scope: MANAGER_INBOX_SCOPE, owner_user_id: args.managerUserId,
      participant_email: null, thread_type: args.threadType, row_data: incoming,
      updated_at: now.toISOString() }, { onConflict: "id", ignoreDuplicates: true }).select("id");
  if (insertError) throw new Error("Could not store the SMS inbox notice.");
  if (inserted?.length) return;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: prior, error } = await db.from("portal_inbox_thread_records")
      .select("row_data, updated_at").eq("id", threadId)
      .eq("owner_user_id", args.managerUserId).eq("scope", MANAGER_INBOX_SCOPE).single();
    if (error || !prior) throw new Error("Could not load the SMS inbox conversation.");
    const row = prior.row_data as Record<string, unknown>;
    const messages = Array.isArray(row.messages) ? row.messages as { id: string }[] : [];
    if (row.rootMessageId === messageId || messages.some((m) => m.id === messageId)) return;
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(prior.updated_at) + 1)).toISOString();
    // Only a genuinely INBOUND turn (no explicit `folder`, or `folder:
    // "inbox"`) may reopen an archived notice — an outbound append
    // (`folder: "sent"`, e.g. the manager's own relayed text) must never
    // un-archive it. Forcing "inbox" on every append here regardless of
    // direction resurrected an archived SMS conversation on its next
    // outbound turn (captain resurrection sweep).
    const inbound = args.folder !== "sent";
    const reopens = inbound && row.folder === "trash";
    const { data: updated, error: updateError } = await db.from("portal_inbox_thread_records")
      .update({ row_data: { ...row, folder: inbound ? "inbox" : (row.folder ?? "inbox"), preview: incoming.preview,
        time: stamp, unread: Boolean(row.unread) || incoming.unread,
        messages: [...messages, { id: messageId, from: args.from, body: args.body,
          at: stamp, outbound: args.folder === "sent" }] }, updated_at: updatedAt })
      .eq("id", threadId).eq("owner_user_id", args.managerUserId)
      .eq("scope", MANAGER_INBOX_SCOPE).eq("updated_at", prior.updated_at).select("id");
    if (updateError) throw new Error("Could not append the SMS inbox notice.");
    if (updated?.length) {
      // Both archive stores move together: the notice's OWN `row_data.folder`
      // (above) and the separate SMS-conversation view's
      // `manager_tour_followup_controls.archived` (read by
      // fetchManagerSmsConversations / mirrorManagerSmsArchivedFromServer).
      // Leaving the controls flag `true` after a genuine reopen kept that
      // conversation showing in Archived while its own notice thread had
      // already returned to Active. The exact role is not known at this
      // layer, so every role variant of this phone's conversation key is
      // cleared — a plain UPDATE...WHERE never inserts a row, so a role that
      // never had a control row is an inert no-op.
      if (reopens && phone) {
        const keys = SMS_COUNTERPARTY_ROLES.map((role) =>
          buildConversationKey({ ownerManagerUserId: args.managerUserId, role, counterpartyPhone: phone }),
        );
        await db.from("manager_tour_followup_controls")
          .update({ archived: false, updated_at: now.toISOString() })
          .eq("manager_user_id", args.managerUserId)
          .in("conversation_key", keys)
          .eq("archived", true);
      }
      return;
    }
  }
  throw new Error("SMS inbox conversation is busy; retry delivery.");
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
