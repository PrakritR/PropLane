"use client";

/**
 * Settings → Services: the knobs that drive actions (PLAN-0915). Every row is
 * a label and its control, autosaved on change through
 * `/api/portal/service-automation-settings`.
 */
import { useEffect, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  AUTO_CLOSE_OPTIONS,
  DEFAULT_SERVICE_AUTOMATION_SETTINGS,
  OFFER_EXPIRY_OPTIONS,
  RESPONSE_PROMISE_OPTIONS,
  normalizeServiceAutomationSettings,
  type ServiceAutomationSettings,
} from "@/lib/service-automation-settings";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";

export function useServiceAutomationSettings() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [settings, setSettings] = useState<ServiceAutomationSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setSettings(DEFAULT_SERVICE_AUTOMATION_SETTINGS);
        return;
      }
      try {
        const res = await fetch("/api/portal/service-automation-settings", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not load service settings.");
        if (!cancelled) setSettings(normalizeServiceAutomationSettings(body.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load service settings.");
        if (!cancelled) setSettings(DEFAULT_SERVICE_AUTOMATION_SETTINGS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

  const patch = async (next: Partial<ServiceAutomationSettings>) => {
    const previous = settings;
    setSettings((current) => normalizeServiceAutomationSettings({ ...(current ?? DEFAULT_SERVICE_AUTOMATION_SETTINGS), ...next }));
    if (demo) return;
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/service-automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save service settings.");
      setSettings(normalizeServiceAutomationSettings(body.settings));
      reportSaveStatus({ type: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save service settings.";
      setSettings(previous);
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
    }
  };

  return { settings, patch };
}

/** The request-side rows: what the resident is promised. */
export function ServiceRequestAutomationRows() {
  const { settings, patch } = useServiceAutomationSettings();
  const disabled = settings === null;
  const value = settings ?? DEFAULT_SERVICE_AUTOMATION_SETTINGS;
  return (
    <PortalSettingsGroup>
      <PortalSettingsRow label="Acknowledge new requests" className="flex-wrap gap-y-2.5">
        <FieldSingleSelect
          label="Response promise"
          hideLabel
          variant="cell"
                    wrapperClassName="w-44"
          options={RESPONSE_PROMISE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          value={value.responsePromise}
          onChange={(next) => void patch({ responsePromise: next as ServiceAutomationSettings["responsePromise"] })}
          disabled={disabled}
          dataAttr="service-automation-response-promise"
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}

/** The vendor-side rows: offers, on-my-way, confirmation, ratings. */
export function ServiceVendorAutomationRows() {
  const { settings, patch } = useServiceAutomationSettings();
  const disabled = settings === null;
  const value = settings ?? DEFAULT_SERVICE_AUTOMATION_SETTINGS;
  return (
    <PortalSettingsGroup>
      <PortalSettingsRow label="Offers expire">
        <FieldSingleSelect
          label="Offers expire"
          hideLabel
          variant="cell"
                    wrapperClassName="w-44"
          options={OFFER_EXPIRY_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
          value={String(value.offerExpiryHours)}
          onChange={(next) => void patch({ offerExpiryHours: Number(next) as ServiceAutomationSettings["offerExpiryHours"] })}
          disabled={disabled}
          dataAttr="service-automation-offer-expiry"
        />
      </PortalSettingsRow>
      <PortalSettingsRow label="Tell me when no vendor answers">
        <PortalSettingsToggle
          checked={value.notifyWhenNoVendorAnswers}
          onChange={(next) => void patch({ notifyWhenNoVendorAnswers: next })}
          label="Tell me when no vendor answers"
          disabled={disabled}
          dataAttr="service-automation-notify-no-vendor"
        />
      </PortalSettingsRow>
      <PortalSettingsRow label="Require “On my way”">
        <PortalSettingsToggle
          checked={value.requireOnMyWay}
          onChange={(next) => void patch({ requireOnMyWay: next })}
          label="Require On my way"
          disabled={disabled}
          dataAttr="service-automation-require-on-my-way"
        />
      </PortalSettingsRow>
      <PortalSettingsRow label="Ask resident to confirm the fix" className="flex-wrap gap-y-2.5">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {value.residentConfirmation ? (
            <FieldSingleSelect
              label="Auto-close"
              hideLabel
              variant="cell"
                    wrapperClassName="w-44"
              options={AUTO_CLOSE_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
              value={String(value.autoCloseHours)}
              onChange={(next) => void patch({ autoCloseHours: Number(next) as ServiceAutomationSettings["autoCloseHours"] })}
              disabled={disabled}
              dataAttr="service-automation-auto-close"
            />
          ) : null}
          <PortalSettingsToggle
            checked={value.residentConfirmation}
            onChange={(next) => void patch({ residentConfirmation: next })}
            label="Ask resident to confirm the fix"
            disabled={disabled}
            dataAttr="service-automation-resident-confirmation"
          />
        </div>
      </PortalSettingsRow>
      <PortalSettingsRow label="Share resident ratings with vendors">
        <PortalSettingsToggle
          checked={value.shareRatingsWithVendors}
          onChange={(next) => void patch({ shareRatingsWithVendors: next })}
          label="Share resident ratings with vendors"
          disabled={disabled}
          dataAttr="service-automation-share-ratings"
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}
