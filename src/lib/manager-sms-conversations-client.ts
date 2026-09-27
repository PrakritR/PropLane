"use client";

import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";

/**
 * `createCoalescedRefresher` only coalesces CONCURRENT calls — it holds no
 * TTL of its own, so an unforced caller arriving after the previous fetch
 * already settled starts a brand new request regardless of how recently that
 * was. `use-portal-nav-counts.ts` polls this reader every 60s AND on every
 * mount, and the unified inbox / communication panel each read it too — Night
 * QA found /api/manager/sms-conversations landing in the top-5-slowest calls
 * on 7 of 10 manager routes. Add that missing TTL here so callers within the
 * window share one result; `force: true` (e.g. right after sending/deleting a
 * message) still always starts a fresh fetch, same guarantee as before.
 */
const SMS_CONVERSATIONS_TTL_MS = 20_000;

type SmsConversationsEntry = {
  reader: ReturnType<typeof createCoalescedRefresher<SmsResponseSnapshot>>;
  lastResponse: SmsResponseSnapshot | null;
  fetchedAt: number;
};

type SmsResponseSnapshot = {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: Headers;
};

function responseFromSnapshot(snapshot: SmsResponseSnapshot): Response {
  return new Response(snapshot.body.slice(0), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

const readers = new Map<string, SmsConversationsEntry>();

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

/**
 * Test-only reset hook: `invalidateManagerSmsConversationsClient()` with no
 * args already clears every reader, but a test file that mounts the
 * component fresh per `it()` (a static top-level import, so `vi.resetModules()`
 * cannot give it a new copy of this module) needs an explicit way to drop the
 * TTL cache between tests instead of loosening an assertion that a mount
 * fetches fresh. Call this from `beforeEach`/`afterEach`, not app code.
 */
export function resetManagerSmsConversationsClientCacheForTests(): void {
  invalidateManagerSmsConversationsClient();
}

/** The inbox and composer share a directory read; every consumer owns its body. */
export async function loadManagerSmsConversationsClient(
  viewerId: string,
  force = false,
  workspaceId?: string | null,
  cursor?: string | null,
): Promise<Response> {
  const listKey = smsReaderCacheKey(viewerId, workspaceId);
  const cacheKey = cursor ? `${listKey}:cursor:${cursor}` : listKey;
  let entry = readers.get(cacheKey);
  if (!entry) {
    const query = cursor ? `?before=${encodeURIComponent(cursor)}` : "";
    entry = {
      reader: createCoalescedRefresher(async () => {
        const response = await fetch(`/api/manager/sms-conversations${query}`, { credentials: "include", cache: "no-store" });
        return {
          body: await response.arrayBuffer(),
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        };
      }),
      lastResponse: null,
      fetchedAt: 0,
    };
    readers.set(cacheKey, entry);
  }
  if (!force && entry.lastResponse && Date.now() - entry.fetchedAt < SMS_CONVERSATIONS_TTL_MS) {
    return responseFromSnapshot(entry.lastResponse);
  }
  const snapshot = await entry.reader.run(force);
  entry.lastResponse = snapshot;
  entry.fetchedAt = Date.now();
  return responseFromSnapshot(snapshot);
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
  if (!phone && !input.projectionId?.trim()) return { ok: false, error: "No phone on this conversation." };
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
