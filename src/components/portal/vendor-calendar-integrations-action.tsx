"use client";

import { useEffect, useState } from "react";
import { CalendarSync } from "lucide-react";
import { useRouter } from "next/navigation";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

/**
 * The vendor Calendar bar's Integrations control: the calendar-sync glyph with the same connection
 * dot the Google Calendar dialog used (green connected, amber not yet), opening Settings >
 * Integrations where Google Calendar, the Calendar link and the provider rows live.
 */
export function VendorCalendarIntegrationsAction({ className }: { className?: string }) {
  const router = useRouter();
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/vendor/google-calendar?origin=${encodeURIComponent(window.location.origin)}`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { connected?: boolean };
        if (!cancelled) setConnected(Boolean(data.connected));
      } catch {
        if (!cancelled) setConnected(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PortalIconAction
      icon={CalendarSync}
      label="Integrations"
      badge={connected === true ? "ok" : connected === false ? "warn" : null}
      className={className}
      onClick={() => router.push("/vendor/settings?tab=integrations")}
      data-attr="vendor-calendar-integrations-btn"
      data-connected={connected == null ? undefined : String(connected)}
    />
  );
}
