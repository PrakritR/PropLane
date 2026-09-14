"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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
  DEFAULT_APPLICATION_AUTOMATION,
  LeaseSettingsPanel,
  normalizeApplicationAutomation,
  PaymentsSettingsPanel,
  ResidentSettingsPanel,
  BookingsSettingsPanel,
  InspectionsSettingsPanel,
  ServicesSettingsPanel,
  TaskSettingsPanel,
  type ManagerSettingsPanelFooter,
} from "@/components/portal/pro-portal-settings-panels";
import type { ManagerReminderRuleSettingsHandle } from "@/components/portal/manager-reminder-rule-settings";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { cacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { ManagerPortalAutomationSettingsPanel } from "@/components/portal/pro-portal-automation-settings-panel";
import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";

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
  const { userId: managerUserId } = useManagerUserId();
  const { teamMembers } = useWorkAssignmentDirectory({ managerUserId, managerName: undefined });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [waiverCode, setWaiverCode] = useState("");
  const [panelFooter, setPanelFooter] = useState<ManagerSettingsPanelFooter | null>(null);
  const lockPropertyField = Boolean(initialPropertyId?.trim()) && propertyOptions.length <= 1;

  /** Same identity/value-equality guard as the modal's original effect — see its own history. */
  const firstPropertyOptionId = propertyOptions[0]?.id ?? "";
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
    if (tab === "applications" || tab === "lease") {
      void loadApplications();
    }
  }, [active, tab, loadApplications]);

  const saveApplicationAutomationSettings = useCallback(
    async (next: ApplicationAutomationPreferences, nextWaiverCode: string, targetPropertyIds: string[]) => {
      const ids = targetPropertyIds.map((id) => id.trim()).filter(Boolean);
      if (ids.length === 0 || demo) return;
      setSaving(true);
      try {
        let failed = false;
        for (const id of ids) {
          const res = await fetch("/api/portal/manager-application-settings", {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ propertyId: id, automation: next, waiverCode: nextWaiverCode }),
          });
          if (!res.ok) {
            failed = true;
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            showToast(data.error ?? "Could not save settings.");
            break;
          }
        }
        void failed;
      } catch {
        showToast("Could not save settings.");
      } finally {
        setSaving(false);
      }
    },
    [demo, showToast],
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

  // Applications, Lease, and Residents publish no footer at all — same suppression the modal
  // used to apply itself (`inlineFooter = tab === "applications" || … ? null : panelFooter`),
  // moved here so every host gets the right answer without re-deriving it.
  useEffect(() => {
    const suppressed = tab === "applications" || tab === "lease" || tab === "resident";
    onFooterChange?.(suppressed ? null : panelFooter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, panelFooter]);

  return (
    <>
      {tab === "applications" ? (
        <ApplicationsSettingsPanel
          automation={automation}
          loading={loading}
          saving={saving}
          propertyOptions={propertyOptions}
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

      {active && tab === "automation" ? <ManagerPortalAutomationSettingsPanel /> : null}

      {active && tab === "tours" ? (
        <TourSettingsPanel
          onFooterReady={setPanelFooter}
          onSaved={onCalendarSettingsSaved}
          formRef={toursFormRef}
          teamMembers={teamMembers}
          managerReminderFormRef={tourManagerReminderFormRef}
        />
      ) : null}

      {tab === "lease" ? (
        <LeaseSettingsPanel
          automation={automation}
          loading={loading}
          saving={saving}
          propertyOptions={propertyOptions}
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
        />
      ) : null}

      {tab === "resident" ? <ResidentSettingsPanel /> : null}

      {active && tab === "payments" ? (
        <PaymentsSettingsPanel
          onFooterReady={setPanelFooter}
          formRef={paymentsFormRef}
          mode={paymentsMode}
          teamMembers={teamMembers}
          outgoingReminderFormRef={outgoingPaymentReminderFormRef}
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
        <CommunicationSettingsPanel onFooterReady={setPanelFooter} />
      ) : null}
    </>
  );
});
