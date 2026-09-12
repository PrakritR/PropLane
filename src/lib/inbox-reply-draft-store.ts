/**
 * Unsent reply text, kept per conversation for the life of the tab.
 *
 * Switching conversations, following a link out of the thread, or a page
 * reload used to drop whatever was typed. The draft lives in sessionStorage —
 * it is not a message, it never syncs, and it is gone when the tab closes.
 */

const PREFIX = "axis_inbox_reply_draft:";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readInboxReplyDraft(threadId: string): string {
  const store = storage();
  if (!store || !threadId) return "";
  try {
    return store.getItem(`${PREFIX}${threadId}`) ?? "";
  } catch {
    return "";
  }
}

export function writeInboxReplyDraft(threadId: string, text: string): void {
  const store = storage();
  if (!store || !threadId) return;
  try {
    if (text.trim()) store.setItem(`${PREFIX}${threadId}`, text);
    else store.removeItem(`${PREFIX}${threadId}`);
  } catch {
    // Quota or private mode: the draft simply is not recovered.
  }
}

export function clearInboxReplyDraft(threadId: string): void {
  writeInboxReplyDraft(threadId, "");
}
