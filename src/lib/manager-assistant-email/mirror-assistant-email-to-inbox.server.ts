import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureManagerAgentNoticeThread } from "@/lib/agent-notify.server";
import { MANAGER_AGENT_NOTICE_FROM_NAME } from "@/lib/communication-assistant-inbox-list";
import { commitInboxThreadReply } from "@/lib/portal-inbox-delivery";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

async function loadAssistantThreadTarget(
  db: SupabaseClient,
  managerUserId: string,
) {
  const threadId = await ensureManagerAgentNoticeThread(db, managerUserId);
  const { data: freshRow } = await db
    .from("portal_inbox_thread_records")
    .select("id, scope, owner_user_id, participant_email, thread_type, row_data")
    .eq("id", threadId)
    .maybeSingle();
  if (!freshRow) return null;
  return {
    threadId,
    scope: String(freshRow.scope ?? MANAGER_INBOX_SCOPE),
    ownerUserId: (freshRow.owner_user_id as string | null) ?? managerUserId,
    participantEmail: (freshRow.participant_email as string | null) ?? null,
    threadType: String(freshRow.thread_type ?? "agent_notice"),
    rowData: (freshRow.row_data ?? {}) as Record<string, unknown>,
  };
}

function threadAlreadyHasMessage(
  rowData: Record<string, unknown>,
  messageId: string,
): boolean {
  const messages = Array.isArray(rowData.messages) ? rowData.messages : [];
  return messages.some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      String((entry as { id?: string }).id ?? "") === messageId,
  );
}

/** Mirror an assistant-email turn into the manager's PropLane Assistant Communication thread. */
export async function mirrorAssistantEmailTurnToInbox(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    managerDisplayName: string;
    inboundText: string;
    replyText: string;
    inboundEmailId: string;
  },
): Promise<void> {
  const inboundId = `assistant-email-in-${args.inboundEmailId.trim()}`;
  const replyId = `assistant-email-out-${args.inboundEmailId.trim()}`;

  const target = await loadAssistantThreadTarget(db, args.managerUserId);
  if (!target) return;
  if (threadAlreadyHasMessage(target.rowData, inboundId)) return;

  const managerName = args.managerDisplayName.trim() || "You";
  await commitInboxThreadReply(db, target, {
    fromName: managerName,
    text: args.inboundText,
    outbound: true,
    messageId: inboundId,
  });

  const replyTarget = await loadAssistantThreadTarget(db, args.managerUserId);
  if (!replyTarget || threadAlreadyHasMessage(replyTarget.rowData, replyId)) return;

  await commitInboxThreadReply(db, replyTarget, {
    fromName: MANAGER_AGENT_NOTICE_FROM_NAME,
    text: args.replyText,
    outbound: false,
    messageId: replyId,
  });
}
