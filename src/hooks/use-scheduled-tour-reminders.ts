"use client";

import { useCallback, useEffect, useState } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { PAYMENT_AUTOMATION_SETTINGS_EVENT } from "@/lib/payment-automation-settings";
import { type ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { TOUR_REMINDER_MESSAGE_KIND } from "@/lib/tour-reminder";

export function useScheduledTourReminders() {
  const [reminders, setReminders] = useState<ScheduledInboxMessageRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (isDemoModeActive()) {
      setReminders([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      const list = (body.messages ?? []).filter(
        (row) => row.messageKind === TOUR_REMINDER_MESSAGE_KIND,
      );
      setReminders(list);
    } catch {
      /* leave reminders as-is on transient failure */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onSettings = () => void reload();
    window.addEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettings);
  }, [reload]);

  return { reminders, loading, reload };
}
