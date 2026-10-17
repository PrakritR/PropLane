/**
 * The ONE unread-conversation number for the manager portal.
 *
 * The sidebar's Communication badge counts what the Active list renders: person
 * rows folded to one per counterparty, texts merged in
 * (`countUnreadActiveConversations`). The assistant's "N unread conversations"
 * row and the dashboard used to count raw stored rows, so one person with an
 * inbox copy and a notice copy read 2 beside the sidebar's 1.
 *
 * The sidebar publishes its number here; every other surface reads it, and
 * falls back to the same folded count over the stored rows when the sidebar has
 * not published yet (no SMS merge in that case - the sidebar owns that fetch).
 */
import { countUnreadActiveCommunication } from "@/lib/communication-active-rows";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

let published: { scope: string; count: number } | null = null;
const listeners = new Set<() => void>();

export function publishManagerUnreadConversationCount(scope: string, count: number): void {
  if (published && published.scope === scope && published.count === count) return;
  published = { scope, count };
  for (const listener of listeners) listener();
}

export function subscribeManagerUnreadConversationCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The published number for a viewer, or null when none has been published for them. */
export function readPublishedManagerUnreadConversationCount(scope: string): number | null {
  return published && published.scope === scope ? published.count : null;
}

/** Test seam. */
export function resetPublishedManagerUnreadConversationCount(): void {
  published = null;
}

/** The sidebar's number computed without SMS: folded Active rows that are unread. */
export function countFoldedUnreadManagerConversations(
  rows: PersistedInboxThread[],
  viewerId: string | null | undefined,
): number {
  return countUnreadActiveCommunication(rows, { portal: "manager", viewerId, smsUiEnabled: false });
}

/** The number any non-sidebar surface shows. */
export function managerUnreadConversationCount(
  scope: string,
  rows: PersistedInboxThread[],
  viewerId: string | null | undefined,
): number {
  return readPublishedManagerUnreadConversationCount(scope) ?? countFoldedUnreadManagerConversations(rows, viewerId);
}
