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
  LeaseSettingsPanel,
  normalizeApplicationAutomation,
  PaymentsSettingsPanel,
  ResidentSettingsPanel,
} from "@/components/portal/manager-portal-settings-panels";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
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
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: ManagerPortalSettingsTab;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [tab, setTab] = useState<ManagerPortalSettingsTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [waiverCode, setWaiverCode] = useState("");
  const [feeCents, setFeeCents] = useState<number | null>(null);
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const loadApplications = useCallback(async () => {
    if (demo) {
      setWaiverCode("WELCOME50");
      setFeeCents(5000);
      setAutomation(DEFAULT_APPLICATION_AUTOMATION);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/manager-application-settings", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: { applicationFeeCents: number | null };
        automation?: unknown;
        waiverCode?: string | null;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load settings.");
        return;
      }
      setFeeCents(data.settings?.applicationFeeCents ?? null);
      setAutomation(normalizeApplicationAutomation(data.automation));
      setWaiverCode((data.waiverCode ?? "").trim());
    } catch {
      showToast("Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

  useEffect(() => {
    if (!open) return;
    if (tab === "applications" || tab === "lease" || tab === "resident") {
      void loadApplications();
    }
  }, [open, tab, loadApplications]);

  async function saveApplicationBundle(patch: {
    waiverCode?: string;
    automation?: ApplicationAutomationPreferences;
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
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not save settings.");
        return;
      }
      if (patch.automation) setAutomation(patch.automation);
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
      title="Settings"
      dense
      assistantStrip={false}
      panelClassName="max-w-lg p-3 sm:p-4"
    >
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

      {tab === "applications" ? (
        <ApplicationsSettingsPanel
          loading={loading}
          saving={saving}
          waiverCode={waiverCode}
          onWaiverCodeChange={setWaiverCode}
          onSave={() => void saveApplicationBundle({ waiverCode: waiverCode.trim() })}
        />
      ) : null}

      {tab === "calendar" ? <CalendarSettingsPanel /> : null}

      {tab === "lease" ? (
        <LeaseSettingsPanel
          automation={automation}
          loading={loading}
          saving={saving}
          onAutomationChange={setAutomation}
          onSave={() => void saveApplicationBundle({ automation })}
        />
      ) : null}

      {tab === "resident" ? (
        <ResidentSettingsPanel
          automation={automation}
          loading={loading}
          saving={saving}
          onAutomationChange={setAutomation}
          onSave={() => void saveApplicationBundle({ automation })}
        />
      ) : null}

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
  return <ManagerPortalSettingsModal open={open} onClose={onClose} initialTab="applications" />;
}
