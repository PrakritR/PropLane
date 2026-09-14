"use client";

import { ChevronRight, Pencil } from "lucide-react";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PaymentAutomationSettingsHandle } from "@/components/portal/payment-schedule-ui";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { SaveStatus } from "@/components/ui/save-status";
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
  SettingsPanelModalSaveButton,
  TaskSettingsPanel,
  type ManagerSettingsPanelFooter,
} from "@/components/portal/pro-portal-settings-panels";
import type { ManagerReminderRuleSettingsHandle } from "@/components/portal/manager-reminder-rule-settings";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { cacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";
import { ManagerPortalAutomationSettingsPanel } from "@/components/portal/pro-portal-automation-settings-panel";

type PendingSaveHandle = { saveIfDirty: () => Promise<boolean> };

/**
 * Registers one autosaving panel's handle into the modal's shared save
 * registry, keyed by a stable id — this is what makes `flushPendingSaves`
 * generic instead of a hand-written call per panel.
 *
 * Returns a CALLBACK ref, not a `RefObject`. React invokes a callback ref
 * during commit (mount, update, and `null` on unmount), which is the allowed
 * place to write a ref; reading or writing a `RefObject`'s `.current` (or
 * lazily creating one) directly in a render body — which an earlier version
 * of this tried — is exactly what React's rules forbid. Module-level and
 * name-prefixed `use…` so it is itself a proper hook: called the same fixed
 * number of times, in the same order, on every render.
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

export type ManagerPortalSettingsTab =
  | "applications"
  | "tours"
  | "lease"
  | "tasks"
  | "resident"
  | "payments"
  | "services"
  | "communication"
  | "bookings"
  | "inspections"
  | "automation";

const TABS: { id: ManagerPortalSettingsTab; label: string }[] = [
  { id: "applications", label: "Applications" },
  // Renamed from "Calendar" (AXI-161): every control on this panel is a TOUR
  // setting — notice required, auto-confirm, tour reminders — so calling it
  // Calendar sent a manager looking for tour rules to the wrong tab, and one
  // looking for calendar rules to a tab that has none.
  { id: "tours", label: "Tours" },
  { id: "lease", label: "Lease" },
  { id: "tasks", label: "Tasks" },
  { id: "resident", label: "Residents" },
  { id: "payments", label: "Payments" },
  { id: "services", label: "Services" },
  { id: "communication", label: "Communication" },
  { id: "bookings", label: "Bookings" },
  { id: "inspections", label: "Inspections" },
  { id: "automation", label: "Automation" },
];

export function ProPortalSettingsModal({
  open,
  onClose,
  initialTab = "applications",
  scoped = true,
  scopedTitle,
  onCalendarSettingsSaved,
  propertyOptions = [],
  initialPropertyId,
  paymentsMode = "incoming",
  editAction,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * The section's "Edit … configuration" entry. The redesign moved module Edit
   * out of the list toolbar and under Settings, so a section that still has a
   * per-property editor hands it in here; it renders as the first row and
   * closes this dialog before opening the editor.
   */
  editAction?: { label: string; description?: string; onSelect: () => void; dataAttr?: string };
  initialTab?: ManagerPortalSettingsTab;
  /** Incoming payments = resident rent reminders; outgoing = manager payee reminders. */
  paymentsMode?: "incoming" | "outgoing";
  /**
   * Show ONLY `initialTab`'s settings, titled for that section.
   *
   * Settings opened from a section's own header should be that section's settings. Offering all
   * six tabs there makes the manager re-find the one they were already standing in, and invites
   * them to change Payments from inside Applications. Pass `scoped={false}` only for a deliberate
   * global settings hub.
   */
  scoped?: boolean;
  /** When scoped, overrides the default "{Tab label} settings" title (e.g. Tours → tour notice). */
  scopedTitle?: string;
  /** Called after Calendar settings save so the availability grid can pick up new defaults. */
  onCalendarSettingsSaved?: () => void;
  /** Live manager properties for Applications / Lease automation settings. */
  propertyOptions?: { id: string; label: string }[];
  /** Pre-select a property when opening from a filtered section. */
  initialPropertyId?: string;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const { userId: managerUserId } = useManagerUserId();
  const { teamMembers } = useWorkAssignmentDirectory({ managerUserId, managerName: undefined });
  const [tab, setTab] = useState<ManagerPortalSettingsTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [waiverCode, setWaiverCode] = useState("");
  const [panelFooter, setPanelFooter] = useState<ManagerSettingsPanelFooter | null>(null);
  const lockPropertyField = Boolean(initialPropertyId?.trim()) && propertyOptions.length <= 1;

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  /**
   * Seed the property selection on open, keyed on the first option's ID rather than the
   * `propertyOptions` array.
   *
   * A caller that omits the prop gets the `[]` default, which is a NEW array on every render —
   * so depending on the array reran this effect every render, and `setPropertyIds([])` wrote a
   * new array identity into state every time, which rendered again: "Maximum update depth
   * exceeded" the moment a section opened its settings without property options (Inspections,
   * Bookings, Residents). A string dependency plus a value-equality guard closes both halves.
   */
  const firstPropertyOptionId = propertyOptions[0]?.id ?? "";
  useEffect(() => {
    if (!open) return;
    const preferred = initialPropertyId?.trim() || firstPropertyOptionId;
    setPropertyId(preferred);
    setPropertyIds((current) => {
      const next = preferred ? [preferred] : [];
      return current.length === next.length && current.every((id, index) => id === next[index]) ? current : next;
    });
  }, [open, initialPropertyId, firstPropertyOptionId]);

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
    if (!open) return;
    if (tab === "applications" || tab === "lease") {
      void loadApplications();
    }
  }, [open, tab, loadApplications]);

  /**
   * Applications and Lease autosave: a toggle IS the save, so there is no Save
   * button on those tabs.
   *
   * The write takes the next value as an argument rather than reading
   * `automation` state, and runs from the change handler rather than an effect
   * watching that state. An effect would also fire when the panel seeds itself
   * on open and on every property change — writing back settings nobody
   * touched, and racing the load that triggered it.
   */
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
        // Silent on success — a toast per checkbox is noise when the toggle is
        // its own feedback. A failure still speaks, or the switch sits there
        // looking saved when nothing was written.
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

  /**
   * Payments and Tours settings autosave on close — closing the dialog commits changes.
   *
   * One registry instead of twelve named refs: every autosaving panel is
   * mounted only while ITS tab is selected, so a tab switch (or dialog close)
   * unmounts it and unregisters. `useSaveRegistryEntry` hands each panel a
   * stable slot in one map, keyed by id, so `flushPendingSaves` can walk
   * "whatever is currently registered" — adding a thirteenth panel means one
   * more `useSaveRegistryEntry<Handle>(saveRegistryRef, "its-id")` call here,
   * never editing a hand-written flush list that is easy to forget a line in.
   */
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

  /** Idle/saving/saved/failed for the `SaveStatus` mark beside the modal title. */
  const [saveStatus, setSaveStatus] = useState<{
    state: AutosaveState;
    reason: string | null;
    savedAt: number | null;
  }>({ state: "idle", reason: null, savedAt: null });
  // Radix's Dialog.Close fires both its own dismiss (onOpenChange) AND the
  // header button's explicit onClick, so `closeAndSave` can be entered twice
  // for one user click. `flushInFlightRef` already collapses both into one
  // save; this collapses them into one `onClose()` too.
  const closeCalledRef = useRef(false);
  useEffect(() => {
    if (open) {
      setSaveStatus({ state: "idle", reason: null, savedAt: null });
      closeCalledRef.current = false;
    }
  }, [open]);

  // One flush in flight at a time — a second trigger (double click on close, a
  // tab click while already closing) awaits the same run instead of firing every
  // panel's save twice.
  const flushInFlightRef = useRef<Promise<{ ok: boolean }> | null>(null);

  /**
   * Await every registered panel's save before the caller is allowed to act on
   * the result. `allSettled` so one panel rejecting can never stop another's
   * save from running. A panel's own `saveIfDirty` already toasts its own
   * specific failure reason (see payment-schedule-ui.tsx / manager-reminder-rule-
   * settings.tsx); this only toasts an unexpected rejection nothing else caught,
   * and always updates the header status either way. Returns `ok: false` on any
   * failure so the caller keeps the dialog open instead of discarding the edit.
   */
  const flushPendingSaves = useCallback((): Promise<{ ok: boolean }> => {
    if (flushInFlightRef.current) return flushInFlightRef.current;
    const run = async (): Promise<{ ok: boolean }> => {
      const handles = Array.from(saveRegistryRef.current.values());
      if (handles.length === 0) return { ok: true };
      setSaveStatus({ state: "saving", reason: null, savedAt: null });
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
        setSaveStatus({ state: "error", reason: failureReason, savedAt: null });
        return { ok: false };
      }
      setSaveStatus({ state: "saved", reason: null, savedAt: Date.now() });
      return { ok: true };
    };
    const promise = run().finally(() => {
      flushInFlightRef.current = null;
    });
    flushInFlightRef.current = promise;
    return promise;
  }, [showToast]);

  // Not inside the setTab updater: React may invoke an updater twice, which
  // would fire every save a second time. Flush and AWAIT before switching —
  // switching to an empty map while a save is still in flight would unmount
  // the outgoing panel and drop its edit exactly like the close bug this
  // guards against.
  const selectTab = useCallback(
    async (next: (typeof TABS)[number]["id"]) => {
      if (tab === next) return;
      const { ok } = await flushPendingSaves();
      if (!ok) return; // keep the manager on the tab that failed to save
      setTab(next);
    },
    [tab, flushPendingSaves],
  );

  /**
   * `onClose` used to run BEFORE the flush, so a panel that unmounts
   * synchronously on close had already nulled its ref by the time the save
   * fired — the edit vanished, and because every save was `void`-ed, a
   * rejected save looked exactly like a successful one. Flush and await FIRST;
   * only close once every panel's save has actually landed.
   */
  const closeAndSave = useCallback(async () => {
    const { ok } = await flushPendingSaves();
    if (!ok) return; // stay open — the failure is already surfaced via toast + header status
    if (closeCalledRef.current) return;
    closeCalledRef.current = true;
    onClose();
  }, [flushPendingSaves, onClose]);

  const changeAutomation = useCallback(
    (next: ApplicationAutomationPreferences) => {
      setAutomation(next);
      const ids = propertyIds.length > 0 ? propertyIds : propertyId ? [propertyId] : [];
      void saveApplicationAutomationSettings(next, waiverCode, ids);
    },
    [propertyId, propertyIds, saveApplicationAutomationSettings, waiverCode],
  );

  // Applications and Lease publish no footer at all; the other tabs still own
  // their own Save through `panelFooter`.
  const inlineFooter =
    tab === "applications" || tab === "lease" || tab === "resident" ? null : panelFooter;

  return (
    <Modal
      open={open}
      onClose={closeAndSave}
      title={
        scoped
          ? `${scopedTitle ?? TABS.find((item) => item.id === tab)?.label ?? "Settings"} settings`
          : "Settings"
      }
      dense
      assistantContext={
        scoped
          ? `${scopedTitle ?? TABS.find((item) => item.id === tab)?.label ?? "Settings"} settings`
          : "Portal settings"
      }
      panelClassName="max-w-lg p-3 sm:p-4"
      status={
        <SaveStatus
          status={{
            state: saveStatus.state,
            reason: saveStatus.reason,
            savedAt: saveStatus.savedAt,
            retry: () => {
              void flushPendingSaves();
            },
            flush: async () => {
              await flushPendingSaves();
            },
            dirty: saveStatus.state === "saving",
          }}
        />
      }
      // A save in flight must not be raced by an outside click or Escape closing
      // the dialog out from under it — the flush already keeps the panel's edit
      // safe, but blocking dismissal here keeps the "saving…" mark truthful.
      dismissBlocked={saveStatus.state === "saving"}
      footer={
        inlineFooter ? (
          <ModalFooter>
            <SettingsPanelModalSaveButton {...inlineFooter} />
          </ModalFooter>
        ) : undefined
      }
    >
      {editAction ? (
        <button
          type="button"
          className="mb-3 flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          data-attr={editAction.dataAttr ?? "manager-settings-edit-configuration"}
          onClick={() => {
            // Same ordering fix as closeAndSave: flush and await before this
            // dialog closes, so opening the per-property editor can never
            // step on a still-pending save from the tab just left.
            void (async () => {
              const { ok } = await flushPendingSaves();
              if (!ok) return;
              onClose();
              editAction.onSelect();
            })();
          }}
        >
          <Pencil className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">{editAction.label}</span>
            {editAction.description ? (
              <span className="block text-xs text-muted">{editAction.description}</span>
            ) : null}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
        </button>
      ) : null}
      {/* A scoped dialog is already ON its one section, so a switcher would only offer the manager
          a way to wander out of it. */}
      {scoped ? null : (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : PORTAL_TOOLBAR_PILL_BUTTON}
              data-attr={`manager-settings-tab-${item.id}`}
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

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

      {open && tab === "automation" ? <ManagerPortalAutomationSettingsPanel /> : null}
      {open && tab === "tours" ? (
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

      {open && tab === "tasks" ? (
        <TaskSettingsPanel
          teamMembers={teamMembers}
          onFooterReady={setPanelFooter}
          reminderFormRef={taskReminderFormRef}
        />
      ) : null}

      {tab === "resident" ? <ResidentSettingsPanel /> : null}

      {open && tab === "payments" ? (
        <PaymentsSettingsPanel
          onFooterReady={setPanelFooter}
          formRef={paymentsFormRef}
          mode={paymentsMode}
          teamMembers={teamMembers}
          outgoingReminderFormRef={outgoingPaymentReminderFormRef}
        />
      ) : null}

      {open && tab === "services" ? (
        <ServicesSettingsPanel
          teamMembers={teamMembers}
          onFooterReady={setPanelFooter}
          workOrderReminderFormRef={workOrderReminderFormRef}
          serviceOrderReminderFormRef={serviceOrderReminderFormRef}
        />
      ) : null}

      {open && tab === "inspections" ? (
        <InspectionsSettingsPanel
          teamMembers={teamMembers}
          onFooterReady={setPanelFooter}
          dueReminderFormRef={inspectionDueReminderFormRef}
          reviewReminderFormRef={inspectionReviewReminderFormRef}
        />
      ) : null}

      {open && tab === "bookings" ? (
        <BookingsSettingsPanel
          teamMembers={teamMembers}
          onFooterReady={setPanelFooter}
          reminderFormRef={bookingReminderFormRef}
        />
      ) : null}

      {open && tab === "communication" ? (
        <CommunicationSettingsPanel onFooterReady={setPanelFooter} />
      ) : null}
    </Modal>
  );
}

/** @deprecated Use ProPortalSettingsModal — kept for manager-* import sites. */
export const ManagerPortalSettingsModal = ProPortalSettingsModal;

/** @deprecated Use ProPortalSettingsModal — kept for imports that open application settings only. */
export function ManagerApplicationSettingsModal({
  open,
  onClose,
  propertyOptions = [],
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions?: { id: string; label: string }[];
}) {
  return (
    <ProPortalSettingsModal
      open={open}
      onClose={onClose}
      initialTab="applications"
      scoped
      propertyOptions={propertyOptions}
    />
  );
}
