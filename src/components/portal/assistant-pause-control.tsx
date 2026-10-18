"use client";

import { useCallback, useEffect, useState } from "react";
import { PauseCircle, PlayCircle } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { fetchWithTimeout, PORTAL_READ_TIMEOUT_MS } from "@/lib/auth/fetch-with-timeout";

const THREAD_STATE_URL = "/api/portal/one-number/thread-state";

/**
 * Pause / resume the shared-line assistant for one SMS conversation. Absent
 * (renders nothing) while the id is missing, while the state loads, and when the
 * read is refused: the feature does not exist for that thread. Not `sharedGet`:
 * its 30s cache would replay a stale state after a toggle.
 */
export function AssistantPauseControl({ conversationId }: { conversationId: string | null | undefined }) {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPaused(null);
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout(
          `${THREAD_STATE_URL}?conversationId=${encodeURIComponent(conversationId)}`,
          { credentials: "include" },
          PORTAL_READ_TIMEOUT_MS,
        );
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { paused?: unknown } | null;
        if (!cancelled && typeof body?.paused === "boolean") setPaused(body.paused);
      } catch {
        /* absent for this thread */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const toggle = useCallback(async () => {
    if (!conversationId || paused === null || busy) return;
    setBusy(true);
    try {
      const res = await fetchWithTimeout(
        THREAD_STATE_URL,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, action: paused ? "resume" : "pause" }),
        },
        PORTAL_READ_TIMEOUT_MS,
      );
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { paused?: unknown } | null;
      if (typeof body?.paused === "boolean") setPaused(body.paused);
    } catch {
      /* state unchanged */
    } finally {
      setBusy(false);
    }
  }, [busy, conversationId, paused]);

  if (!conversationId || paused === null) return null;
  return (
    <PortalIconAction
      icon={paused ? PlayCircle : PauseCircle}
      label={paused ? "Resume assistant" : "Pause assistant"}
      disabled={busy}
      data-attr={paused ? "thread-assistant-resume" : "thread-assistant-pause"}
      onClick={() => void toggle()}
    />
  );
}

/** Shared-line assistant control applies to every SMS counterparty except the manager's own side. */
export function assistantPauseConversationId(
  resident: { projectionId?: string | null; counterpartyRole?: string | null } | null | undefined,
): string | null {
  if (!resident?.projectionId) return null;
  if (resident.counterpartyRole === "manager" || resident.counterpartyRole === "admin") return null;
  return resident.projectionId;
}
