"use client";

import {
  chunkDismissedContactKeys,
  normalizeDismissedContactKey,
} from "@/lib/communication/dismissed-contact-keys";
import { invalidateSharedGets, sharedGet, writeThroughFetch } from "@/lib/shared-get-cache";

/**
 * Client side of `communication_dismissed_contacts`: the people whose empty
 * "No messages yet" row this manager deleted, per workspace.
 *
 * The read goes through `sharedGet` (one request per URL per page load, however
 * many components ask). The workspace id in the URL is only the cache key so two
 * workspaces never share an answer; the server resolves the workspace itself
 * and ignores anything the URL or a body says about it.
 */

const THREADS_ROUTE = "/api/portal-inbox-threads";
const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";

/** The directory's own key for a person: the trimmed, lower-cased email. */
export function dismissedContactKey(email: string | null | undefined): string {
  return normalizeDismissedContactKey(email ?? "");
}

function dismissedUrl(workspaceId: string | null | undefined): string {
  return `${THREADS_ROUTE}?scope=${MANAGER_SCOPE}&view=dismissed&workspaceId=${encodeURIComponent(workspaceId ?? "")}`;
}

export async function loadDismissedContactKeys(
  workspaceId: string | null | undefined,
  opts?: { force?: boolean },
): Promise<string[] | null> {
  const result = await sharedGet(dismissedUrl(workspaceId), { force: opts?.force });
  if (!result.ok) return null;
  const dismissed = (result.data as { dismissed?: unknown } | null)?.dismissed;
  return Array.isArray(dismissed) ? dismissed.map((key) => dismissedContactKey(String(key))).filter(Boolean) : [];
}

async function post(action: "dismissContacts" | "clearDismissedContacts", emails: readonly string[]): Promise<boolean> {
  const contactKeys = [...new Set(emails.map(dismissedContactKey).filter(Boolean))];
  if (contactKeys.length === 0) return true;
  // One request per batch: the route refuses more than it will save, and
  // "Delete all archived" over a big workspace is more than one batch. Every
  // batch has to land, or the caller is told the delete failed rather than
  // shown rows that come back on the next load.
  for (const batch of chunkDismissedContactKeys(contactKeys)) {
    try {
      const res = await writeThroughFetch(
        THREADS_ROUTE,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, scope: MANAGER_SCOPE, contactKeys: batch }),
        },
        { invalidatePrefix: `${THREADS_ROUTE}?scope=${MANAGER_SCOPE}&view=dismissed` },
      );
      if (!res.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Delete empty chats for good: the people stay out of Active until a real message exists. */
export function dismissContactsClient(emails: readonly string[]): Promise<boolean> {
  return post("dismissContacts", emails);
}

/** The manager is writing to these people again (New message): their row may come back. */
export function clearDismissedContactsClient(emails: readonly string[]): Promise<boolean> {
  return post("clearDismissedContacts", emails);
}

export function invalidateDismissedContacts(): void {
  invalidateSharedGets(`${THREADS_ROUTE}?scope=${MANAGER_SCOPE}&view=dismissed`);
}
