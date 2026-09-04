import {
  deleteInboxThreadIds,
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
  stagePersistedInboxRows(storageKey, next);
  const ok = await upsertPersistedInboxRows(storageKey, changed, next);
  return { ok, next: ok ? next : prev };
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
  stagePersistedInboxRows(storageKey, next);
  const ok = await upsertPersistedInboxRows(storageKey, changed, next);
  return { ok, next: ok ? next : prev };
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
