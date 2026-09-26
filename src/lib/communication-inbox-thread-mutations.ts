import { smsNoticeIdentity } from "@/lib/sms-inbox-identity";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { MANAGER_INBOX_STORAGE_KEY } from "@/lib/portal-inbox-storage";
import {
  deleteInboxThreadIds,
  changePersistedInboxThreadFolders,
  loadPersistedInbox,
  stagePersistedInboxRows,
  upsertPersistedInboxRows,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

function inferPreviousFolder(thread: PersistedInboxThread): "inbox" | "sent" {
  if (thread.previousFolder) return thread.previousFolder;
  if (/^(sent_|msg_|welcome_)/.test(thread.id)) return "sent";
  return "inbox";
}

function expandInboxMutationIds(prev: PersistedInboxThread[], ids: string[]): Set<string> {
  const expanded = new Set(ids);
  for (const thread of prev) {
    const sources = thread.sourceThreadIds ?? [];
    const hit = expanded.has(thread.id) || sources.some((id) => expanded.has(id));
    if (!hit) continue;
    expanded.add(thread.id);
    for (const id of sources) expanded.add(id);
  }
  return expanded;
}

function threadMatchesMutationIds(thread: PersistedInboxThread, ids: Set<string>): boolean {
  if (ids.has(thread.id)) return true;
  return (thread.sourceThreadIds ?? []).some((id) => ids.has(id));
}

/**
 * Pure preview of what `archivePersistedInboxThreads` would change, with no
 * storage I/O — shared by the mutation itself and by callers (the bulk hook)
 * that want to render the optimistic result immediately, before the
 * persistence below confirms it (PLAN B3).
 */
export function previewArchivedInboxThreads(
  prev: PersistedInboxThread[],
  ids: string[],
): { changed: PersistedInboxThread[]; next: PersistedInboxThread[] } {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (clean.length === 0) return { changed: [], next: prev };
  const matchIds = expandInboxMutationIds(prev, clean);
  const changed: PersistedInboxThread[] = [];
  const next = prev.map((thread) => {
    if (!threadMatchesMutationIds(thread, matchIds)) return thread;
    if (thread.folder === "trash" || (thread.folder !== "inbox" && thread.folder !== "sent")) {
      return thread;
    }
    const updated: PersistedInboxThread = {
      ...thread,
      folder: "trash",
      previousFolder: thread.folder,
      unread: false,
    };
    changed.push(updated);
    return updated;
  });
  return { changed, next };
}

/** Pure preview counterpart of {@link previewArchivedInboxThreads} for restore. */
export function previewRestoredInboxThreads(
  prev: PersistedInboxThread[],
  ids: string[],
): { changed: PersistedInboxThread[]; next: PersistedInboxThread[] } {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (clean.length === 0) return { changed: [], next: prev };
  const matchIds = expandInboxMutationIds(prev, clean);
  const changed: PersistedInboxThread[] = [];
  const next = prev.map((thread) => {
    if (!threadMatchesMutationIds(thread, matchIds) || thread.folder !== "trash") return thread;
    const dest = inferPreviousFolder(thread);
    const updated: PersistedInboxThread = {
      ...thread,
      folder: dest,
      previousFolder: undefined,
      unread: false,
    };
    changed.push(updated);
    return updated;
  });
  return { changed, next };
}

export async function archivePersistedInboxThreads(
  storageKey: string,
  ids: string[],
): Promise<{ ok: boolean; next: PersistedInboxThread[] }> {
  const prev = loadPersistedInbox(storageKey, []);
  const { changed, next } = previewArchivedInboxThreads(prev, ids);
  if (changed.length === 0) return { ok: true, next: prev };
  if (isDemoModeActive()) {
    stagePersistedInboxRows(storageKey, next);
    return { ok: true, next };
  }
  // Optimistic (PLAN B3): move the rows immediately. Every failure branch
  // below rolls this back to `prev` before reporting `ok: false`, so a caller
  // that also renders `next` right away never needs a second write to see
  // the failure state.
  stagePersistedInboxRows(storageKey, next);
  const matchIds = expandInboxMutationIds(prev, ids.map((id) => id.trim()).filter(Boolean));
  const noticeIds = new Set<string>();
  if (storageKey === MANAGER_INBOX_STORAGE_KEY) {
    for (const thread of changed) {
      if (!smsNoticeIdentity(thread)) continue;
      for (const id of [thread.id, ...(thread.sourceThreadIds ?? [])]) noticeIds.add(id);
      try {
        const response = await fetch("/api/manager/tour-follow-ups", {
          method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inboxThreadId: thread.id, action: "archive" }),
        });
        if (!response.ok) {
          stagePersistedInboxRows(storageKey, prev);
          return { ok: false, next: prev };
        }
      } catch {
        stagePersistedInboxRows(storageKey, prev);
        return { ok: false, next: prev };
      }
    }
  }
  const ordinaryIds = [...matchIds].filter((id) => !noticeIds.has(id));
  if (ordinaryIds.length > 0 && !(await changePersistedInboxThreadFolders(storageKey, ordinaryIds, "archive"))) {
    stagePersistedInboxRows(storageKey, prev);
    return { ok: false, next: prev };
  }
  return { ok: true, next };
}

export async function restorePersistedInboxThreads(
  storageKey: string,
  ids: string[],
): Promise<{ ok: boolean; next: PersistedInboxThread[] }> {
  const prev = loadPersistedInbox(storageKey, []);
  const { changed, next } = previewRestoredInboxThreads(prev, ids);
  if (changed.length === 0) return { ok: true, next: prev };
  if (isDemoModeActive()) {
    stagePersistedInboxRows(storageKey, next);
    return { ok: true, next };
  }
  // Optimistic (PLAN B3) — see archivePersistedInboxThreads above.
  stagePersistedInboxRows(storageKey, next);
  const matchIds = expandInboxMutationIds(prev, ids.map((id) => id.trim()).filter(Boolean));
  const noticeIds = new Set<string>();
  if (storageKey === MANAGER_INBOX_STORAGE_KEY) {
    for (const thread of changed) {
      if (!smsNoticeIdentity(thread)) continue;
      for (const id of [thread.id, ...(thread.sourceThreadIds ?? [])]) noticeIds.add(id);
      try {
        const response = await fetch("/api/manager/tour-follow-ups", {
          method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inboxThreadId: thread.id, action: "restore" }),
        });
        if (!response.ok) {
          stagePersistedInboxRows(storageKey, prev);
          return { ok: false, next: prev };
        }
      } catch {
        stagePersistedInboxRows(storageKey, prev);
        return { ok: false, next: prev };
      }
    }
  }
  const ordinaryIds = [...matchIds].filter((id) => !noticeIds.has(id));
  if (ordinaryIds.length > 0 && !(await changePersistedInboxThreadFolders(storageKey, ordinaryIds, "restore"))) {
    stagePersistedInboxRows(storageKey, prev);
    return { ok: false, next: prev };
  }
  return { ok: true, next };
}

export async function deletePersistedInboxThreadsForever(
  storageKey: string,
  ids: string[],
): Promise<{ ok: boolean; next: PersistedInboxThread[] }> {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (clean.length === 0) return { ok: true, next: loadPersistedInbox(storageKey, []) };

  const prev = loadPersistedInbox(storageKey, []);
  const next = prev.filter((thread) => !clean.includes(thread.id));
  if (next.length === prev.length) return { ok: true, next: prev };

  const ok = await deleteInboxThreadIds(clean);
  if (!ok) return { ok: false, next: prev };
  stagePersistedInboxRows(storageKey, next);
  return { ok: true, next };
}

export type ClearedInboxThreadPlaceholder = {
  preview?: string;
  subject?: string;
  from?: string;
};

function threadMatchesClearId(thread: PersistedInboxThread, threadId: string): boolean {
  return thread.id === threadId || (thread.sourceThreadIds ?? []).includes(threadId);
}

function clearedInboxThread(
  thread: PersistedInboxThread,
  placeholder: ClearedInboxThreadPlaceholder,
): PersistedInboxThread {
  const next: PersistedInboxThread = {
    ...thread,
    messages: [],
    body: "",
    preview: placeholder.preview ?? "",
    unread: false,
    time: "",
    subject: placeholder.subject ?? thread.subject,
    from: placeholder.from ?? thread.from,
  };
  delete next.aiDraft;
  delete next.aiDraftQueue;
  return next;
}

/**
 * Wipe messages on one conversation and keep the row. PropLane Assistant
 * cannot be deleted — the server recreates it — so Clear upserts the same id
 * empty with the placeholder preview.
 */
export async function clearPersistedInboxThread(
  storageKey: string,
  threadId: string,
  placeholder: ClearedInboxThreadPlaceholder = {},
): Promise<{ ok: boolean; next: PersistedInboxThread[] }> {
  const id = threadId.trim();
  if (!id) return { ok: true, next: loadPersistedInbox(storageKey, []) };

  const prev = loadPersistedInbox(storageKey, []);
  const changed: PersistedInboxThread[] = [];
  let next = prev.map((thread) => {
    if (!threadMatchesClearId(thread, id)) return thread;
    const updated = clearedInboxThread(thread, placeholder);
    changed.push(updated);
    return updated;
  });

  if (changed.length === 0) {
    const inserted = clearedInboxThread(
      {
        id,
        folder: "inbox",
        from: placeholder.from ?? "PropLane Assistant",
        email: "",
        subject: placeholder.subject ?? "PropLane Assistant",
        preview: placeholder.preview ?? "",
        body: "",
        time: "",
        unread: false,
        messages: [],
      },
      placeholder,
    );
    changed.push(inserted);
    next = [inserted, ...prev];
  }

  if (isDemoModeActive()) {
    stagePersistedInboxRows(storageKey, next);
    return { ok: true, next };
  }
  const ok = await upsertPersistedInboxRows(storageKey, changed, next);
  if (!ok) return { ok: false, next: prev };
  return { ok: true, next };
}
