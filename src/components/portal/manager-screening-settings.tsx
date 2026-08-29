"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { parseManagerScreeningSettings } from "@/lib/screening/settings";
import type { ManagerScreeningSettings, ScreeningMode } from "@/lib/screening/types";

const DEMO_SCREENING_SETTINGS_KEY = "axis-demo-screening-settings";
const DEFAULT_SCREENING_SETTINGS: ManagerScreeningSettings = { mode: "manual" };

function readDemoScreeningSettings(): ManagerScreeningSettings {
  if (typeof window === "undefined") return DEFAULT_SCREENING_SETTINGS;
  try {
    const raw = sessionStorage.getItem(DEMO_SCREENING_SETTINGS_KEY);
    if (raw) return parseManagerScreeningSettings(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return DEFAULT_SCREENING_SETTINGS;
}

function writeDemoScreeningSettings(settings: ManagerScreeningSettings) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(DEMO_SCREENING_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

const MODE_OPTIONS: { value: ScreeningMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "manual", label: "Manual per applicant" },
  { value: "auto_on_submit", label: "Auto on submit" },
];

function screeningModeLabel(mode: ScreeningMode): string {
  return MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

function ManagerScreeningSettingsForm({
  settings,
  onSettingsChange,
}: {
  settings: ManagerScreeningSettings;
  onSettingsChange: (next: ManagerScreeningSettings) => void;
}) {
  const { showToast } = useAppUi();
  const [busy, setBusy] = useState(false);

  const saveMode = async (mode: ScreeningMode) => {
    setBusy(true);
    try {
      if (isDemoModeActive()) {
        const next = { mode };
        writeDemoScreeningSettings(next);
        onSettingsChange(next);
        showToast("Screening settings saved (demo).");
        return;
      }
      const res = await fetch("/api/screening/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode }),
      });
      const body = (await res.json()) as { error?: string; settings?: ManagerScreeningSettings };
      if (!res.ok) {
        const message = body.error ?? "Could not save screening settings.";
        showToast(
          message.includes("screening_settings")
            ? "Could not save. Run the screening database migration (screening_settings on profiles)."
            : message,
        );
        return;
      }
      if (body.settings) onSettingsChange(body.settings);
      showToast("Screening settings saved.");
    } catch {
      showToast("Network error saving screening settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Choose when background checks run for new applications.</p>
      <NativeSelect
        value={settings.mode}
        disabled={busy}
        onChange={(event) => void saveMode(event.target.value as ScreeningMode)}
        aria-label="Screening mode"
        className="w-full"
      >
        {MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export function ManagerScreeningSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<ManagerScreeningSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setSettings(null);
        setLoadError(null);
      });
      return;
    }

    if (isDemoModeActive()) {
      queueMicrotask(() => {
        setSettings(readDemoScreeningSettings());
        setLoadError(null);
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/screening/settings", { credentials: "include" });
        const body = (await res.json()) as { settings?: ManagerScreeningSettings; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          const message = body.error ?? "Could not load screening settings.";
          setLoadError(
            message.includes("screening_settings")
              ? "Screening is not configured yet. Run the screening database migration on profiles."
              : message,
          );
          setSettings(DEFAULT_SCREENING_SETTINGS);
          return;
        }
        setSettings(body.settings ?? DEFAULT_SCREENING_SETTINGS);
        setLoadError(null);
      } catch {
        if (!cancelled) {
          setLoadError("Network error loading screening settings.");
          setSettings(DEFAULT_SCREENING_SETTINGS);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Applicant screening" dense assistantContext="Applicant screening">
      {settings ? (
        <>
          {loadError ? <p className="mb-3 text-sm text-[var(--status-overdue-fg)]">{loadError}</p> : null}
          <ManagerScreeningSettingsForm settings={settings} onSettingsChange={setSettings} />
        </>
      ) : (
        <p className="text-sm text-muted">Loading screening settings…</p>
      )}
    </Modal>
  );
}

/** Compact toolbar trigger — opens screening modal. */
export function ManagerScreeningSettingsButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  const [mode, setMode] = useState<ScreeningMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (isDemoModeActive()) {
      queueMicrotask(() => {
        if (!cancelled) setMode(readDemoScreeningSettings().mode);
      });
      return () => {
        cancelled = true;
      };
    }
    void fetch("/api/screening/settings", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { settings?: ManagerScreeningSettings };
        if (body.settings) setMode(body.settings.mode);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const shortLabel = "Screening";

  return (
    <Button
      type="button"
      variant="outline"
      className={className ? `${PORTAL_HEADER_ACTION_BTN} ${className}` : PORTAL_HEADER_ACTION_BTN}
      onClick={onClick}
    >
      {shortLabel}
    </Button>
  );
}

/** @deprecated Use ManagerScreeningSettingsButton + ManagerScreeningSettingsModal */
export function ManagerScreeningSettingsPanel() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ManagerScreeningSettingsButton onClick={() => setOpen(true)} />
      <ManagerScreeningSettingsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export { screeningModeLabel };
