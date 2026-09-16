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
  PropertySettingsPanel,
  ResidentSettingsPanel,
  type PropertySettingsArea,
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
  SettingsSaveStatusContext,
  type ReportSettingsSaveStatus,
  type SettingsSaveStatusEvent,
} from "@/components/portal/settings-save-status-context";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { cacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { ManagerPortalAutomationSettingsPanel } from "@/components/portal/pro-portal-automation-settings-panel";
import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  activeWorkspacePropertyIds,
  filterPropertyOptionsForActiveWorkspace,
} from "@/lib/workspaces/selection";
import { shouldMountTourSettings } from "@/lib/portal-settings-module-visibility";

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
   * (the per-tab gear's dialog and the standalone `/portal/settings/<tab>` page) call this
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
 * every section's gear opens) and the standalone `/portal/settings/<tab>` page. This component
 * owns everything a module's panel needs to load, edit, and save itself — it has no idea
 * whether it is inside a dialog or a page.
 *
 * `tab` is the SAME `ManagerPortalSettingsTab` the modal has always kept as its tab id, and it
 * is also the `/portal/settings/<tab>` URL segment (see `portal-settings-section.ts`) — one
 * identifier for all three uses instead of a second id space to keep in sync.
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
  },
  ref,
) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const workspaces = useWorkspaces();
  const { userId: managerUserId } = useManagerUserId();
  const { teamMembers } = useWorkAssignmentDirectory({ managerUserId, managerName: undefined });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [propertyHubArea, setPropertyHubArea] = useState<PropertySettingsArea>("applications");
  const [residentHubArea, setResidentHubArea] = useState<ResidentSettingsArea>("household");
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [waiverCode, setWaiverCode] = useState("");
  const [panelFooter, setPanelFooter] = useState<ManagerSettingsPanelFooter | null>(null);
  const scopedPropertyOptions = useMemo(
    () => filterPropertyOptionsForActiveWorkspace(propertyOptions),
    [propertyOptions, workspaces?.active?.id],
  );
  const lockPropertyField =
    tab === "properties" || (Boolean(initialPropertyId?.trim()) && scopedPropertyOptions.length <= 1);
  const propertiesHub = tab === "properties";
  const showApplications = tab === "applications" || (propertiesHub && propertyHubArea === "applications");
  const showLease = tab === "lease" || (propertiesHub && propertyHubArea === "lease");
  const showTours = shouldMountTourSettings(active, tab, propertyHubArea);
  const hasHubHouse = Boolean(propertyId.trim());

  /** Same identity/value-equality guard as the modal's original effect — see its own history. */
  const firstPropertyOptionId = scopedPropertyOptions[0]?.id ?? "";
  useEffect(() => {
    const preferred = initialPropertyId?.trim() || firstPropertyOptionId;
    setPropertyId(preferred);
    setPropertyIds((current) => {
      const next = preferred ? [preferred] : [];
      return current.length === next.length && current.every((id, index) => id === next[index]) ? current : next;
    });
  }, [initialPropertyId, firstPropertyOptionId]);

  useEffect(() => {
    setPanelFooter(null);
  }, [tab, propertyId, propertyIds.join("|")]);

  const loadApplications = useCallback(async () => {
    const loadId = propertyIds[0] || propertyId;
    if (!loadId) {
      setAutomation(DEFAULT_APPLICATION_AUTOMATION);
      return;
    }
    if (demo) {
      setAutomation(DEFAULT_APPLICATION_AUTOMATION);
      cacheLandlordLegalName(CANONICAL_DEMO_MANAGER_NAME);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/portal/manager-application-settings?propertyId=${encodeURIComponent(loadId)}`,
        { credentials: "include" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        automation?: unknown;
        waiverCode?: string | null;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load settings.");
        return;
      }
      setAutomation(normalizeApplicationAutomation(data.automation));
      setWaiverCode(typeof data.waiverCode === "string" ? data.waiverCode : "");
    } catch {
      showToast("Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, [demo, propertyId, propertyIds, showToast]);

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

  const saveApplicationAutomationSettings = useCallback(
    async (next: ApplicationAutomationPreferences, nextWaiverCode: string, targetPropertyIds: string[]) => {
      const allowed = activeWorkspacePropertyIds();
      const ids = targetPropertyIds
        .map((id) => id.trim())
        .filter(Boolean)
        .filter((id) => allowed === null || allowed.includes(id));
      if (ids.length === 0 || demo) return;
      setSaving(true);
      reportSaveStatus({ type: "start" });
      try {
        let failureReason: string | null = null;
        for (const id of ids) {
          const res = await fetch("/api/portal/manager-application-settings", {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ propertyId: id, automation: next, waiverCode: nextWaiverCode }),
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            failureReason = data.error ?? "Could not save settings.";
            showToast(failureReason);
            break;
          }
        }
        if (failureReason) {
          reportSaveStatus({ type: "failure", reason: failureReason });
        } else {
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
    [demo, reportSaveStatus, showToast],
  );

  const commitWaiverCode = useCallback(() => {
    const ids = propertyIds.length > 0 ? propertyIds : propertyId ? [propertyId] : [];
    void saveApplicationAutomationSettings(automation, waiverCode, ids);
  }, [automation, propertyId, propertyIds, saveApplicationAutomationSettings, waiverCode]);

  const changeAutomation = useCallback(
    (next: ApplicationAutomationPreferences) => {
      setAutomation(next);
      const ids = propertyIds.length > 0 ? propertyIds : propertyId ? [propertyId] : [];
      void saveApplicationAutomationSettings(next, waiverCode, ids);
    },
    [propertyId, propertyIds, saveApplicationAutomationSettings, waiverCode],
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
      tab === "applications" || tab === "lease" || tab === "resident" || tab === "properties";
    onFooterChange?.(suppressed ? null : panelFooter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, panelFooter]);

  return (
    <SettingsSaveStatusContext.Provider value={reportSaveStatus}>
      {tab === "properties" ? (
        <PropertySettingsPanel
          propertyOptions={scopedPropertyOptions}
          selectedPropertyId={propertyId}
          onPropertyIdChange={(id) => {
            setPropertyId(id);
            setPropertyIds(id ? [id] : []);
          }}
          area={propertyHubArea}
          onAreaChange={setPropertyHubArea}
        />
      ) : null}

      {showApplications && (!propertiesHub || hasHubHouse) ? (
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
          hidePropertyField={lockPropertyField}
          teamMembers={teamMembers}
          reminderFormRef={applicationsReminderFormRef}
        />
      ) : null}

      {active && tab === "automation" ? <ManagerPortalAutomationSettingsPanel formRef={automationFormRef} /> : null}

      {showTours && (!propertiesHub || hasHubHouse) ? (
        <TourSettingsPanel
          onFooterReady={setPanelFooter}
          onSaved={onCalendarSettingsSaved}
          formRef={toursFormRef}
          teamMembers={teamMembers}
          managerReminderFormRef={tourManagerReminderFormRef}
        />
      ) : null}

      {showLease && (!propertiesHub || hasHubHouse) ? (
        <LeaseSettingsPanel
          automation={automation}
          loading={loading}
          saving={saving}
          propertyOptions={scopedPropertyOptions}
          propertyId={propertyId}
          onPropertyIdChange={setPropertyId}
          onAutomationChange={changeAutomation}
          hidePropertyField={lockPropertyField}
          teamMembers={teamMembers}
          reminderFormRef={leaseReminderFormRef}
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
