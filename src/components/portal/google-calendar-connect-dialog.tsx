"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarSync } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { GoogleCalendarConnectPanel } from "@/components/portal/google-calendar-connect-panel";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { useIsNativeApp } from "@/hooks/use-is-native-app";

/**
 * The Calendar bar's Google Calendar control — the calendar-sync glyph with a
 * connection dot (green connected, amber not yet), same rule as every other
 * icon in a list bar (PLAN-0914-1710). The dialog behind it is unchanged.
 */
export function GoogleCalendarConnectDialog({
  onConnectionChange,
  className,
  /** Manager (default) reads `/api/portal/google-calendar`; a role cloning the
   * OAuth flow onto its own storage (vendor) passes its own base. */
  apiBase = "/api/portal/google-calendar",
}: {
  onConnectionChange?: () => void;
  className?: string;
  apiBase?: string;
}) {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const { isNative } = useIsNativeApp();
  const useFullPageModal = isNative === true;

  // A light status read for the dot; the panel does the full link-session dance itself.
  const readStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `${apiBase}?origin=${encodeURIComponent(window.location.origin)}`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { connected?: boolean };
      setConnected(Boolean(data.connected));
    } catch {
      setConnected(null);
    }
  }, [apiBase]);

  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gcal = params.get("gcal");
    if (gcal === "connected" || gcal === "error") setOpen(true);
  }, []);

  const label =
    connected === true
      ? "Google Calendar · connected"
      : connected === false
        ? "Google Calendar · not connected"
        : "Google Calendar";

  return (
    <>
      <PortalIconAction
        icon={CalendarSync}
        label={label}
        badge={connected === true ? "ok" : connected === false ? "warn" : null}
        className={className}
        onClick={() => setOpen(true)}
        data-attr="google-calendar-header-btn"
        data-connected={connected == null ? undefined : String(connected)}
      />
      <Modal
        open={open}
        title="Google Calendar"
        onClose={() => setOpen(false)}
        panelClassName="max-w-md"
        fullPage={useFullPageModal}
        fullScreenMobile={useFullPageModal}
      >
        <GoogleCalendarConnectPanel
          presentation="dialog"
          apiBase={apiBase}
          onConnectionChange={() => {
            void readStatus();
            onConnectionChange?.();
          }}
        />
      </Modal>
    </>
  );
}
