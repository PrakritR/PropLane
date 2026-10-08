"use client";

/**
 * The admin side of the unified Communication inbox: where the conversations
 * are read from, and how they are archived, restored and deleted.
 *
 * Admin's mail lives in an in-memory store hydrated from `scope: "admin"`
 * (`demo-admin-partner-inbox.ts`), not in the persisted inbox cache the manager
 * uses. This module wraps that store in the shape the inbox adapter needs and
 * adds the pending scheduled sends, which draw as conversations of their own
 * when the recipient has never been messaged (`admin-inbox-threads.ts`).
 */
import { emitAdminUi } from "@/lib/demo-admin-ui";
import {
  moveInboxMessageToTrash,
  permanentlyDeleteInboxMessage,
  readInboxMessages,
  restoreInboxMessageFromTrash,
  syncInboxMessagesFromServerWithStatus,
} from "@/lib/demo-admin-partner-inbox";
import { isAdminScheduledStubId, adminThreadsFrom } from "@/lib/admin-inbox-threads";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { InboxEmailMutationResult, InboxEmailMutations } from "@/lib/communication/inbox-adapter";
import type { PersistedInboxSyncResult, PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

/** Cache + mutation key of the admin thread rows (never a persisted-inbox key). */
export const ADMIN_INBOX_STORAGE_KEY = "axis_admin_inbox_v1";

let scheduledRecords: ScheduledInboxMessageRecord[] = [];

/** Test-only: drop the held scheduled sends. */
export function resetAdminScheduledForTests(): void {
  scheduledRecords = [];
}

/** Pending scheduled sends admin has composed (what the thread cards read and cancel). */
export async function refreshAdminScheduled(): Promise<boolean> {
  if (typeof window === "undefined" || isDemoModeActive()) return true;
  try {
    const res = await fetch("/api/portal/scheduled-inbox-messages", { credentials: "include", cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
    scheduledRecords = Array.isArray(body.messages) ? body.messages : [];
    emitAdminUi();
    return true;
  } catch {
    return false;
  }
}

/** Every admin conversation as the unified inbox's thread rows. */
export function adminCachedThreads(): PersistedInboxThread[] {
  return adminThreadsFrom(readInboxMessages(), scheduledRecords);
}

export async function syncAdminThreads(opts?: { force?: boolean }): Promise<PersistedInboxSyncResult> {
  const [status] = await Promise.all([
    syncInboxMessagesFromServerWithStatus(opts?.force ? { force: true } : undefined),
    // The scheduled read decorates conversations; its failure must not turn the inbox into an error.
    refreshAdminScheduled(),
  ]);
  return { rows: adminCachedThreads(), ok: status.ok, stale: false };
}

async function mutateEach(
  ids: string[],
  run: (id: string) => Promise<boolean>,
): Promise<InboxEmailMutationResult> {
  let ok = true;
  for (const id of [...new Set(ids)]) {
    // A conversation drawn for a scheduled send is not a stored message: nothing to archive.
    if (isAdminScheduledStubId(id)) {
      ok = false;
      continue;
    }
    if (!(await run(id))) ok = false;
  }
  return { ok, next: adminCachedThreads() };
}

export const adminEmailMutations: InboxEmailMutations = {
  archive: (ids) => mutateEach(ids, moveInboxMessageToTrash),
  restore: (ids) => mutateEach(ids, restoreInboxMessageFromTrash),
  deleteForever: (ids) => mutateEach(ids, permanentlyDeleteInboxMessage),
};
