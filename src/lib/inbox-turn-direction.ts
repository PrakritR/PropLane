import {
  inboxThreadMessages,
  type InboxThreadMessage,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

function isManagerAgentNoticeThread(thread: InboxThreadForTurns & { id?: string }): boolean {
  const type = String(thread.threadType ?? thread.thread_type ?? "").trim();
  if (type === "agent_notice") return true;
  return Boolean(thread.id?.startsWith("agent_notice_"));
}

function isLegacyManagerAgentNoticeBody(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  return (
    /\bWhen:\s*/i.test(text) ||
    /\bWith:\s*/i.test(text) ||
    /\bDetails:\s*/i.test(text) ||
    /View it here:/i.test(text)
  );
}

function isManagerAgentNoticeTurn(
  thread: InboxThreadForTurns & { id?: string },
  message: InboxThreadMessage,
): boolean {
  if (message.automated) return true;
  const extended = message as InboxThreadMessage & { noticeType?: string };
  if (extended.noticeType) return true;
  if (!isManagerAgentNoticeThread(thread)) return false;
  if (!isPropLaneAssistantAuthor(message.from)) return false;
  return isLegacyManagerAgentNoticeBody(message.body);
}

/** Shown as the other party on the resident / vendor assistant conversation. */
export const PROPLANE_ASSISTANT_FROM = "PropLane Assistant";
export const RESIDENT_AGENT_THREAD_TYPE = "resident_agent";
export const VENDOR_AGENT_THREAD_TYPE = "vendor_agent";

export type InboxThreadForTurns = {
  from?: string | null;
  email?: string | null;
  folder?: PersistedInboxThread["folder"];
  previousFolder?: PersistedInboxThread["previousFolder"];
  threadType?: string | null;
  thread_type?: string | null;
};

/**
 * Bubble kind from the viewer's chair.
 * - inbound: other person, left, gray
 * - outbound: the viewer, right, cobalt
 * - assistant: PropLane Assistant ice (never labelled as You). Left in the
 *   assistant conversation; right in person-thread notices/reminders.
 * - system: an auto-sent lifecycle turn (`InboxThreadMessage.automated`) —
 *   centered notice text, not a chat bubble, never "You" or a person's name.
 */
export type InboxTurnDirection = "inbound" | "outbound" | "assistant" | "system";

export function isPropLaneAssistantAuthor(from: string | null | undefined): boolean {
  return String(from ?? "").trim() === PROPLANE_ASSISTANT_FROM;
}

/**
 * True when this conversation's other party is PropLane Assistant, not a
 * human. Payment reminders can be *authored* as the assistant while the
 * thread is still with a resident (they carry that resident's email) — those
 * stay ordinary person-threads so the manager's sent copy stays on the right
 * unless the turn itself is assistant-authored (ice, not "You").
 */
export function isConversationWithPropLaneAssistant(thread: InboxThreadForTurns): boolean {
  const type = String(thread.threadType ?? thread.thread_type ?? "").trim();
  if (type === RESIDENT_AGENT_THREAD_TYPE || type === VENDOR_AGENT_THREAD_TYPE) return true;
  if (!isPropLaneAssistantAuthor(thread.from)) return false;
  return !String(thread.email ?? "").includes("@");
}

export function inboxThreadFolderForTurns(
  thread: Pick<InboxThreadForTurns, "folder" | "previousFolder">,
): "inbox" | "sent" {
  if (thread.folder === "sent") return "sent";
  if (thread.folder === "trash" && thread.previousFolder === "sent") return "sent";
  return "inbox";
}

export function inboxTurnDirection(
  thread: InboxThreadForTurns & { id?: string },
  message: InboxThreadMessage,
  index: number,
  folder: PersistedInboxThread["folder"],
): InboxTurnDirection {
  if (isManagerAgentNoticeTurn(thread, message)) return "system";
  if (isPropLaneAssistantAuthor(message.from)) return "assistant";
  if (isConversationWithPropLaneAssistant(thread)) return "outbound";
  if (message.automated) return "system";
  const outbound = message.outbound ?? (index === 0 ? folder === "sent" : true);
  return outbound ? "outbound" : "inbound";
}

/** True only for the viewer's own turns. Assistant ice bubbles are not "You". */
export function inboxTurnIsOutbound(
  thread: InboxThreadForTurns,
  message: InboxThreadMessage,
  index: number,
  folder: PersistedInboxThread["folder"],
): boolean {
  return inboxTurnDirection(thread, message, index, folder) === "outbound";
}

export function inboxThreadLastTurnDirection(
  thread: PersistedInboxThread & Pick<InboxThreadForTurns, "threadType" | "thread_type">,
): InboxTurnDirection {
  const folder = inboxThreadFolderForTurns(thread);
  const msgs = inboxThreadMessages(thread);
  if (msgs.length === 0) {
    if (isPropLaneAssistantAuthor(thread.from)) return "assistant";
    return folder === "sent" ? "outbound" : "inbound";
  }
  return inboxTurnDirection(thread, msgs[msgs.length - 1]!, msgs.length - 1, folder);
}
