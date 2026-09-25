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
  reader: ReturnType<typeof createCoalescedRefresher<Response>>;
  lastResponse: Response | null;
  fetchedAt: number;
};

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
    readers.delete(smsReaderCacheKey(normalized, workspace));
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
): Promise<Response> {
  const cacheKey = smsReaderCacheKey(viewerId, workspaceId);
  let entry = readers.get(cacheKey);
  if (!entry) {
    entry = {
      reader: createCoalescedRefresher(() =>
        fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" }),
      ),
      lastResponse: null,
      fetchedAt: 0,
    };
    readers.set(cacheKey, entry);
  }
  if (!force && entry.lastResponse && Date.now() - entry.fetchedAt < SMS_CONVERSATIONS_TTL_MS) {
    return entry.lastResponse.clone();
  }
  const res = await entry.reader.run(force);
  entry.lastResponse = res;
  entry.fetchedAt = Date.now();
  return res.clone();
}

/** Irreversible hard-delete of one SMS conversation the viewer can see. */
export async function deleteManagerSmsConversationClient(input: {
  phone: string;
  conversationKey: string | null;
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
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; partial?: boolean };
  if (!res.ok) return { ok: false, error: body.error ?? "Could not delete conversation." };
  return { ok: true, partial: body.partial, error: body.error };
}
