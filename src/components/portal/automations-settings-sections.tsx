"use client";

/**
 * Settings → Workspace → Automations: the sections that list-page gears used to
 * open as pop-ups (Tours, Move-in forms, Screening, Vendors). Same storage and
 * APIs as before; each gear now links here (`MANAGER_SETTINGS_GEAR_TARGETS`).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { TourSettingsPanel } from "@/components/portal/pro-portal-settings-panels";
import { SettingsPropertyScope, useWorkspacePropertyOptions } from "@/components/portal/settings-property-scope-picker";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmissionOnServer,
  resolveManagerListingSubmissionForPropertyId,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import {
  MANAGER_VENDORS_EVENT,
  readManagerVendorCategorySettings,
  readOwnManagerVendorRows,
  saveManagerVendorCategorySettings,
  syncManagerVendorsFromServer,
  vendorsMatchingTrade,
} from "@/lib/manager-vendors-storage";
import { readMoveInFormSettings } from "@/lib/move-in-forms/templates";
import type { MoveInFormSettings } from "@/lib/move-in-forms/types";
import { parseManagerScreeningSettings } from "@/lib/screening/settings";
import type { ManagerScreeningSettings, ScreeningMode } from "@/lib/screening/types";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

/* ───────────────────────────── Tours ───────────────────────────── */

export function ToursSettingsSection() {
  const { options } = useWorkspacePropertyOptions();
  return (
    <PortalSettingsSection id="tours" title="Tours">
      <SettingsPropertyScope>
        <TourSettingsPanel bare propertyOptions={options} />
      </SettingsPropertyScope>
    </PortalSettingsSection>
  );
}

/* ─────────────────────────── Move-in forms ─────────────────────────── */

const REMIND_OPTIONS: { value: MoveInFormSettings["remind"]; label: string }[] = [
  { value: "before-and-due", label: "2 days before due and on the due date" },
  { value: "due-only", label: "On the due date only" },
  { value: "never", label: "Never" },
];

const NOTIFY_OPTIONS: { value: MoveInFormSettings["notifyOnSubmit"]; label: string }[] = [
  { value: "assistant", label: "Assistant notice" },
  { value: "assistant-and-email", label: "Assistant notice and email" },
  { value: "none", label: "Don't notify" },
];

/** Move-in form reminders are stored on each property's listing (`moveInFormSettings`), so this edits the property chosen above. */
function PropertyMoveInFormSettings() {
  const { userId } = useManagerUserId();
  const { showToast } = useAppUi();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const { propertyId } = useSettingsPropertyScope();
  const demo = isDemoModeActive();
  const [hit, setHit] = useState<{ sub: ManagerListingSubmissionV1; saveTarget: ManagerPropertySaveTarget } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!propertyId || !userId) {
        setHit(null);
        setLoaded(true);
        return;
      }
      setLoaded(false);
      let found = resolveManagerListingSubmissionForPropertyId(userId, propertyId);
      if (!found && !demo) {
        await syncPropertyPipelineFromServer({ userId });
        if (cancelled) return;
        found = resolveManagerListingSubmissionForPropertyId(userId, propertyId);
      }
      if (cancelled) return;
      setHit(found);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, propertyId, userId]);

  const settings = useMemo(() => readMoveInFormSettings(hit?.sub), [hit]);

  const save = useCallback(
    async (patch: Partial<MoveInFormSettings>) => {
      if (!hit || !userId) return;
      const next = { ...hit.sub, moveInFormSettings: { ...settings, ...patch } };
      setBusy(true);
      reportSaveStatus({ type: "start" });
      const ok = await persistManagerListingSubmissionOnServer(hit.saveTarget, userId, next);
      setBusy(false);
      if (!ok) {
        showToast("Could not save move-in settings.");
        reportSaveStatus({ type: "failure", reason: "Could not save move-in settings." });
        return;
      }
      setHit({ ...hit, sub: next });
      showToast("Move-in settings saved.");
      reportSaveStatus({ type: "success" });
    },
    [hit, reportSaveStatus, settings, showToast, userId],
  );

  const disabled = !loaded || !hit || busy;
  return (
    <PortalSettingsGroup>
      <PortalSettingsRow label="Remind residents">
        <FieldSingleSelect
          hideLabel
          label="Remind residents"
          variant="cell"
          wrapperClassName="w-72"
          value={settings.remind}
          options={REMIND_OPTIONS}
          disabled={disabled}
          dataAttr="settings-move-in-remind"
          onChange={(value) => void save({ remind: value as MoveInFormSettings["remind"] })}
        />
      </PortalSettingsRow>
      <PortalSettingsRow label="Tell me when a form is submitted">
        <FieldSingleSelect
          hideLabel
          label="Tell me when a form is submitted"
          variant="cell"
          wrapperClassName="w-72"
          value={settings.notifyOnSubmit}
          options={NOTIFY_OPTIONS}
          disabled={disabled}
          dataAttr="settings-move-in-notify"
          onChange={(value) => void save({ notifyOnSubmit: value as MoveInFormSettings["notifyOnSubmit"] })}
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}

export function MoveInFormsSettingsSection() {
  return (
    <PortalSettingsSection id="move-in-forms" title="Move-in forms">
      <SettingsPropertyScope allowAll={false}>
        <PropertyMoveInFormSettings />
      </SettingsPropertyScope>
    </PortalSettingsSection>
  );
}

/* ───────────────────────────── Screening ───────────────────────────── */

const SCREENING_MODE_OPTIONS: { value: ScreeningMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "manual", label: "Manual per applicant" },
  { value: "auto_on_submit", label: "Auto on submit" },
];

const DEMO_SCREENING_SETTINGS_KEY = "axis-demo-screening-settings";
const DEFAULT_SCREENING_SETTINGS: ManagerScreeningSettings = { mode: "manual" };

function readDemoScreeningSettings(): ManagerScreeningSettings {
  try {
    const raw = sessionStorage.getItem(DEMO_SCREENING_SETTINGS_KEY);
    if (raw) return parseManagerScreeningSettings(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return DEFAULT_SCREENING_SETTINGS;
}

export function ScreeningSettingsSection() {
  const { showToast } = useAppUi();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [settings, setSettings] = useState<ManagerScreeningSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (isDemoModeActive()) {
      setSettings(readDemoScreeningSettings());
      return;
    }
    void (async () => {
      try {
        const res = await fetch("/api/screening/settings", { credentials: "include" });
        const body = (await res.json().catch(() => ({}))) as { settings?: ManagerScreeningSettings; error?: string };
        if (cancelled) return;
        if (!res.ok) showToast(body.error ?? "Could not load screening settings.");
        setSettings(res.ok ? (body.settings ?? DEFAULT_SCREENING_SETTINGS) : DEFAULT_SCREENING_SETTINGS);
      } catch {
        if (!cancelled) {
          showToast("Network error loading screening settings.");
          setSettings(DEFAULT_SCREENING_SETTINGS);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  const saveMode = async (mode: ScreeningMode) => {
    setBusy(true);
    reportSaveStatus({ type: "start" });
    try {
      if (isDemoModeActive()) {
        const next = { mode };
        try {
          sessionStorage.setItem(DEMO_SCREENING_SETTINGS_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        setSettings(next);
        reportSaveStatus({ type: "success" });
        return;
      }
      const res = await fetch("/api/screening/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; settings?: ManagerScreeningSettings };
      if (!res.ok) {
        const message = body.error ?? "Could not save screening settings.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
        return;
      }
      if (body.settings) setSettings(body.settings);
      showToast("Screening settings saved.");
      reportSaveStatus({ type: "success" });
    } catch {
      showToast("Network error saving screening settings.");
      reportSaveStatus({ type: "failure", reason: "Network error saving screening settings." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalSettingsSection id="screening" title="Screening">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Background checks">
          <FieldSingleSelect
            hideLabel
            label="Background checks"
            variant="cell"
            wrapperClassName="w-64"
            value={settings?.mode ?? "manual"}
            options={SCREENING_MODE_OPTIONS}
            disabled={!settings || busy}
            dataAttr="settings-screening-mode"
            onChange={(value) => void saveMode(value as ScreeningMode)}
          />
        </PortalSettingsRow>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

/* ───────────────────────────── Vendors ───────────────────────────── */

export function VendorDefaultsSettingsSection() {
  const { userId } = useManagerUserId();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [tick, setTick] = useState(0);
  const [defaults, setDefaults] = useState<Record<string, string>>({});

  useEffect(() => {
    void syncManagerVendorsFromServer({ force: true }).then(() => setTick((n) => n + 1));
    setDefaults(readManagerVendorCategorySettings(userId).defaultVendorIdByTrade);
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onChange);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onChange);
  }, [userId]);

  const ownVendors = useMemo(() => {
    void tick;
    return readOwnManagerVendorRows(userId);
  }, [tick, userId]);

  const setDefault = (trade: string, vendorId: string) => {
    if (!userId) return;
    const next = { ...defaults };
    if (vendorId) next[trade] = vendorId;
    else delete next[trade];
    setDefaults(next);
    reportSaveStatus({ type: "start" });
    try {
      saveManagerVendorCategorySettings({ defaultVendorIdByTrade: next }, userId);
      reportSaveStatus({ type: "success" });
    } catch (e) {
      reportSaveStatus({ type: "failure", reason: e instanceof Error ? e.message : "Could not save vendor defaults." });
    }
  };

  return (
    <PortalSettingsSection id="vendors" title="Vendors">
      <PortalSettingsGroup>
        {VENDOR_TRADE_OPTIONS.map((trade) => (
          <PortalSettingsRow key={trade} label={trade}>
            <FieldSingleSelect
              hideLabel
              label={`Default vendor for ${trade}`}
              variant="cell"
              wrapperClassName="w-64"
              value={defaults[trade] ?? ""}
              options={[
                { value: "", label: "No default" },
                ...vendorsMatchingTrade(ownVendors, trade).map((vendor) => ({ value: vendor.id, label: vendor.name })),
              ]}
              disabled={!userId}
              dataAttr={`vendor-default-trade-${trade}`}
              onChange={(value) => setDefault(trade, value)}
            />
          </PortalSettingsRow>
        ))}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
