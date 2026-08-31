"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_TALL_PANEL_CLASS, PORTAL_MODAL_BODY_SCROLL_CLASS } from "@/components/ui/modal-styles";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  ApplicationsSettingsPanel,
  CalendarSettingsPanel,
  CommunicationSettingsPanel,
  DEFAULT_APPLICATION_AUTOMATION,
  DEFAULT_TASK_AUTOMATION,
  LeaseSettingsPanel,
  normalizeApplicationAutomation,
  PaymentsSettingsPanel,
  ResidentSettingsPanel,
  SettingsPanelModalSaveButton,
  type ManagerSettingsPanelFooter,
} from "@/components/portal/manager-portal-settings-panels";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
import type { ApplicationFeeChargePolicy } from "@/lib/manager-application-settings";
import { DEFAULT_MANAGER_APPLICATION_SETTINGS } from "@/lib/manager-application-settings";
import {
  normalizeTaskAutomation,
  type TaskAutomationPreferences,
} from "@/lib/task-automation-preferences";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { cn } from "@/lib/utils";
import { cacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";
import { ManagerReminderSettingsPanel } from "@/components/portal/manager-reminder-settings-panel";
import { ManagerTaskAutomationSettingsPanel } from "@/components/portal/manager-task-automation-settings-panel";

export type ManagerPortalSettingsTab =
  | "applications"
  | "calendar"
  | "lease"
  | "resident"
  | "payments"
  | "communication"
  | "reminders"
  | "task-automation";

const TABS: { id: ManagerPortalSettingsTab; label: string }[] = [
  { id: "applications", label: "Applications" },
  { id: "calendar", label: "Calendar" },
  { id: "lease", label: "Lease" },
  { id: "resident", label: "Residents" },
  { id: "payments", label: "Payments" },
  { id: "communication", label: "Communication" },
  { id: "reminders", label: "Reminders" },
  { id: "task-automation", label: "Task automation" },
];

export function ManagerPortalSettingsModal({
  open,
  onClose,
  initialTab = "applications",
  scoped = true,
  scopedTitle,
  onCalendarSettingsSaved,
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
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const { userId: managerUserId } = useManagerUserId();
  const { teamMembers } = useWorkAssignmentDirectory({ managerUserId, managerName: undefined });
  const [tab, setTab] = useState<ManagerPortalSettingsTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [waiverCode, setWaiverCode] = useState("");
  const [feeCents, setFeeCents] = useState<number | null>(null);
  const [chargePolicy, setChargePolicy] = useState<ApplicationFeeChargePolicy>(
    DEFAULT_MANAGER_APPLICATION_SETTINGS.applicationFeeChargePolicy,
  );
  const [otherInstructionsEnabled, setOtherInstructionsEnabled] = useState(false);
  const [otherInstructions, setOtherInstructions] = useState("");
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [taskAutomation, setTaskAutomation] = useState<TaskAutomationPreferences>(DEFAULT_TASK_AUTOMATION);
  const [panelFooter, setPanelFooter] = useState<ManagerSettingsPanelFooter | null>(null);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    setPanelFooter(null);
  }, [tab]);

  const loadApplications = useCallback(async () => {
    if (demo) {
      setWaiverCode("WELCOME50");
      setFeeCents(5000);
      setChargePolicy("first_only");
      setOtherInstructionsEnabled(false);
      setOtherInstructions("");
      setAutomation(DEFAULT_APPLICATION_AUTOMATION);
      setTaskAutomation(DEFAULT_TASK_AUTOMATION);
      cacheLandlordLegalName(CANONICAL_DEMO_MANAGER_NAME);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/manager-application-settings", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: {
          applicationFeeCents: number | null;
          applicationFeeChargePolicy?: ApplicationFeeChargePolicy;
          applicationFeeOtherEnabled?: boolean;
          applicationFeeOtherInstructions?: string;
        };
        automation?: unknown;
        taskAutomation?: unknown;
        waiverCode?: string | null;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load settings.");
        return;
      }
      setFeeCents(data.settings?.applicationFeeCents ?? null);
      setChargePolicy(data.settings?.applicationFeeChargePolicy ?? "first_only");
      setOtherInstructionsEnabled(Boolean(data.settings?.applicationFeeOtherEnabled));
      setOtherInstructions((data.settings?.applicationFeeOtherInstructions ?? "").trim());
      setAutomation(normalizeApplicationAutomation(data.automation));
      setTaskAutomation(normalizeTaskAutomation(data.taskAutomation));
      setWaiverCode((data.waiverCode ?? "").trim());
    } catch {
      showToast("Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

  useEffect(() => {
    if (!open) return;
    if (tab === "applications" || tab === "lease") {
      void loadApplications();
    }
  }, [open, tab, loadApplications]);

  async function saveApplicationBundle(patch: {
    waiverCode?: string;
    automation?: ApplicationAutomationPreferences;
    taskAutomation?: TaskAutomationPreferences;
  }) {
    if (demo) {
      showToast("Settings saved (demo).");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/portal/manager-application-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationFeeCents: feeCents,
          applicationFeeChargePolicy: chargePolicy,
          applicationFeeOtherEnabled: otherInstructionsEnabled,
          applicationFeeOtherInstructions: otherInstructions,
          waiverCode: patch.waiverCode ?? waiverCode.trim(),
          automation: patch.automation ?? automation,
          taskAutomation: patch.taskAutomation ?? taskAutomation,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not save settings.");
        return;
      }
      if (patch.automation) setAutomation(patch.automation);
      if (patch.taskAutomation) setTaskAutomation(patch.taskAutomation);
      showToast("Settings saved.");
    } catch {
      showToast("Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  const modalFooter = useMemo((): ManagerSettingsPanelFooter | null => {
    if (tab === "applications") {
      return {
        saving,
        disabled: loading,
        onSave: () =>
          void saveApplicationBundle({
            waiverCode: waiverCode.trim(),
            automation,
            taskAutomation,
          }),
        dataAttr: "manager-application-fee-save",
      };
    }
    if (tab === "lease") {
      return {
        saving,
        disabled: loading,
        onSave: () => void saveApplicationBundle({ automation, taskAutomation }),
      };
    }
    if (tab === "resident") return null;
    return panelFooter;
  }, [automation, loading, panelFooter, saving, tab, taskAutomation, waiverCode]);

  return (
    <Modal
      open={open}
      onClose={onClose}
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
      panelClassName={cn("max-w-lg p-3 sm:p-4", MODAL_TALL_PANEL_CLASS)}
      footer={
        modalFooter ? (
          <ModalFooter>
            <SettingsPanelModalSaveButton {...modalFooter} />
          </ModalFooter>
        ) : undefined
      }
    >
      <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
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
          taskAutomation={taskAutomation}
          teamMembers={teamMembers}
          loading={loading}
          saving={saving}
          waiverCode={waiverCode}
          feeCents={feeCents}
          onFeeCentsChange={setFeeCents}
          chargePolicy={chargePolicy}
          onChargePolicyChange={setChargePolicy}
          otherInstructionsEnabled={otherInstructionsEnabled}
          onOtherInstructionsEnabledChange={setOtherInstructionsEnabled}
          otherInstructions={otherInstructions}
          onOtherInstructionsChange={setOtherInstructions}
          onAutomationChange={setAutomation}
          onTaskAutomationChange={setTaskAutomation}
          onWaiverCodeChange={setWaiverCode}
          onSave={() =>
            void saveApplicationBundle({
              waiverCode: waiverCode.trim(),
              automation,
              taskAutomation,
            })
          }
        />
      ) : null}

      {tab === "reminders" ? <ManagerReminderSettingsPanel /> : null}
      {tab === "task-automation" ? <ManagerTaskAutomationSettingsPanel /> : null}
      {tab === "calendar" ? (
        <CalendarSettingsPanel onFooterReady={setPanelFooter} onSaved={onCalendarSettingsSaved} />
      ) : null}

      {tab === "lease" ? (
        <LeaseSettingsPanel
          automation={automation}
          taskAutomation={taskAutomation}
          teamMembers={teamMembers}
          loading={loading}
          saving={saving}
          onAutomationChange={setAutomation}
          onTaskAutomationChange={setTaskAutomation}
          onSave={() => void saveApplicationBundle({ automation, taskAutomation })}
        />
      ) : null}

      {tab === "resident" ? <ResidentSettingsPanel /> : null}

      {tab === "payments" ? <PaymentsSettingsPanel onFooterReady={setPanelFooter} /> : null}

      {tab === "communication" ? <CommunicationSettingsPanel onFooterReady={setPanelFooter} /> : null}
      </div>
    </Modal>
  );
}

/** @deprecated Use ManagerPortalSettingsModal — kept for imports that open application settings only. */
export function ManagerApplicationSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return <ManagerPortalSettingsModal open={open} onClose={onClose} initialTab="applications" scoped />;
}
