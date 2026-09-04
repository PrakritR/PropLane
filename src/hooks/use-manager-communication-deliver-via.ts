"use client";

import { useCallback, useEffect, useState } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import {
  deliverViaFromManagerSettings,
  type DeliverViaChannels,
  type ManagerDeliverViaKind,
} from "@/lib/manager-communication-deliver-via";

export function useManagerCommunicationDeliverVia() {
  const demo = isDemoModeActive();
  const { userId, ready } = usePortalSession();
  const [settings, setSettings] = useState<ManagerAutomationSettings>(
    DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  );
  const [loaded, setLoaded] = useState(demo);

  const load = useCallback(async () => {
    if (demo) {
      setSettings(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
      setLoaded(true);
      return;
    }
    try {
      const res = await fetch("/api/portal/automation-settings", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { settings?: ManagerAutomationSettings };
      if (body.settings) setSettings(body.settings);
    } catch {
      // Non-critical — fall back to defaults.
    } finally {
      setLoaded(true);
    }
  }, [demo]);

  useEffect(() => {
    if (!demo && (!ready || !userId)) return;
    void load();
    const onSettings = () => void load();
    window.addEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettings);
  }, [demo, load, ready, userId]);

  const channelsFor = useCallback(
    (kind: ManagerDeliverViaKind): DeliverViaChannels =>
      deliverViaFromManagerSettings(settings, kind),
    [settings],
  );

  return { settings, loaded, channelsFor, reload: load };
}
