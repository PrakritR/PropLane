"use client";

/**
 * The signed-in manager's saved application automation, for the surfaces that approve an
 * application (the Applications tab and the Residents tab's inline Approve).
 *
 * Both must pass this into `transitionApplicationBucket`, or a manager who switched automation on
 * gets nothing when they approve from that surface — the settings would appear to do nothing,
 * which is worse than not offering them.
 *
 * Defaults to everything OFF and stays there on any failure. A failed read must never invent an
 * enabled step: the cost of missing automation is one manual click, and the cost of inventing one
 * is a lease sent to a resident the manager never meant to send to.
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import { isDemoModeActive } from "@/lib/demo/demo-session";

export function useApplicationAutomation(userId: string | null | undefined): ApplicationAutomationPreferences {
  const [prefs, setPrefs] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);

  useEffect(() => {
    // No session, or the /demo sandbox, means nothing to automate. Demo is checked here as well
    // as inside the runner because the fetch itself is an authed call demo must not make.
    if (!userId || isDemoModeActive()) {
      setPrefs(DEFAULT_APPLICATION_AUTOMATION);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/portal/manager-application-settings", { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as { automation?: unknown };
        if (cancelled) return;
        setPrefs(normalizeApplicationAutomation(data.automation));
      } catch {
        /* stay on the all-off default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return prefs;
}
