"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PaymentAutomationSettingsHandle } from "@/components/portal/payment-schedule-ui";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  ApplicationsSettingsPanel,
  TourSettingsPanel,
  CommunicationSettingsPanel,
  DEFAULT_APPLICATION_AUTOMATION,
  LeaseSettingsPanel,
  normalizeApplicationAutomation,
  PaymentsSettingsPanel,
  ResidentSettingsPanel,
  SettingsPanelModalSaveButton,
  TaskSettingsPanel,
  type ManagerSettingsPanelFooter,
} from "@/components/portal/pro-portal-settings-panels";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { cacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";
import { ManagerPortalAutomationSettingsPanel } from "@/components/portal/pro-portal-automation-settings-panel";

export type ManagerPortalSettingsTab =
  | "applications"
  | "tours"
  | "lease"
  | "tasks"
  | "resident"
  | "payments"
  | "communication"
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
  { id: "communication", label: "Communication" },
  { id: "automation", label: "Automation" },
];

export function ManagerPortalSettingsModal({
  open,
  onClose,
  initialTab = "applications",
  scoped = true,
  scopedTitle,
  onCalendarSettingsSaved,
  propertyOptions = [],
  initialPropertyId,
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: ManagerPortalSettingsTab;
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
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [panelFooter, setPanelFooter] = useState<ManagerSettingsPanelFooter | null>(null);

  /**
   * Payments settings autosaves on close, so closing the dialog has to be what
   * commits it. Without this the tab has no Save button AND no save — the
   * manager changes the schedule, closes, and nothing was written.
   */
  const paymentsFormRef = useRef<PaymentAutomationSettingsHandle | null>(null);
  const closeAndSave = useCallback(() => {
    // Close first: the save is silent and the dialog should not sit open while
    // the request runs. A failure still raises its own toast.
    onClose();
    void paymentsFormRef.current?.saveIfDirty();
  }, [onClose]);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const preferred = initialPropertyId?.trim() || propertyOptions[0]?.id || "";
    setPropertyId(preferred);
  }, [open, initialPropertyId, propertyOptions]);

  useEffect(() => {
    setPanelFooter(null);
  }, [tab, propertyId]);

  const loadApplications = useCallback(async () => {
    if (!propertyId) {
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
        `/api/portal/manager-application-settings?propertyId=${encodeURIComponent(propertyId)}`,
        { credentials: "include" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        automation?: unknown;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load settings.");
        return;
      }
      setAutomation(normalizeApplicationAutomation(data.automation));
    } catch {
      showToast("Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, [demo, propertyId, showToast]);

  useEffect(() => {
    if (!open) return;
    if (tab === "applications" || tab === "lease") {
      void loadApplications();
    }
  }, [open, tab, loadApplications]);

  /**
   * These panels autosave: a toggle IS the save, so there is no Save button.
   *
   * The write takes the next value as an argument rather than reading
   * `automation` state, and is called from the change handler rather than an
   * effect watching that state. An effect would also fire when `loadApplications`
   * seeds the state on open and on every property change — writing settings back
   * to the server that nobody touched, and racing the load it was triggered by.
   */
  const saveApplicationAutomationSettings = useCallback(
    async (next: ApplicationAutomationPreferences) => {
      if (!propertyId || demo) return;
      setSaving(true);
      try {
        const res = await fetch("/api/portal/manager-application-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyId, automation: next }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        // Silent on success — a toast per checkbox is noise when the toggle
        // itself is the feedback. A failure still has to be visible, or the
        // switch sits there looking saved when nothing was written.
        if (!res.ok) showToast(data.error ?? "Could not save settings.");
      } catch {
        showToast("Could not save settings.");
      } finally {
        setSaving(false);
      }
    },
    [demo, propertyId, showToast],
  );

  const changeAutomation = useCallback(
    (next: ApplicationAutomationPreferences) => {
      setAutomation(next);
      void saveApplicationAutomationSettings(next);
    },
    [saveApplicationAutomationSettings],
  );

  // Applications and Lease autosave, so they publish no footer at all. The other
  // tabs still own their own Save through `panelFooter`.
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
      scrollableContent={!inlineFooter}
    >
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
              onClick={() => setTab(item.id)}
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
          propertyId={propertyId}
          onPropertyIdChange={setPropertyId}
          onAutomationChange={changeAutomation}
        />
      ) : null}

      {open && tab === "automation" ? <ManagerPortalAutomationSettingsPanel /> : null}
      {open && tab === "tours" ? (
        <TourSettingsPanel onFooterReady={setPanelFooter} onSaved={onCalendarSettingsSaved} />
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
        />
      ) : null}

      {open && tab === "tasks" ? (
        <TaskSettingsPanel teamMembers={teamMembers} onFooterReady={setPanelFooter} />
      ) : null}

      {tab === "resident" ? <ResidentSettingsPanel /> : null}

      {open && tab === "payments" ? (
        <PaymentsSettingsPanel onFooterReady={setPanelFooter} formRef={paymentsFormRef} />
      ) : null}

      {open && tab === "communication" ? (
        <CommunicationSettingsPanel onFooterReady={setPanelFooter} />
      ) : null}

      {inlineFooter ? (
        <div className="mt-4 flex justify-end border-t border-border pt-3">
          <SettingsPanelModalSaveButton {...inlineFooter} />
        </div>
      ) : null}
    </Modal>
  );
}

/** @deprecated Use ManagerPortalSettingsModal — kept for imports that open application settings only. */
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
    <ManagerPortalSettingsModal
      open={open}
      onClose={onClose}
      initialTab="applications"
      scoped
      propertyOptions={propertyOptions}
    />
  );
}
