/** Reversible archive for manager SMS threads — distinct from permanent delete (hidden). */

export const MANAGER_SMS_ARCHIVED_STORAGE_KEY = "axis_manager_sms_archived_v1";
export const MANAGER_SMS_ARCHIVE_CHANGED_EVENT = "manager-sms-archive-changed";

function readIdSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function writeIdSet(key: string, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify([...ids]));
  window.dispatchEvent(new CustomEvent(MANAGER_SMS_ARCHIVE_CHANGED_EVENT));
}

export function loadManagerSmsArchivedIds(): Set<string> {
  return readIdSet(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
}

export function persistManagerSmsArchivedIds(ids: Set<string>): void {
  writeIdSet(MANAGER_SMS_ARCHIVED_STORAGE_KEY, ids);
}

/**
 * Ids with an archive/restore request currently in flight. A poll response
 * that was already underway when the manager clicked Archive/Restore carries
 * stale server truth (it was built before the PATCH landed) — without this,
 * `mirrorManagerSmsArchivedFromServer` would apply that stale answer and
 * visibly bounce the row back for up to the 20-second poll interval. Cleared
 * on settle (success OR failure) so a genuinely later poll is trusted again.
 */
const pendingRequestIds = new Set<string>();

/**
 * Optimistic (PLAN B3): flip the local flag immediately — Promise.all-ed calls
 * for several rows must feel instant — then roll back on failure. The
 * rollback removes/re-adds only THIS id (never a stale full-set snapshot), so
 * concurrent archive calls for other ids can never be undone by one call's
 * failure.
 */
export async function archiveManagerSmsConversation(conversationId: string): Promise<void> {
  const id = conversationId.trim();
  if (!id) return;
  const optimistic = loadManagerSmsArchivedIds();
  optimistic.add(id);
  persistManagerSmsArchivedIds(optimistic);
  pendingRequestIds.add(id);
  try {
    const response = await fetch("/api/manager/tour-follow-ups", {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationKey: id, action: "archive" }),
    });
    if (!response.ok) throw new Error("Could not archive this conversation. Please try again.");
  } catch (error) {
    const rolledBack = loadManagerSmsArchivedIds();
    rolledBack.delete(id);
    persistManagerSmsArchivedIds(rolledBack);
    throw error;
  } finally {
    pendingRequestIds.delete(id);
  }
}

export async function restoreManagerSmsConversation(conversationId: string): Promise<void> {
  const id = conversationId.trim();
  if (!id) return;
  const optimistic = loadManagerSmsArchivedIds();
  optimistic.delete(id);
  persistManagerSmsArchivedIds(optimistic);
  pendingRequestIds.add(id);
  try {
    const response = await fetch("/api/manager/tour-follow-ups", {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationKey: id, action: "restore" }),
    });
    if (!response.ok) throw new Error("Could not restore this conversation. Please try again.");
  } catch (error) {
    const rolledBack = loadManagerSmsArchivedIds();
    rolledBack.add(id);
    persistManagerSmsArchivedIds(rolledBack);
    throw error;
  } finally {
    pendingRequestIds.delete(id);
  }
}

export function isManagerSmsConversationArchived(conversationId: string): boolean {
  return loadManagerSmsArchivedIds().has(conversationId.trim());
}

/**
 * Mirror server archive flags into this browser — localStorage is not
 * authoritative. This is an ADDITIVE merge, never a wholesale replace: a
 * conversation absent from this response (a momentary partial payload, a
 * workspace-scoped fetch, or the server's own flag merely keyed under a
 * different member id) must never be read as "the server says restore it" —
 * that resurrected an archived conversation on the very next 20-second poll.
 * Only a row this response explicitly reports with `archived: false` clears a
 * locally-archived id. An id with an archive/restore request currently in
 * flight (`pendingRequestIds`) is skipped entirely — that response was built
 * before this tab's own click landed, and applying it bounced the row back
 * for up to one poll interval.
 */
export function mirrorManagerSmsArchivedFromServer(
  residents: Array<{ conversationKey?: string | null; memberKeys?: string[] | null; archived?: boolean }>,
): void {
  const next = loadManagerSmsArchivedIds();
  for (const row of residents) {
    const ids = [row.conversationKey?.trim(), ...(row.memberKeys ?? []).map((key) => key.trim())]
      .filter((id): id is string => Boolean(id))
      .filter((id) => !pendingRequestIds.has(id));
    if (ids.length === 0) continue;
    if (row.archived) {
      for (const id of ids) next.add(id);
    } else {
      for (const id of ids) next.delete(id);
    }
  }
  persistManagerSmsArchivedIds(next);
}
