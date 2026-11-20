/**
 * You are your Assistant: the conversation a workspace holds with the VIEWER's own account (their `acct:` key, their
 * confirmed sign-in email, their verified phone) is not a second contact, it is the same chat as their PropLane
 * Assistant. Pure and client-safe.
 *
 * The server decides who "self" is (`stampViewerSelf`, from the session, never from a request) and the list folds the
 * stamped rows into the Assistant thread (`foldViewerSelfIntoAssistant`). Read-time only: nothing is rewritten, and
 * a row that cannot be proven to be the viewer's own stays its own row (fail open, never hide a conversation).
 */
import { normalizeE164 } from "@/lib/phone-e164";
import { accountKey, emailKey, phoneKey } from "@/lib/communication/conversation-key";
import { isManagerAgentNoticeThreadId } from "@/lib/communication-manager-assistant-thread";
import {
  inboxThreadMessages,
  inboxThreadSortMs,
  mergeInboxReadSourceState,
  type InboxThreadMessage,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

export type ViewerSelfIdentity = {
  /** The authenticated user id. */
  userId: string;
  /** The session's CONFIRMED sign-in email; empty when unconfirmed. */
  confirmedEmail?: string | null;
  /** The viewer's phone, only when `profiles.phone_verified_at` is set. An unverified phone never counts. */
  verifiedPhone?: string | null;
};

/** The conversation keys that are the viewer. Derived from the session only. */
export function viewerSelfConversationKeys(identity: ViewerSelfIdentity): Set<string> {
  const keys = new Set<string>();
  const userId = identity.userId?.trim();
  if (userId) keys.add(accountKey(userId));
  const email = identity.confirmedEmail?.trim().toLowerCase() ?? "";
  if (email.includes("@")) keys.add(emailKey(email));
  const phone = normalizeE164(identity.verifiedPhone ?? "");
  if (phone) keys.add(phoneKey(phone));
  return keys;
}

/** True when this row's person is the viewer. A flagged (ambiguous) conversation is never merged. */
export function isViewerSelfThread(
  thread: Pick<PersistedInboxThread, "id" | "conversationKey" | "email" | "identityFlag" | "threadType">,
  keys: ReadonlySet<string>,
  confirmedEmail?: string | null,
): boolean {
  if (thread.identityFlag) return false;
  if (isManagerAgentNoticeThreadId(thread.id)) return false;
  if (thread.threadType === "team" || /^(team-thread:|house-thread:|house-chat:)/.test(thread.id)) return false;
  const key = thread.conversationKey?.trim();
  if (key) return keys.has(key);
  // A row written before keys is the viewer's own only by its stored address.
  const own = confirmedEmail?.trim().toLowerCase() ?? "";
  const email = thread.email?.trim().toLowerCase() ?? "";
  return Boolean(own && email && own === email);
}

/**
 * Set `isViewerSelf` on every row from the session's identity. ANY value already on a row (a client can write one)
 * is overwritten, so the flag is never taken from the client.
 */
export function stampViewerSelf<T extends PersistedInboxThread>(rows: T[], identity: ViewerSelfIdentity): T[] {
  const keys = viewerSelfConversationKeys(identity);
  return rows.map((row) => {
    const { isViewerSelf: _ignored, ...rest } = row;
    return isViewerSelfThread(rest as T, keys, identity.confirmedEmail) ? ({ ...rest, isViewerSelf: true } as T) : (rest as T);
  });
}

/**
 * Fold the viewer's own conversations into their Assistant thread: one row, their messages interleaved in time
 * order. Only an Active (non-archived) self row folds; an archived one stays archived on its own. No Assistant row to
 * fold into (still loading, no viewer) = the rows are returned untouched, so a self row never flashes in or out.
 */
export function foldViewerSelfIntoAssistant(
  threads: PersistedInboxThread[],
  assistantThreadId: string,
): PersistedInboxThread[] {
  const assistant = threads.find((thread) => thread.id === assistantThreadId && thread.folder !== "trash");
  if (!assistant) return threads;
  const selfRows = threads.filter(
    (thread) => thread !== assistant && thread.isViewerSelf === true && thread.folder !== "trash",
  );
  if (selfRows.length === 0) return threads;

  const group = [assistant, ...selfRows];
  const all: InboxThreadMessage[] = [];
  for (const thread of group) {
    all.push(
      ...inboxThreadMessages(thread).map((message, index) =>
        index === 0 ? { ...message, outbound: thread.rootOutbound ?? thread.folder === "sent" } : message,
      ),
    );
  }
  const seen = new Set<string>();
  const ordered = all
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    })
    .sort((a, b) => inboxThreadSortMs(a.id, a.at) - inboxThreadSortMs(b.id, b.at));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return threads;

  const rootId = `${assistant.id}-root`;
  const messages = ordered.slice(1).map((message) => (message.id === rootId ? { ...message, id: `merged:${message.id}` } : message));
  const lastSortMs = Math.max(...group.map((thread) => inboxThreadSortMs(thread.id, thread.time)));
  const newest = group.find((thread) => inboxThreadSortMs(thread.id, thread.time) === lastSortMs) ?? assistant;
  const folded: PersistedInboxThread = {
    ...assistant,
    sourceThreadIds: [...new Set(group.flatMap((thread) => thread.sourceThreadIds ?? [thread.id]))],
    ...mergeInboxReadSourceState(group),
    body: first.body,
    attachments: first.attachments,
    rootAt: first.at,
    rootOutbound: first.outbound === true,
    time: newest.time,
    preview: last.body.slice(0, 100).replace(/\n/g, " "),
    messages,
    unread: group.some((thread) => thread.folder === "inbox" && thread.unread),
  };
  const selfSet = new Set(selfRows);
  return threads.flatMap((thread) => (thread === assistant ? [folded] : selfSet.has(thread) ? [] : [thread]));
}
