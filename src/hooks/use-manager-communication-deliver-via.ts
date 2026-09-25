"use client";

import { useCallback, useEffect, useState } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { loadManagerAutomationSettingsCached } from "@/lib/manager-automation-settings-client";
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

  // Every instance of this hook wants the same account-level settings — a
  // page can mount several (e.g. one PortalNotificationPreviewModal per
  // notification kind on ManagerResidents, always mounted regardless of
  // `open`). Route through the shared cache so N mounts cost at most one
  // request per TTL window instead of N. `force` (an explicit reload, or the
  // settings-changed event) always gets a fresh read.
  const load = useCallback(
    async (opts?: { force?: boolean }) => {
      if (demo) {
        setSettings(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
        setLoaded(true);
        return;
      }
      if (!userId) return;
      try {
        const loadedSettings = await loadManagerAutomationSettingsCached(userId, opts);
        setSettings(loadedSettings);
      } catch {
        // Non-critical — fall back to defaults.
      } finally {
        setLoaded(true);
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

  const channelsFor = useCallback(
    (kind: ManagerDeliverViaKind): DeliverViaChannels =>
      deliverViaFromManagerSettings(settings, kind),
    [settings],
  );

  return { settings, loaded, channelsFor, reload: load };
}
