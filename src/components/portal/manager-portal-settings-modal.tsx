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
  scoped = false,
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: ManagerPortalSettingsTab;
  /**
   * Show ONLY `initialTab`'s settings, titled for that section.
   *
   * Settings opened from a section's own header should be that section's settings. Offering all
   * six tabs there makes the manager re-find the one they were already standing in, and invites
   * them to change Payments from inside Applications. The full switcher stays available from a
   * global entry point, which is why this is opt-in rather than the default.
   */
  scoped?: boolean;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [tab, setTab] = useState<ManagerPortalSettingsTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [waiverCode, setWaiverCode] = useState("");
  const [feeCents, setFeeCents] = useState<number | null>(null);
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [landlordLegalName, setLandlordLegalName] = useState("");

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const loadApplications = useCallback(async () => {
    if (demo) {
      setWaiverCode("WELCOME50");
      setFeeCents(5000);
      setAutomation(DEFAULT_APPLICATION_AUTOMATION);
      setLandlordLegalName(CANONICAL_DEMO_MANAGER_NAME);
      cacheLandlordLegalName(CANONICAL_DEMO_MANAGER_NAME);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/manager-application-settings", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: { applicationFeeCents: number | null };
        automation?: unknown;
        landlord?: { landlordLegalName?: string } | null;
        waiverCode?: string | null;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load settings.");
        return;
      }
      setFeeCents(data.settings?.applicationFeeCents ?? null);
      setAutomation(normalizeApplicationAutomation(data.automation));
      const savedLandlord = (data.landlord?.landlordLegalName ?? "").trim();
      setLandlordLegalName(savedLandlord);
      // Keep the generator's cache in step with the server on every load, so a manager who set the
      // name on another device still generates a correctly-named lease here.
      cacheLandlordLegalName(savedLandlord);
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
    landlordLegalName?: string;
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
          landlordLegalName: patch.landlordLegalName ?? landlordLegalName.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        landlord?: { landlordLegalName?: string } | null;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not save settings.");
        return;
      }
      if (patch.automation) setAutomation(patch.automation);
      // Cache only what the server ACCEPTED — it normalizes, and the generator must not print a
      // name the server rejected or rewrote.
      const acceptedLandlord = (data.landlord?.landlordLegalName ?? landlordLegalName).trim();
      setLandlordLegalName(acceptedLandlord);
      cacheLandlordLegalName(acceptedLandlord);
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
      title={scoped ? `${TABS.find((item) => item.id === tab)?.label ?? "Settings"} settings` : "Settings"}
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
          landlordLegalName={landlordLegalName}
          loading={loading}
          saving={saving}
          onAutomationChange={setAutomation}
          onLandlordLegalNameChange={setLandlordLegalName}
          onSave={() => void saveApplicationBundle({ automation, landlordLegalName: landlordLegalName.trim() })}
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
