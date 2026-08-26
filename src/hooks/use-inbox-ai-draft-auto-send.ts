"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { PAYMENT_AUTOMATION_SETTINGS_EVENT } from "@/lib/payment-automation-settings";

export function useInboxAiDraftAutoSend() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [enabled, setEnabledLocal] = useState(false);

  const load = useCallback(async () => {
    if (demo) {
      setEnabledLocal(false);
      return;
    }
    try {
      const res = await fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { settings?: { inboxAiDraftAutoSend?: boolean } };
      setEnabledLocal(body.settings?.inboxAiDraftAutoSend === true);
    } catch {
      // Leave the last known value — auto-send is opt-in and non-critical to load.
    }
  }, [demo]);

  useEffect(() => {
    void load();
    const onSettings = () => void load();
    window.addEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettings);
  }, [load]);

  const setEnabled = useCallback(
    (next: boolean) => {
      if (
        next &&
        !enabled &&
        !window.confirm(
          "Auto-send will email or text AI-drafted replies without your approval. Inbound messages are untrusted — misleading content could influence what goes out under your name.\n\nTurn on auto-send?",
        )
      ) {
        return;
      }
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
    [demo, enabled, load, showToast],
  );

  return { enabled, setEnabled };
}
