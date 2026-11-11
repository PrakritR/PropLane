"use client";

import { useEffect, useState } from "react";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import { loadPersistedInbox, PORTAL_INBOX_CHANGED_EVENT, RESIDENT_INBOX_STORAGE_KEY } from "@/lib/portal-inbox-storage";

/** True when the resident's own PropLane Assistant thread holds an unread message (the Ask tab's dot). */
export function residentAssistantHasUnread(): boolean {
  try {
    return loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, []).some(
      (thread) => thread.folder === "inbox" && thread.unread && isPropLaneAssistantInboxThread(thread),
    );
  } catch {
    // A half-migrated local mirror reads as "nothing unread", never as an error in the bar.
    return false;
  }
}

/** Reads the same local inbox mirror the Messages badge reads, so the dot can never disagree with the thread. */
export function useResidentAssistantUnread(enabled: boolean): boolean {
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setUnread(residentAssistantHasUnread());
    refresh();
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [enabled]);
  return enabled && unread;
}
