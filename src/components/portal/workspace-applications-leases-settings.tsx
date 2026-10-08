"use client";

/**
 * Settings -> Workspace -> "Automations" (route id `applicationsLeases`) (C2-CP7, C2-CP8, C2-CP9).
 *
 * MOUNT: render `<WorkspaceApplicationsLeasesSettings />` inside the Workspace settings page
 * (the settings shell's "Workspace" section, next to the other workspace sections). It is
 * self-contained: it loads and saves its own data, needs no props and no provider (it reads the
 * optional settings scope context when one exists).
 *
 * What lives here, and where it is stored:
 * - Application before a tour, Roommates in a shared room sign: the workspace leasing pipeline
 *   record (`manager_automation_settings.row_data.leasingPipeline`, `leasing-pipeline-preferences.ts`).
 *   One value for every property. There is no signing-order setting: every workspace is
 *   application first, then lease, then the move-in form (captain, Oct 3 2026).
 * - Auto-approve applications, Auto-send the lease: the workspace application automation (`autoApproveApplications`, `autoSendLease`).
 * - Deposit accounting: the workspace lease automation (`lease-automation-settings.ts`).
 * - The application <-> lease mapping and the co-signer links are NOT here: each template's popup
 *   (Add/Edit application, Add/Edit lease) carries its own row on the first step
 *   (`application-lease-mapping.ts`).
 */
import { writeThroughFetch } from "@/lib/shared-get-cache";
import { useCallback, useEffect, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import {
  DEFAULT_LEASE_AUTOMATION_SETTINGS,
  DEPOSIT_ACCOUNTING_OPTIONS,
  normalizeLeaseAutomationSettings,
  type LeaseAutomationSettings,
} from "@/lib/lease-automation-settings";
import {
  DEFAULT_LEASING_PIPELINE,
  type LeasingPipelinePreferences,
  type ApplicationBeforeTour,
  type SharedRoomLeaseDefault,
} from "@/lib/leasing-pipeline-preferences";
import { cacheLeasingPipelinePreferences } from "@/lib/leasing-pipeline-client-cache";

const APPLICATION_BEFORE_TOUR_OPTIONS = [
  { value: "not_needed", label: "Not needed" },
  { value: "required", label: "Required" },
];

const ON_OFF_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
];

const SHARED_ROOM_OPTIONS = [
  { value: "individual", label: "One lease per resident" },
  { value: "joint", label: "One joint lease for roommates" },
];

export function WorkspaceApplicationsLeasesSettings() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const { workspaceId } = useSettingsPropertyScope();

  const [loaded, setLoaded] = useState(false);
  const [pipeline, setPipeline] = useState<LeasingPipelinePreferences>(DEFAULT_LEASING_PIPELINE);
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [leaseAutomation, setLeaseAutomation] = useState<LeaseAutomationSettings>(DEFAULT_LEASE_AUTOMATION_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setLoaded(true);
        return;
      }
      try {
        const params = new URLSearchParams();
        if (workspaceId) params.set("workspaceId", workspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const [settingsRes, leaseRes] = await Promise.all([
          fetch(`/api/portal/manager-application-settings${query}`, { credentials: "include", cache: "no-store" }),
          fetch("/api/portal/lease-automation-settings", { credentials: "include", cache: "no-store" }),
        ]);
        const settings = (await settingsRes.json().catch(() => ({}))) as {
          leasingPipeline?: unknown;
          automation?: unknown;
          error?: string;
        };
        if (!settingsRes.ok) throw new Error(settings.error ?? "Could not load settings.");
        const lease = (await leaseRes.json().catch(() => ({}))) as { settings?: unknown };
        if (cancelled) return;
        setPipeline(cacheLeasingPipelinePreferences(settings.leasingPipeline));
        setAutomation(normalizeApplicationAutomation(settings.automation));
        if (leaseRes.ok) setLeaseAutomation(normalizeLeaseAutomationSettings(lease.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load settings.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast, workspaceId]);

  const withSaveStatus = useCallback(
    async (run: () => Promise<void>, failure: string) => {
      reportSaveStatus({ type: "start" });
      try {
        await run();
        reportSaveStatus({ type: "success" });
      } catch (e) {
        const message = e instanceof Error ? e.message : failure;
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
      }
    },
    [reportSaveStatus, showToast],
  );

  const patchSettings = useCallback(
    async (body: { leasingPipeline?: LeasingPipelinePreferences; automation?: ApplicationAutomationPreferences }) => {
      const res = await writeThroughFetch("/api/portal/manager-application-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...(workspaceId ? { workspaceId } : {}) }),
        keepalive: true,
      });
      const data = (await res.json().catch(() => ({}))) as { leasingPipeline?: unknown; automation?: unknown; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save.");
      return data;
    },
    [workspaceId],
  );

  const savePipeline = (patch: Partial<LeasingPipelinePreferences>) => {
    const previous = pipeline;
    const next = { ...pipeline, ...patch };
    setPipeline(next);
    if (demo) return;
    void withSaveStatus(async () => {
      try {
        const data = await patchSettings({ leasingPipeline: next });
        setPipeline(cacheLeasingPipelinePreferences(data.leasingPipeline ?? next));
      } catch (e) {
        setPipeline(previous);
        throw e;
      }
    }, "Could not save.");
  };

  const saveAutomationStep = (step: "autoApproveApplications" | "autoSendLease", value: boolean) => {
    const previous = automation;
    const next = { ...automation, [step]: value };
    setAutomation(next);
    if (demo) return;
    void withSaveStatus(async () => {
      try {
        await patchSettings({ automation: next });
      } catch (e) {
        setAutomation(previous);
        throw e;
      }
    }, "Could not save.");
  };

  const saveDepositDays = (depositAccountingDays: LeaseAutomationSettings["depositAccountingDays"]) => {
    const previous = leaseAutomation;
    setLeaseAutomation({ depositAccountingDays });
    if (demo) return;
    void withSaveStatus(async () => {
      try {
        const res = await fetch("/api/portal/lease-automation-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ depositAccountingDays }),
          keepalive: true,
        });
        const data = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Could not save.");
        setLeaseAutomation(normalizeLeaseAutomationSettings(data.settings));
      } catch (e) {
        setLeaseAutomation(previous);
        throw e;
      }
    }, "Could not save.");
  };

  const disabled = !loaded;

  return (
    <div className="space-y-6" data-attr="workspace-applications-leases-settings">
      <PortalSettingsSection title="Applications">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Application before a tour">
            <FieldSingleSelect
              hideLabel
              label="Application before a tour"
              variant="cell"
              wrapperClassName="w-64"
              options={APPLICATION_BEFORE_TOUR_OPTIONS}
              value={pipeline.applicationBeforeTour}
              disabled={disabled}
              dataAttr="workspace-application-before-tour"
              onChange={(next) => savePipeline({ applicationBeforeTour: next as ApplicationBeforeTour })}
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Auto-approve applications">
            <FieldSingleSelect
              hideLabel
              label="Auto-approve applications"
              variant="cell"
              wrapperClassName="w-64"
              options={ON_OFF_OPTIONS}
              value={automation.autoApproveApplications ? "on" : "off"}
              disabled={disabled}
              dataAttr="workspace-auto-approve-applications"
              onChange={(next) => saveAutomationStep("autoApproveApplications", next === "on")}
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
      <PortalSettingsSection id="leases" title="Leases">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Roommates in a shared room sign">
            <FieldSingleSelect
              hideLabel
              label="Roommates in a shared room sign"
              variant="cell"
              wrapperClassName="w-64"
              options={SHARED_ROOM_OPTIONS}
              value={pipeline.sharedRoomLease}
              disabled={disabled}
              dataAttr="workspace-shared-room-lease"
              onChange={(next) => savePipeline({ sharedRoomLease: next as SharedRoomLeaseDefault })}
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Deposit accounting">
            <FieldSingleSelect
              hideLabel
              label="Deposit accounting"
              variant="cell"
              wrapperClassName="w-64"
              options={DEPOSIT_ACCOUNTING_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
              value={String(leaseAutomation.depositAccountingDays)}
              disabled={disabled}
              dataAttr="workspace-deposit-accounting"
              onChange={(next) => saveDepositDays(Number(next) as LeaseAutomationSettings["depositAccountingDays"])}
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Auto-send the lease to the resident">
            <FieldSingleSelect
              hideLabel
              label="Auto-send the lease to the resident"
              variant="cell"
              wrapperClassName="w-64"
              options={ON_OFF_OPTIONS}
              value={automation.autoSendLease ? "on" : "off"}
              disabled={disabled}
              dataAttr="workspace-auto-send-lease"
              onChange={(next) => saveAutomationStep("autoSendLease", next === "on")}
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    </div>
  );
}
