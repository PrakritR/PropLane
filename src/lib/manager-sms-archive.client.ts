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

export function archiveManagerSmsConversation(conversationId: string): void {
  const id = conversationId.trim();
  if (!id) return;
  const next = loadManagerSmsArchivedIds();
  next.add(id);
  persistManagerSmsArchivedIds(next);
}

export function restoreManagerSmsConversation(conversationId: string): void {
  const id = conversationId.trim();
  if (!id) return;
  const next = loadManagerSmsArchivedIds();
  next.delete(id);
  persistManagerSmsArchivedIds(next);
}

export function isManagerSmsConversationArchived(conversationId: string): boolean {
  return loadManagerSmsArchivedIds().has(conversationId.trim());
}
