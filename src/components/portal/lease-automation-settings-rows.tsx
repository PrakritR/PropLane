"use client";

/** Settings → Lease: the deposit accounting deadline (PLAN-0915 phase 2). */
import { useEffect, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_LEASE_AUTOMATION_SETTINGS,
  DEPOSIT_ACCOUNTING_OPTIONS,
  normalizeLeaseAutomationSettings,
  type LeaseAutomationSettings,
} from "@/lib/lease-automation-settings";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";

export function LeaseAutomationSettingsRows() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [settings, setSettings] = useState<LeaseAutomationSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setSettings(DEFAULT_LEASE_AUTOMATION_SETTINGS);
        return;
      }
      try {
        const res = await fetch("/api/portal/lease-automation-settings", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not load lease settings.");
        if (!cancelled) setSettings(normalizeLeaseAutomationSettings(body.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load lease settings.");
        if (!cancelled) setSettings(DEFAULT_LEASE_AUTOMATION_SETTINGS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

  const patch = async (next: Partial<LeaseAutomationSettings>) => {
    const previous = settings;
    setSettings((current) => normalizeLeaseAutomationSettings({ ...(current ?? DEFAULT_LEASE_AUTOMATION_SETTINGS), ...next }));
    if (demo) return;
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/lease-automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save lease settings.");
      setSettings(normalizeLeaseAutomationSettings(body.settings));
      reportSaveStatus({ type: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save lease settings.";
      setSettings(previous);
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
    }
  };

  const value = settings ?? DEFAULT_LEASE_AUTOMATION_SETTINGS;
  return (
    <PortalSettingsGroup>
      <PortalSettingsRow label="Deposit accounting deadline">
        <FieldSingleSelect
          label="Deposit accounting deadline"
          hideLabel
          variant="cell"
          wrapperClassName="w-52"
          options={DEPOSIT_ACCOUNTING_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
          value={String(value.depositAccountingDays)}
          onChange={(next) => void patch({ depositAccountingDays: Number(next) as LeaseAutomationSettings["depositAccountingDays"] })}
          disabled={settings === null}
          dataAttr="lease-automation-deposit-days"
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}
