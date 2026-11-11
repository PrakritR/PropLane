import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

/** `noticeType` stamped on the manager Assistant-thread message a resident handoff writes (`notifyManagerFromAgent`'s `threadType`). */
export const RESIDENT_HANDOFF_NOTICE_TYPE = "resident_handoff";
export const RESIDENT_HANDOFF_SUBJECT = "Resident asked for you";

/**
 * How many resident handoffs are waiting on the manager: handoff notices in an UNREAD manager Assistant thread, counted
 * back from the newest message until the manager's own reply (an outbound turn), so replying or opening the thread clears
 * the item. Pure, read from the inbox mirror the Needs-attention queue already reads.
 */
export function countResidentHandoffs(threads: readonly PersistedInboxThread[]): number {
  let total = 0;
  for (const thread of threads) {
    if (thread.folder !== "inbox" || !thread.unread) continue;
    const extended = thread as PersistedInboxThread & { thread_type?: string | null };
    if ((thread.threadType ?? extended.thread_type) !== "agent_notice" && !String(thread.id).startsWith("agent_notice_")) continue;
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as (typeof messages)[number] & { noticeType?: string };
      if (message.outbound === true) break;
      if (message.noticeType === RESIDENT_HANDOFF_NOTICE_TYPE) total += 1;
    }
  }
  return total;
}
