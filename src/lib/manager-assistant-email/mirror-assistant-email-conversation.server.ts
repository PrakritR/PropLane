import "server-only";

/**
 * Put work-email traffic from a NON-manager into the manager's Communication tab.
 *
 * `mirrorAssistantEmailTurnToInbox` writes into the manager's own "PropLane
 * Assistant" thread, which is right when the manager is the one writing in — it
 * is their conversation with their assistant. It is wrong for a prospect or a
 * resident: their mail belongs in a conversation with THEM, next to every other
 * thread with that person, the way an emailed reply already does.
 *
 * Both messages land on one thread, keyed the same way normal messaging keys a
 * person-pair, so a prospect who emails twice does not mint two conversations
 * and an existing thread with that address is appended to rather than shadowed.
 *
 * Deterministic message ids make a Resend redelivery a no-op: the webhook
 * retries on 5xx, and the inbound id is the only thing that stays stable across
 * those attempts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MANAGER_AGENT_NOTICE_FROM_NAME } from "@/lib/communication-assistant-inbox-list";
import {
  commitInboxThreadReply,
  deliverPortalMessageThreadSide,
  scopeForRole,
} from "@/lib/portal-inbox-delivery";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";

function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export async function mirrorAssistantEmailConversation(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    /** The mailbox owner's own address — the `participant_email` of their inbox copy. */
    managerEmail: string;
    senderEmail: string;
    senderName: string;
    subject: string;
    inboundText: string;
    /** Null when nothing was sent back; the inbound is still mirrored. */
    replyText: string | null;
    inboundEmailId: string;
  },
): Promise<void> {
  const senderEmail = args.senderEmail.trim().toLowerCase();
  const managerEmail = args.managerEmail.trim().toLowerCase();
  const inboundText = args.inboundText.trim();
  if (!args.managerUserId.trim() || !senderEmail.includes("@") || !inboundText) return;

  const emailId = args.inboundEmailId.trim();
  const scope = scopeForRole("manager");
  const when = formatInboxStamp(new Date());
  const fromName = args.senderName.trim() || senderEmail;
  const subject = args.subject.trim() || "(no subject)";

  const inbound = await deliverPortalMessageThreadSide(db, {
    scope,
    folder: "inbox",
    ownerUserId: args.managerUserId,
    participantEmail: managerEmail || null,
    otherPartyEmail: senderEmail,
    fallbackId: `assistant-email-${emailId}`,
    fromName,
    subject,
    body: inboundText,
    preview: previewOf(inboundText),
    when,
    unread: true,
    outbound: false,
    messageId: `assistant-email-in-${emailId}`,
  });

  const replyText = args.replyText?.trim() ?? "";
  if (!replyText) return;

  /* Re-read rather than reuse the shape above: the append just moved the thread
     on, and `commitInboxThreadReply` merges onto a fresh `row_data` for the same
     reason — a concurrent delivery in this window must not be dropped. */
  const { data: threadRow } = await db
    .from("portal_inbox_thread_records")
    .select("id, scope, owner_user_id, participant_email, thread_type, row_data")
    .eq("id", inbound.threadId)
    .maybeSingle();
  if (!threadRow) return;

  const rowData = (threadRow.row_data ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(rowData.messages) ? rowData.messages : [];
  const replyId = `assistant-email-out-${emailId}`;
  const alreadyReplied =
    String(rowData.rootMessageId ?? "") === replyId ||
    messages.some((entry) => String((entry as { id?: unknown } | null)?.id ?? "") === replyId);
  if (alreadyReplied) return;

  await commitInboxThreadReply(
    db,
    {
      threadId: String(threadRow.id),
      scope: String(threadRow.scope ?? scope),
      ownerUserId: (threadRow.owner_user_id as string | null) ?? args.managerUserId,
      participantEmail: (threadRow.participant_email as string | null) ?? (managerEmail || null),
      threadType: String(threadRow.thread_type ?? "portal_message"),
      rowData,
    },
    {
      fromName: MANAGER_AGENT_NOTICE_FROM_NAME,
      text: replyText,
      // The assistant answered on the manager's behalf, so from the manager's
      // side of the thread this is an outgoing message, not something to read.
      outbound: true,
      messageId: replyId,
    },
  );
}
