"use client";

import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";

const readers = new Map<string, ReturnType<typeof createCoalescedRefresher<Response>>>();

function smsReaderCacheKey(viewerId: string, workspaceId?: string | null): string {
  const viewer = String(viewerId ?? "").trim();
  const workspace = String(workspaceId ?? "").trim();
  return workspace ? `${viewer}:${workspace}` : viewer;
}

export function invalidateManagerSmsConversationsClient(
  viewerId?: string | null,
  workspaceId?: string | null,
): void {
  const normalized = String(viewerId ?? "").trim();
  const workspace = String(workspaceId ?? "").trim();
  if (normalized && workspace) {
    const prefix = smsReaderCacheKey(normalized, workspace);
    for (const key of [...readers.keys()]) {
      if (key === prefix || key.startsWith(`${prefix}:`)) readers.delete(key);
    }
    return;
  }
  if (normalized) {
    for (const key of [...readers.keys()]) {
      if (key === normalized || key.startsWith(`${normalized}:`)) readers.delete(key);
    }
    return;
  }
  readers.clear();
}

onPortalSessionViewerChange(() => invalidateManagerSmsConversationsClient());

/** The inbox and composer share a directory read; every consumer owns its body. */
export async function loadManagerSmsConversationsClient(
  viewerId: string,
  force = false,
  workspaceId?: string | null,
  cursor?: string | null,
): Promise<Response> {
  const listKey = smsReaderCacheKey(viewerId, workspaceId);
  const cacheKey = cursor ? `${listKey}:cursor:${cursor}` : listKey;
  let reader = readers.get(cacheKey);
  if (!reader) {
    const query = cursor ? `?before=${encodeURIComponent(cursor)}` : "";
    reader = createCoalescedRefresher(() =>
      fetch(`/api/manager/sms-conversations${query}`, { credentials: "include", cache: "no-store" }),
    );
    readers.set(cacheKey, reader);
  }
  return (await reader.run(force)).clone();
}

/** Load a selected projection thread without putting SMS history in browser storage. */
export async function loadManagerSmsConversationDetailClient(
  projectionId: string,
  before?: string | null,
): Promise<Response> {
  const id = projectionId.trim();
  if (!id) throw new Error("Choose a conversation first.");
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  return fetch(`/api/manager/sms-conversations/${encodeURIComponent(id)}${query}`, {
    credentials: "include",
    cache: "no-store",
  });
}

export async function updateManagerSmsConversationStateClient(input: {
  projectionId: string;
  action: "markRead" | "archive" | "restore";
  expectedVersion: number;
  observed?: { occurredAt: string; id: string };
}): Promise<Response> {
  const id = input.projectionId.trim();
  if (!id) throw new Error("Choose a conversation first.");
  return fetch(`/api/manager/sms-conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: input.action, expectedVersion: input.expectedVersion, observed: input.observed }),
  });
}

/** Irreversible hard-delete of one SMS conversation the viewer can see. */
export async function deleteManagerSmsConversationClient(input: {
  phone: string;
  conversationKey: string | null;
  projectionId?: string | null;
}): Promise<{ ok: boolean; partial?: boolean; error?: string }> {
  const phone = input.phone.trim();
  if (!phone) return { ok: false, error: "No phone on this conversation." };
  const res = await fetch("/api/manager/sms-conversations", {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone,
      conversationKey: input.conversationKey,
      ...(input.projectionId ? { projectionId: input.projectionId } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; partial?: boolean };
  if (!res.ok) return { ok: false, error: body.error ?? "Could not delete conversation." };
  return { ok: true, partial: body.partial, error: body.error };
}
