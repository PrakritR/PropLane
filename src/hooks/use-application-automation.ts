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
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  normalizeApplicationAutomationByPropertyId,
  resolveApplicationAutomationForProperty,
  type ApplicationAutomationPreferences,
  type ApplicationAutomationState,
} from "@/lib/application-automation-preferences";
import { isDemoModeActive } from "@/lib/demo/demo-session";

const EMPTY_STATE: ApplicationAutomationState = {
  portfolio: DEFAULT_APPLICATION_AUTOMATION,
  byPropertyId: {},
};

export function useApplicationAutomation(userId: string | null | undefined): ApplicationAutomationState & {
  forProperty: (propertyId: string | null | undefined) => ApplicationAutomationPreferences;
} {
  const [state, setState] = useState<ApplicationAutomationState>(EMPTY_STATE);

  useEffect(() => {
    // No session, or the /demo sandbox, means nothing to automate. Demo is checked here as well
    // as inside the runner because the fetch itself is an authed call demo must not make.
    if (!userId || isDemoModeActive()) {
      setState(EMPTY_STATE);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/portal/manager-application-settings", { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as {
          automation?: unknown;
          automationState?: {
            portfolio?: unknown;
            byPropertyId?: unknown;
          };
        };
        if (cancelled) return;
        const automationState = data.automationState;
        if (automationState) {
          setState({
            portfolio: normalizeApplicationAutomation(automationState.portfolio),
            byPropertyId: normalizeApplicationAutomationByPropertyId(automationState.byPropertyId),
          });
          return;
        }
        setState({
          portfolio: normalizeApplicationAutomation(data.automation),
          byPropertyId: {},
        });
      } catch {
        /* stay on the all-off default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const forProperty = useCallback(
    (propertyId: string | null | undefined) => resolveApplicationAutomationForProperty(state, propertyId),
    [state],
  );

  return { ...state, forProperty };
}
