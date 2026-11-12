"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { ApplicantScreeningSettings } from "@/lib/screening/applicant-screening";

const REQUIREMENT_OPTIONS = [
  { value: "idCheck", label: "Verify ID" },
  { value: "backgroundCheck", label: "Background check" },
];

const UNLOCK_OPTIONS = [
  { value: "clear", label: "ID is verified" },
  { value: "order", label: "Check is ordered" },
];

/**
 * What an applicant completes BEFORE the application form opens, per listing: Verify ID, Background check, either,
 * both or none (one multi-select), and, with Verify ID on, whether the form opens once the ID is verified or as soon as
 * the check is ordered. Follows the settings scope bar (a listing, a workspace). Applications, leases and tours stay
 * free either way; the applicant pays for the checks.
 */
export function ApplicantChecksSettingsRows() {
  const { showToast } = useAppUi();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const { workspaceId, propertyId } = useSettingsPropertyScope();
  const [settings, setSettings] = useState<ApplicantScreeningSettings | null>(null);
  const [busy, setBusy] = useState(false);
  // Account scope ("All workspaces", no listing) has nothing to store a per-listing choice on.
  const hasScope = Boolean(propertyId || workspaceId);

  const query = useCallback(() => {
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    if (propertyId) params.set("propertyId", propertyId);
    return params.toString();
  }, [workspaceId, propertyId]);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    if (!hasScope) return;
    void (async () => {
      try {
        const res = await fetch(`/api/portal/applicant-screening-settings?${query()}`, { credentials: "include" });
        const body = (await res.json().catch(() => ({}))) as { settings?: ApplicantScreeningSettings; error?: string };
        if (cancelled) return;
        if (!res.ok || !body.settings) return showToast(body.error ?? "Could not load applicant checks.");
        setSettings(body.settings);
      } catch {
        if (!cancelled) showToast("Network error loading applicant checks.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasScope, query, showToast]);

  const save = async (patch: Partial<ApplicantScreeningSettings>) => {
    setBusy(true);
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/applicant-screening-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...patch, ...(workspaceId ? { workspaceId } : {}), ...(propertyId ? { propertyId } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: ApplicantScreeningSettings; error?: string };
      if (!res.ok || !body.settings) {
        const message = body.error ?? "Could not save applicant checks.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
        return;
      }
      setSettings(body.settings);
      reportSaveStatus({ type: "success" });
    } catch {
      showToast("Network error saving applicant checks.");
      reportSaveStatus({ type: "failure", reason: "Network error saving applicant checks." });
    } finally {
      setBusy(false);
    }
  };

  const selected = [...(settings?.idCheck ? ["idCheck"] : []), ...(settings?.backgroundCheck ? ["backgroundCheck"] : [])];

  return (
    <PortalSettingsGroup>
      <PortalSettingsRow label="Before applying">
        <CheckboxMultiSelect
          hideLabel
          label="Before applying"
          variant="cell"
          className="w-64"
          options={REQUIREMENT_OPTIONS}
          selected={selected}
          emptyLabel="Nothing required"
          disabled={!settings || busy}
          dataAttr="settings-applicant-preapply"
          onChange={(next) => void save({ idCheck: next.includes("idCheck"), backgroundCheck: next.includes("backgroundCheck") })}
        />
      </PortalSettingsRow>
      {settings?.idCheck ? (
        <PortalSettingsRow label="Application opens once">
          <FieldSingleSelect
            hideLabel
            label="Application opens once"
            variant="cell"
            wrapperClassName="w-64"
            value={settings.idUnlock}
            options={UNLOCK_OPTIONS}
            disabled={busy}
            dataAttr="settings-applicant-id-unlock"
            onChange={(value) => void save({ idUnlock: value === "order" ? "order" : "clear" })}
          />
        </PortalSettingsRow>
      ) : null}
    </PortalSettingsGroup>
  );
}
