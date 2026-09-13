"use client";

import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";

const readers = new Map<string, ReturnType<typeof createCoalescedRefresher<Response>>>();
onPortalSessionViewerChange(() => readers.clear());

/** The inbox and composer share a directory read; every consumer owns its body. */
export async function loadManagerSmsConversationsClient(viewerId: string, force = false): Promise<Response> {
  let reader = readers.get(viewerId);
  if (!reader) {
    reader = createCoalescedRefresher(() => fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" }));
    readers.set(viewerId, reader);
  }
  return (await reader.run(force)).clone();
}
