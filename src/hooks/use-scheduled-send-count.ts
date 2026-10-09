"use client";

import { useEffect, useMemo, useState } from "react";

import { useScheduledPaymentMessages } from "@/components/portal/payment-schedule-ui";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { isUpcomingScheduledInboxMessage, type ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

/**
 * How many sends are still scheduled (manual + automated reminders) — the number beside
 * "Scheduled" in the Communication Filter on a phone. Reads the same two sources as the
 * Schedule panel, so the count and the list always agree.
 */
export function useScheduledSendCount(enabled: boolean): number {
  const { messages: automation } = useScheduledPaymentMessages({ includeHidden: false, enabled });
  const [manual, setManual] = useState<ScheduledInboxMessageRecord[]>([]);

  useEffect(() => {
    if (!enabled || isDemoModeActive()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/portal/scheduled-inbox-messages", { credentials: "include", cache: "no-store" });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
        if (!cancelled) setManual(Array.isArray(body.messages) ? body.messages : []);
      } catch {
        /* keep what is drawn */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return useMemo(() => {
    if (!enabled) return 0;
    const upcoming = (status: string, sendAt: string) => status === "scheduled" && isUpcomingScheduledInboxMessage(sendAt, status);
    return (
      manual.filter((m) => upcoming(m.status, m.sendAt)).length +
      automation.filter((m) => upcoming(m.status, m.sendAt)).length
    );
  }, [automation, enabled, manual]);
}
