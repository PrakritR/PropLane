"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { usePortalSession } from "@/hooks/use-portal-session";
import { PAYMENT_AUTOMATION_SETTINGS_EVENT } from "@/lib/payment-automation-settings";
import { loadManagerAutomationSettingsCached } from "@/lib/manager-automation-settings-client";

export function useInboxAiDraftAutoSend() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const { userId, ready } = usePortalSession();
  const [enabled, setEnabledLocal] = useState(false);

  // Account-level (no workspace/property scope) — matches every other reader
  // of `inboxAiDraftAutoSend`. Routed through the shared cache so the several
  // inbox widgets that each want this flag on mount cost at most one request
  // per TTL window instead of one each.
  const load = useCallback(
    async (opts?: { force?: boolean }) => {
      if (demo) {
        setEnabledLocal(false);
        return;
      }
      if (!userId) return;
      try {
        const loaded = await loadManagerAutomationSettingsCached(userId, opts);
        setEnabledLocal(loaded.settings.inboxAiDraftAutoSend === true);
      } catch {
        // Leave the last known value — auto-send is opt-in and non-critical to load.
      }
    },
    [demo, userId],
  );

  useEffect(() => {
    if (!demo && (!ready || !userId)) return;
    void load();
    const onSettings = () => void load({ force: true });
    window.addEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettings);
  }, [demo, load, ready, userId]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledLocal(next);
      if (demo) return;
      void (async () => {
        try {
          const res = await fetch("/api/portal/automation-settings", {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inboxAiDraftAutoSend: next }),
          });
          if (!res.ok) throw new Error("Could not save auto-send setting.");
          window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
        } catch (e) {
          showToast(e instanceof Error ? e.message : "Could not save auto-send setting.");
          void load();
        }
      })();
    },
    [demo, load, showToast],
  );

  return { enabled, setEnabled };
}
