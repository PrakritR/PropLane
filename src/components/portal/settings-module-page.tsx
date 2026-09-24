"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PaymentAutomationSettingsHandle } from "@/components/portal/payment-schedule-ui";
import type { AutosaveState } from "@/hooks/use-autosave-draft";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  ApplicationsSettingsPanel,
  TourSettingsPanel,
  type TourSettingsHandle,
  CommunicationSettingsPanel,
  type CommunicationSettingsHandle,
  DEFAULT_APPLICATION_AUTOMATION,
  LeaseSettingsPanel,
  normalizeApplicationAutomation,
    PaymentsSettingsPanel,
    ResidentSettingsPanel,
    type ResidentSettingsArea,
  BookingsSettingsPanel,
  InspectionsSettingsPanel,
  ServicesSettingsPanel,
  TaskSettingsPanel,
  type TaskSettingsHandle,
  type ManagerSettingsPanelFooter,
} from "@/components/portal/pro-portal-settings-panels";
import type { ManagerReminderRuleSettingsHandle } from "@/components/portal/manager-reminder-rule-settings";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
import {
  DEFAULT_MANAGER_APPLICATION_SETTINGS,
  normalizeManagerApplicationSettings,
  type ManagerApplicationSettings,
} from "@/lib/manager-application-settings";
import {
  DEFAULT_LEASING_PIPELINE,
  normalizeLeasingPipelinePreferences,
  type LeasingPipelinePreferences,
} from "@/lib/leasing-pipeline-preferences";
import { cacheLeasingPipelinePreferences } from "@/lib/leasing-pipeline-client-cache";
import {
  SettingsSaveStatusContext,
  type ReportSettingsSaveStatus,
  type SettingsSaveStatusEvent,
} from "@/components/portal/settings-save-status-context";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { cacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { ManagerPortalAutomationSettingsPanel } from "@/components/portal/pro-portal-automation-settings-panel";
import { PortalPayoutsSettingsPage } from "@/components/portal/portal-payouts-settings-page";
import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  allWorkspacePropertyOptions,
  propertyOptionsFromWorkspacePayload,
  unionLabeledPropertyOptions,
} from "@/lib/workspaces/selection";
import { shouldMountTourSettings } from "@/lib/portal-settings-module-visibility";
import {
  useSettingsPropertyScope,
  type SettingsResolutionSource,
} from "@/components/portal/settings-property-scope";

type PendingSaveHandle = { saveIfDirty: () => Promise<boolean> };

/**
 * Registers one autosaving panel's handle into this module's shared save
 * registry, keyed by a stable id — this is what makes `flushPendingSaves`
 * generic instead of a hand-written call per panel. Moved verbatim out of
 * `pro-portal-settings-modal.tsx`, which now delegates all panel rendering
 * here (see that file's own comment history for why this must be a callback
 * ref, not a `RefObject`).
 */
function useSaveRegistryEntry<T extends PendingSaveHandle>(
  registryRef: RefObject<Map<string, PendingSaveHandle>>,
  id: string,
): (instance: T | null) => void {
  return useCallback(
    (instance: T | null) => {
      if (instance) registryRef.current.set(id, instance);
      else registryRef.current.delete(id);
    },
    [registryRef, id],
  );
}

export type SettingsModulePageHandle = {
  /**
   * Flush every autosaving panel this module currently has mounted, `allSettled` so one
   * panel's rejection can never stop a sibling's save. Returns `ok: false` on any failure so
   * the caller can keep its host open/on-tab instead of discarding the edit — both hosts
   * (the per-tab gear's dialog and the Profile hub pane) call this
   * before closing, switching tabs, or navigating away.
   */
  flushPendingSaves: () => Promise<{ ok: boolean }>;
};

export type SettingsModuleSaveStatus = {
  state: AutosaveState;
  reason: string | null;
  savedAt: number | null;
};

/**
 * One module's settings UI, portable between two hosts: `ProPortalSettingsModal` (the sheet
 * every section's gear opens) and the Profile hub pane. This component
 * owns everything a module's panel needs to load, edit, and save itself — it has no idea
 * whether it is inside a dialog or a page.
 *
 * `tab` is the SAME `ManagerPortalSettingsTab` the modal has always kept as its tab id.
 * Profile hub `?tab=` ids can differ (`managerSettingsHubTab`).
 */
export const SettingsModulePage = forwardRef<
  SettingsModulePageHandle,
  {
    tab: ManagerPortalSettingsTab;
    /** Live manager properties for Applications / Lease automation settings. */
    propertyOptions?: { id: string; label: string }[];
    /** Pre-select a property when opening from a filtered section. */
    initialPropertyId?: string;
    /** Incoming payments = resident rent reminders; outgoing = manager payee reminders. */
    paymentsMode?: "incoming" | "outgoing";
    /** Called after Calendar/Tour settings save so the availability grid can pick up new defaults. */
    onCalendarSettingsSaved?: () => void;
    /** Bubbles the currently mounted panel's own Save-button footer, or `null` for a panel with none. */
    onFooterChange?: (footer: ManagerSettingsPanelFooter | null) => void;
    /** Bubbles the idle/saving/saved/error mark a host can show beside its own title. */
    onSaveStatusChange?: (status: SettingsModuleSaveStatus) => void;
    /**
     * False while the host is not actually showing this module (e.g. a closing dialog's exit
     * animation) — stops an autosaving panel from firing a load/fetch during that window.
     * Mirrors the modal's own former per-tab `open &&` guards exactly, tab for tab.
     */
    active?: boolean;
    /** Hub page: Form row jumps to the listing. Popup Form pane already owns that. */
    showFormLink?: boolean;
  }
>(function SettingsModulePage(
  {
    tab,
    propertyOptions = [],
    initialPropertyId,
    paymentsMode = "incoming",
    onCalendarSettingsSaved,
    onFooterChange,
    onSaveStatusChange,
    active = true,
    showFormLink = false,
  },
  ref,
) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const workspaces = useWorkspaces();
  const { userId: managerUserId } = useManagerUserId();
  const { teamMembers } = useWorkAssignmentDirectory({ managerUserId, managerName: undefined });
  const scope = useSettingsPropertyScope();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [residentHubArea, setResidentHubArea] = useState<ResidentSettingsArea>("household");
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [waiverCode, setWaiverCode] = useState("");
  const [applicationSettings, setApplicationSettings] = useState<ManagerApplicationSettings>(
    DEFAULT_MANAGER_APPLICATION_SETTINGS,
  );
  const [leasingPipeline, setLeasingPipeline] = useState<LeasingPipelinePreferences>(DEFAULT_LEASING_PIPELINE);
  const [applicationSource, setApplicationSource] = useState<SettingsResolutionSource | null>(null);
  const [panelFooter, setPanelFooter] = useState<ManagerSettingsPanelFooter | null>(null);
  const scopedPropertyOptions = useMemo(() => {
    const listed = workspaces?.workspaces ?? [];
    if (!scope.workspaceId) {
      return unionLabeledPropertyOptions(allWorkspacePropertyOptions(listed), propertyOptions);
    }
    const workspace = listed.find((item) => item.id === scope.workspaceId);
    if (!workspace) return propertyOptions;
    const fromPayload = propertyOptionsFromWorkspacePayload(workspace);
    const allowed = new Set(fromPayload.map((option) => option.id));
    return unionLabeledPropertyOptions(
      fromPayload,
      propertyOptions.filter((option) => allowed.has(option.id)),
    );
  }, [propertyOptions, scope.workspaceId, workspaces?.workspaces]);
  const showApplications = tab === "applications";
  const showLease = tab === "lease";
  const showTours = shouldMountTourSettings(active, tab);

  const scopePropertyIds = scope.propertyIds;
  useEffect(() => {
    // The module's own local property target now mirrors the bar's FULL
    // selection (PLAN-0920-0845 phase D), not just a single house — a legacy
    // caller's `initialPropertyId` seeds it only while the bar has picked none.
    const preferred = scopePropertyIds.length > 0 ? scopePropertyIds : initialPropertyId ? [initialPropertyId.trim()].filter(Boolean) : [];
    setPropertyIds((current) =>
      current.length === preferred.length && current.every((id, index) => id === preferred[index]) ? current : preferred,
    );
    setPropertyId(preferred[0] ?? "");
  }, [initialPropertyId, scopePropertyIds]);

  useEffect(() => {
    setPanelFooter(null);
  }, [tab, propertyId, propertyIds.join("|")]);

  const loadApplications = useCallback(async () => {
    if (demo) {
      setAutomation(DEFAULT_APPLICATION_AUTOMATION);
      setApplicationSettings(DEFAULT_MANAGER_APPLICATION_SETTINGS);
      setLeasingPipeline(DEFAULT_LEASING_PIPELINE);
      cacheLandlordLegalName(CANONICAL_DEMO_MANAGER_NAME);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // Reading one house shows that house's own values; reading several (or
      // none) reads the shared workspace/account rung every one of them falls
      // back to — the FIRST selected id is enough to resolve that rung.
      const loadId = propertyIds.length === 1 ? propertyIds[0] : "";
      if (loadId) params.set("propertyId", loadId);
      if (scope.workspaceId) params.set("workspaceId", scope.workspaceId);
      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`/api/portal/manager-application-settings${query}`, { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        automation?: unknown;
        waiverCode?: string | null;
        settings?: unknown;
        leasingPipeline?: unknown;
        error?: string;
        source?: SettingsResolutionSource;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load settings.");
        return;
      }
      setAutomation(normalizeApplicationAutomation(data.automation));
      setWaiverCode(typeof data.waiverCode === "string" ? data.waiverCode : "");
      setApplicationSettings(normalizeManagerApplicationSettings(data.settings));
      setLeasingPipeline(normalizeLeasingPipelinePreferences(data.leasingPipeline));
      cacheLeasingPipelinePreferences(data.leasingPipeline);
      setApplicationSource(data.source ?? null);
      scope.reportSource("manager-application-settings", data.source);
    } catch {
      showToast("Could not load settings.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, propertyIds, scope.workspaceId, showToast]);

  useEffect(() => {
    if (!active) return;
    if (showApplications || showLease) {
      void loadApplications();
    }
  }, [active, showApplications, showLease, loadApplications]);

  /**
   * How many per-control autosaves (this panel's own Applications/Lease writes below, plus
   * every descendant reading `useReportSettingsSaveStatus()` through the context provider at
   * the bottom of this component) are currently in flight — so two panels saving at once
   * settle to "saved" only once BOTH land, instead of the first one's success flipping the mark
   * back while the second is still writing. Reset whenever the module itself changes so a count
   * from the outgoing tab can never leak into the incoming one.
   */
  const saveStatusInFlightRef = useRef(0);
  const reportSaveStatus = useCallback<ReportSettingsSaveStatus>(
    (event: SettingsSaveStatusEvent) => {
      if (event.type === "start") {
        saveStatusInFlightRef.current += 1;
        onSaveStatusChange?.({ state: "saving", reason: null, savedAt: null });
        return;
      }
      saveStatusInFlightRef.current = Math.max(0, saveStatusInFlightRef.current - 1);
      if (event.type === "failure") {
        onSaveStatusChange?.({ state: "error", reason: event.reason, savedAt: null });
        return;
      }
      if (saveStatusInFlightRef.current === 0) {
        onSaveStatusChange?.({ state: "saved", reason: null, savedAt: Date.now() });
      }
    },
    [onSaveStatusChange],
  );
  useEffect(() => {
    saveStatusInFlightRef.current = 0;
  }, [tab]);

  /**
   * A PATCH only ever carries the field the manager actually changed.
   * `automation` and `waiverCode` used to ride along together on every save —
   * toggling auto-approve across several properties replayed whatever promo
   * code happened to be loaded onto each of them, and a promo-code save sent
   * a phantom automation write. The codes table is also unique on
   * (manager, code text), so a promo code is a single-property write; callers
   * must never fan it out.
   */
  const saveApplicationAutomationSettings = useCallback(
    async (
      fields: {
        automation?: ApplicationAutomationPreferences;
        waiverCode?: string;
        applicationFeeCents?: number | null;
        applicationFeeChargePolicy?: ManagerApplicationSettings["applicationFeeChargePolicy"];
        leasingPipeline?: LeasingPipelinePreferences;
      },
      targetPropertyIds: string[],
    ) => {
      if (demo) return;
      const allowed = scope.workspaceId
        ? (workspaces?.workspaces.find((item) => item.id === scope.workspaceId)?.propertyIds ?? [])
            .map((id) => id.trim())
            .filter(Boolean)
        : null;
      const ids = targetPropertyIds
        .map((id) => id.trim())
        .filter(Boolean)
        .filter((id) => allowed === null || allowed.includes(id));
      setSaving(true);
      reportSaveStatus({ type: "start" });
      try {
        let failureReason: string | null = null;
        let lastSource: SettingsResolutionSource | undefined;
        if (ids.length > 0) {
          for (const id of ids) {
            const res = await fetch("/api/portal/manager-application-settings", {
              method: "PATCH",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ propertyId: id, ...fields }),
            });
            const data = (await res.json().catch(() => ({}))) as { error?: string; source?: SettingsResolutionSource };
            if (!res.ok) {
              failureReason = data.error ?? "Could not save settings.";
              showToast(failureReason);
              break;
            }
            lastSource = data.source;
          }
        } else {
          // "All properties" — a house-less write targets the workspace rung ("" reads/writes
          // the account when no workspace is chosen either). Never fans an account-wide value
          // out onto every property record.
          const res = await fetch("/api/portal/manager-application-settings", {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...fields,
              ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
            }),
          });
          const data = (await res.json().catch(() => ({}))) as { error?: string; source?: SettingsResolutionSource };
          if (!res.ok) {
            failureReason = data.error ?? "Could not save settings.";
            showToast(failureReason);
          } else {
            lastSource = data.source;
          }
        }
        if (failureReason) {
          reportSaveStatus({ type: "failure", reason: failureReason });
        } else {
          setApplicationSource(lastSource ?? null);
          scope.reportSource("manager-application-settings", lastSource);
          reportSaveStatus({ type: "success" });
        }
      } catch {
        const message = "Could not save settings.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
      } finally {
        setSaving(false);
      }
    },
    [demo, reportSaveStatus, showToast, scope.workspaceId, scope.reportSource, workspaces?.workspaces],
  );

  const commitWaiverCode = useCallback(() => {
    const ids = propertyIds.length > 0 ? propertyIds : propertyId ? [propertyId] : [];
    // A promo code belongs to exactly one property. Anything else — none
    // selected, or more than one — is inert rather than a half-write.
    if (ids.length !== 1) return;
    void saveApplicationAutomationSettings({ waiverCode }, ids);
  }, [propertyId, propertyIds, saveApplicationAutomationSettings, waiverCode]);

  const changeAutomation = useCallback(
    (next: ApplicationAutomationPreferences) => {
      setAutomation(next);
      const ids = propertyIds.length > 0 ? propertyIds : propertyId ? [propertyId] : [];
      void saveApplicationAutomationSettings({ automation: next }, ids);
    },
    [propertyId, propertyIds, saveApplicationAutomationSettings],
  );

  const changeApplicationSettings = useCallback(
    (next: ManagerApplicationSettings) => {
      setApplicationSettings(next);
      // Fee is account-wide — never fan out onto property ids.
      void saveApplicationAutomationSettings(
        {
          applicationFeeCents: next.applicationFeeCents,
          applicationFeeChargePolicy: next.applicationFeeChargePolicy,
        },
        [],
      );
    },
    [saveApplicationAutomationSettings],
  );

  const changeLeasingPipeline = useCallback(
    (next: LeasingPipelinePreferences) => {
      setLeasingPipeline(next);
      cacheLeasingPipelinePreferences(next);
      const ids = propertyIds.length === 1 ? propertyIds : [];
      void saveApplicationAutomationSettings({ leasingPipeline: next }, ids);
    },
    [propertyIds, saveApplicationAutomationSettings],
  );

  const saveRegistryRef = useRef(new Map<string, PendingSaveHandle>());
  const paymentsFormRef = useSaveRegistryEntry<PaymentAutomationSettingsHandle>(saveRegistryRef, "payments");
  const toursFormRef = useSaveRegistryEntry<TourSettingsHandle>(saveRegistryRef, "tours");
  const taskFormRef = useSaveRegistryEntry<TaskSettingsHandle>(saveRegistryRef, "tasks");
  const communicationFormRef = useSaveRegistryEntry<CommunicationSettingsHandle>(
    saveRegistryRef,
    "communication",
  );
  const automationFormRef = useSaveRegistryEntry<PaymentAutomationSettingsHandle>(
    saveRegistryRef,
    "automation",
  );
  const applicationsReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "applications-reminder",
  );
  const leaseReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "lease-reminder",
  );
  const tourManagerReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "tour-manager-reminder",
  );
  const taskReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "task-reminder",
  );
  const outgoingPaymentReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "outgoing-payment-reminder",
  );
  const workOrderReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "work-order-reminder",
  );
  const serviceOrderReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "service-order-reminder",
  );
  const inspectionDueReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "inspection-due-reminder",
  );
  const inspectionReviewReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "inspection-review-reminder",
  );
  const bookingReminderFormRef = useSaveRegistryEntry<ManagerReminderRuleSettingsHandle>(
    saveRegistryRef,
    "booking-reminder",
  );

  // One flush in flight at a time — see pro-portal-settings-modal.tsx's original comment; the
  // same collapsing behavior is preserved here verbatim.
  const flushInFlightRef = useRef<Promise<{ ok: boolean }> | null>(null);
  const flushPendingSaves = useCallback((): Promise<{ ok: boolean }> => {
    if (flushInFlightRef.current) return flushInFlightRef.current;
    const run = async (): Promise<{ ok: boolean }> => {
      const handles = Array.from(saveRegistryRef.current.values());
      if (handles.length === 0) return { ok: true };
      onSaveStatusChange?.({ state: "saving", reason: null, savedAt: null });
      const results = await Promise.allSettled(handles.map((handle) => handle.saveIfDirty()));
      let failureReason: string | null = null;
      for (const result of results) {
        if (result.status === "rejected") {
          const message = result.reason instanceof Error ? result.reason.message : "Could not save settings.";
          failureReason = failureReason ?? message;
          showToast(message);
        } else if (result.value === false) {
          failureReason = failureReason ?? "A setting could not be saved. Check the highlighted tab and try again.";
        }
      }
      if (failureReason) {
        onSaveStatusChange?.({ state: "error", reason: failureReason, savedAt: null });
        return { ok: false };
      }
      onSaveStatusChange?.({ state: "saved", reason: null, savedAt: Date.now() });
      return { ok: true };
    };
    const promise = run().finally(() => {
      flushInFlightRef.current = null;
    });
    flushInFlightRef.current = promise;
    return promise;
  }, [showToast, onSaveStatusChange]);

  useImperativeHandle(ref, () => ({ flushPendingSaves }), [flushPendingSaves]);

  /**
   * A debounced per-control autosave (the 600ms window every panel below uses) is still pending
   * when the manager leaves — closes the tab, reloads, backgrounds the app, or switches native
   * apps — and neither `beforeunload` nor a clean React unmount is reliable there (Safari/native
   * shells drop `beforeunload`, and by the time ANY ancestor's unmount cleanup runs, a child
   * panel has already deregistered itself from `saveRegistryRef` — see this file's own
   * `useSaveRegistryEntry`). `visibilitychange`/`pagehide` fire while the tree is still fully
   * mounted, so `flushPendingSaves()` still finds every panel's real handle — same precedent as
   * `pro-add-listing-form.tsx`'s `flushOnHide` and `manager-applications-storage.ts`'s unload
   * flush. A REJECTED flush already surfaces via each panel's own unconditional failure toast and
   * `onSaveStatusChange`'s "error" state — nothing extra to add here for that.
   */
  useEffect(() => {
    const flushOnHide = () => {
      if (document.visibilityState !== "hidden") return;
      void flushPendingSaves();
    };
    document.addEventListener("visibilitychange", flushOnHide);
    window.addEventListener("pagehide", flushOnHide);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHide);
      window.removeEventListener("pagehide", flushOnHide);
    };
  }, [flushPendingSaves]);

  // Applications, Lease, and Residents publish no footer at all — same suppression the modal
  // used to apply itself (`inlineFooter = tab === "applications" || … ? null : panelFooter`),
  // moved here so every host gets the right answer without re-deriving it.
  useEffect(() => {
    const suppressed =
      tab === "applications" || tab === "lease" || tab === "resident" || tab === "payouts";
    onFooterChange?.(suppressed ? null : panelFooter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, panelFooter]);

  return (
    <SettingsSaveStatusContext.Provider value={reportSaveStatus}>
      {showApplications ? (
        <ApplicationsSettingsPanel
          automation={automation}
          loading={loading}
          saving={saving}
          propertyOptions={scopedPropertyOptions}
          propertyIds={propertyIds}
          onPropertyIdsChange={(next) => {
            setPropertyIds(next);
            setPropertyId(next[0] ?? "");
          }}
          onAutomationChange={changeAutomation}
          waiverCode={waiverCode}
          onWaiverCodeChange={setWaiverCode}
          onWaiverCodeCommit={commitWaiverCode}
          teamMembers={teamMembers}
          reminderFormRef={applicationsReminderFormRef}
          showFormLink={showFormLink}
          source={applicationSource}
          applicationSettings={applicationSettings}
          onApplicationSettingsChange={changeApplicationSettings}
          leasingPipeline={leasingPipeline}
          onLeasingPipelineChange={changeLeasingPipeline}
        />
      ) : null}

      {active && tab === "automation" ? <ManagerPortalAutomationSettingsPanel formRef={automationFormRef} /> : null}

      {showTours ? (
        <TourSettingsPanel
          onFooterReady={setPanelFooter}
          onSaved={onCalendarSettingsSaved}
          formRef={toursFormRef}
          teamMembers={teamMembers}
          managerReminderFormRef={tourManagerReminderFormRef}
        />
      ) : null}

      {showLease ? (
        <LeaseSettingsPanel
          automation={automation}
          loading={loading}
          saving={saving}
          propertyOptions={scopedPropertyOptions}
          propertyId={propertyId}
          onPropertyIdChange={setPropertyId}
          onAutomationChange={changeAutomation}
          teamMembers={teamMembers}
          reminderFormRef={leaseReminderFormRef}
          showFormLink={showFormLink}
          source={applicationSource}
          leasingPipeline={leasingPipeline}
          onLeasingPipelineChange={changeLeasingPipeline}
        />
      ) : null}

      {active && tab === "tasks" ? (
        <TaskSettingsPanel
          teamMembers={teamMembers}
          onFooterReady={setPanelFooter}
          reminderFormRef={taskReminderFormRef}
          formRef={taskFormRef}
        />
      ) : null}

      {tab === "resident" ? (
        <ResidentSettingsPanel
          propertyOptions={scopedPropertyOptions}
          selectedPropertyId={propertyId}
          onPropertyIdChange={(id) => {
            setPropertyId(id);
            setPropertyIds(id ? [id] : []);
          }}
          area={residentHubArea}
          onAreaChange={setResidentHubArea}
          teamMembers={teamMembers}
          paymentsFormRef={paymentsFormRef}
          householdFormRef={leaseReminderFormRef}
        />
      ) : null}

      {active && tab === "payments" ? (
        <PaymentsSettingsPanel
          onFooterReady={setPanelFooter}
          formRef={paymentsFormRef}
          mode={paymentsMode}
          teamMembers={teamMembers}
          outgoingReminderFormRef={outgoingPaymentReminderFormRef}
          propertyOptions={scopedPropertyOptions}
          initialPropertyId={initialPropertyId}
        />
      ) : null}

      {active && tab === "payouts" ? <PortalPayoutsSettingsPage portal="manager" /> : null}

      {active && tab === "services" ? (
        <ServicesSettingsPanel
          teamMembers={teamMembers}
          onFooterReady={setPanelFooter}
          workOrderReminderFormRef={workOrderReminderFormRef}
          serviceOrderReminderFormRef={serviceOrderReminderFormRef}
        />
      ) : null}

      {active && tab === "inspections" ? (
        <InspectionsSettingsPanel
          teamMembers={teamMembers}
          onFooterReady={setPanelFooter}
          dueReminderFormRef={inspectionDueReminderFormRef}
          reviewReminderFormRef={inspectionReviewReminderFormRef}
        />
      ) : null}

      {active && tab === "bookings" ? (
        <BookingsSettingsPanel
          teamMembers={teamMembers}
          onFooterReady={setPanelFooter}
          reminderFormRef={bookingReminderFormRef}
        />
      ) : null}

      {active && tab === "communication" ? (
        <CommunicationSettingsPanel onFooterReady={setPanelFooter} formRef={communicationFormRef} />
      ) : null}
    </SettingsSaveStatusContext.Provider>
  );
});
