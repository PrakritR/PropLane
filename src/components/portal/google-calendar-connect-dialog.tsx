"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { GoogleCalendarConnectPanel } from "@/components/portal/google-calendar-connect-panel";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { useIsNativeApp } from "@/hooks/use-is-native-app";

export function GoogleCalendarConnectDialog({
  onConnectionChange,
  className,
}: {
  onConnectionChange?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { isNative } = useIsNativeApp();
  const useFullPageModal = isNative === true;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gcal = params.get("gcal");
    if (gcal === "connected" || gcal === "error") setOpen(true);
  }, []);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={className ?? `shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
        onClick={() => setOpen(true)}
        data-attr="google-calendar-header-btn"
      >
        Google Calendar
      </Button>
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
          onConnectionChange={() => {
            onConnectionChange?.();
          }}
        />
      </Modal>
    </>
  );
}
