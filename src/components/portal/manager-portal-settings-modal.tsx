"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
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
} from "@/components/portal/manager-portal-settings-panels";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
import {
  normalizeTaskAutomation,
  type TaskAutomationPreferences,
} from "@/lib/task-automation-preferences";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { cacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";

export type ManagerPortalSettingsTab =
  | "applications"
  | "calendar"
  | "lease"
  | "resident"
  | "payments"
  | "communication";

const TABS: { id: ManagerPortalSettingsTab; label: string }[] = [
  { id: "applications", label: "Applications" },
  { id: "calendar", label: "Calendar" },
  { id: "lease", label: "Lease" },
  { id: "resident", label: "Residents" },
  { id: "payments", label: "Payments" },
  { id: "communication", label: "Communication" },
];

export function ManagerPortalSettingsModal({
  open,
  onClose,
  initialTab = "applications",
  scoped = true,
  scopedTitle,
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
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [taskAutomation, setTaskAutomation] = useState<TaskAutomationPreferences>(DEFAULT_TASK_AUTOMATION);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const loadApplications = useCallback(async () => {
    if (demo) {
      setWaiverCode("WELCOME50");
      setFeeCents(5000);
      setAutomation(DEFAULT_APPLICATION_AUTOMATION);
      setTaskAutomation(DEFAULT_TASK_AUTOMATION);
      cacheLandlordLegalName(CANONICAL_DEMO_MANAGER_NAME);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/manager-application-settings", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: { applicationFeeCents: number | null };
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
      assistantStrip={false}
      panelClassName="max-w-lg p-3 sm:p-4"
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
          taskAutomation={taskAutomation}
          teamMembers={teamMembers}
          loading={loading}
          saving={saving}
          waiverCode={waiverCode}
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

      {tab === "calendar" ? <CalendarSettingsPanel /> : null}

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

      {tab === "payments" ? <PaymentsSettingsPanel /> : null}

      {tab === "communication" ? <CommunicationSettingsPanel /> : null}
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
