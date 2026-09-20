"use client";

import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";

const readers = new Map<string, ReturnType<typeof createCoalescedRefresher<Response>>>();

export function invalidateManagerSmsConversationsClient(viewerId?: string | null): void {
  const normalized = String(viewerId ?? "").trim();
  if (normalized) readers.delete(normalized);
  else readers.clear();
}

onPortalSessionViewerChange(() => invalidateManagerSmsConversationsClient());

/** The inbox and composer share a directory read; every consumer owns its body. */
export async function loadManagerSmsConversationsClient(viewerId: string, force = false): Promise<Response> {
  let reader = readers.get(viewerId);
  if (!reader) {
    reader = createCoalescedRefresher(() => fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" }));
    readers.set(viewerId, reader);
  }
  return (await reader.run(force)).clone();
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
