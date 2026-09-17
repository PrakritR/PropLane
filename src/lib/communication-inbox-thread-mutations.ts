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

export async function archivePersistedInboxThreads(
  storageKey: string,
  ids: string[],
): Promise<{ ok: boolean; next: PersistedInboxThread[] }> {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (clean.length === 0) return { ok: true, next: loadPersistedInbox(storageKey, []) };

  const prev = loadPersistedInbox(storageKey, []);
  const changed: PersistedInboxThread[] = [];
  const next = prev.map((thread) => {
    if (!clean.includes(thread.id)) return thread;
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

  if (changed.length === 0) return { ok: true, next: prev };
  if (isDemoModeActive()) {
    stagePersistedInboxRows(storageKey, next);
    return { ok: true, next };
  }
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
        if (!response.ok) return { ok: false, next: prev };
      } catch {
        return { ok: false, next: prev };
      }
    }
  }
  const ordinaryIds = clean.filter((id) => !noticeIds.has(id));
  if (ordinaryIds.length > 0 && !(await changePersistedInboxThreadFolders(storageKey, ordinaryIds, "archive"))) {
    return { ok: false, next: prev };
  }
  stagePersistedInboxRows(storageKey, next);
  return { ok: true, next };
}

export async function restorePersistedInboxThreads(
  storageKey: string,
  ids: string[],
): Promise<{ ok: boolean; next: PersistedInboxThread[] }> {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (clean.length === 0) return { ok: true, next: loadPersistedInbox(storageKey, []) };

  const prev = loadPersistedInbox(storageKey, []);
  const changed: PersistedInboxThread[] = [];
  const next = prev.map((thread) => {
    if (!clean.includes(thread.id) || thread.folder !== "trash") return thread;
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

  if (changed.length === 0) return { ok: true, next: prev };
  if (isDemoModeActive()) {
    stagePersistedInboxRows(storageKey, next);
    return { ok: true, next };
  }
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
        if (!response.ok) return { ok: false, next: prev };
      } catch {
        return { ok: false, next: prev };
      }
    }
  }
  const ordinaryIds = clean.filter((id) => !noticeIds.has(id));
  if (ordinaryIds.length > 0 && !(await changePersistedInboxThreadFolders(storageKey, ordinaryIds, "restore"))) {
    return { ok: false, next: prev };
  }
  stagePersistedInboxRows(storageKey, next);
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
