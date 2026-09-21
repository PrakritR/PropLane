"use client";

/**
 * "Messages sent automatically" — one row per state-change message an area
 * sends, with a switch and a Template pen per audience (PLAN-0915).
 *
 * Reminders had Settings rows for years; event messages ("your lease is fully
 * signed") had none. This lists them from `AUTOMATED_MESSAGE_CATALOG`, loads
 * the manager's overrides once, and saves each change through
 * `/api/portal/automated-messages`. The default copy is rendered server-side
 * by the real renderers so what the modal shows is what actually goes out.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  useSettingsPropertyScope,
  type SettingsResolutionSource,
} from "@/components/portal/settings-property-scope";
import {
  automatedMessageCatalogForArea,
  automatedMessageKey,
  normalizeAutomatedMessageSettings,
  type AutomatedMessageAudience,
  type AutomatedMessageCatalogEntry,
  type AutomatedMessageSettings,
} from "@/lib/automated-messages-settings";
import { ReminderMessageUpdateModal } from "@/components/portal/reminder-settings-shared";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";

const AUDIENCE_LABEL: Record<AutomatedMessageAudience, string> = { resident: "Resident", manager: "You", vendor: "Vendor", team: "Team" };

export function AutomatedMessagesList({ area, disabled: disabledProp }: { area: AutomatedMessageCatalogEntry["area"]; disabled?: boolean }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  // Workspace + per-property scope (PLAN-0916-1040 / PLAN-0920-0845 phase D); the
  // no-op account scope outside a provider.
  const {
    propertyId: scopePropertyId,
    propertyIds: scopePropertyIds,
    workspaceId: scopeWorkspaceId,
    reportOverriddenPropertyIds,
    reportSource,
    resetSignal,
  } = useSettingsPropertyScope();
  const scopeKey = `automated-messages:${area}:${useId()}`;
  const entries = useMemo(() => automatedMessageCatalogForArea(area), [area]);
  const [settings, setSettings] = useState<AutomatedMessageSettings | null>(null);
  const [defaults, setDefaults] = useState<Record<string, { subject: string; body: string }>>({});
  const [editing, setEditing] = useState<{ entry: AutomatedMessageCatalogEntry; audience: AutomatedMessageAudience } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setSettings({});
        return;
      }
      try {
        const params = new URLSearchParams();
        if (scopePropertyId) params.set("propertyId", scopePropertyId);
        if (scopeWorkspaceId) params.set("workspaceId", scopeWorkspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/api/portal/automated-messages${query}`, { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as {
          settings?: unknown;
          defaults?: Record<string, { subject: string; body: string }>;
          error?: string;
          overriddenPropertyIds?: string[];
          source?: SettingsResolutionSource;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not load automated messages.");
        if (!cancelled) {
          setSettings(normalizeAutomatedMessageSettings(body.settings));
          setDefaults(body.defaults ?? {});
          reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
          reportSource("automated-messages", body.source);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load automated messages.");
        if (!cancelled) setSettings({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast, scopePropertyId, scopeWorkspaceId, scopeKey, reportOverriddenPropertyIds, reportSource]);

  // Reset the selected house(s)' automated-message override on the scope bar's
  // request. Fire only when the signal advances past the mount value (StrictMode
  // double mount). Loops every selected house.
  const lastResetRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === lastResetRef.current) return;
    lastResetRef.current = resetSignal;
    const targets = scopePropertyIds.length > 0 ? scopePropertyIds : scopePropertyId ? [scopePropertyId] : [];
    if (targets.length === 0 || demo) return;
    let cancelled = false;
    void (async () => {
      try {
        let last: { settings?: unknown; overriddenPropertyIds?: string[] } | null = null;
        for (const target of targets) {
          const res = await fetch("/api/portal/automated-messages", {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ propertyId: target, reset: true }),
          });
          const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string; overriddenPropertyIds?: string[] };
          if (!res.ok) throw new Error(body.error ?? "Could not reset automated messages.");
          last = body;
        }
        if (!cancelled && last) {
          setSettings(normalizeAutomatedMessageSettings(last.settings));
          reportOverriddenPropertyIds(scopeKey, last.overriddenPropertyIds ?? []);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not reset automated messages.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const save = async (patch: AutomatedMessageSettings) => {
    const previous = settings;
    setSettings((current) => ({ ...(current ?? {}), ...patch }));
    if (demo) return;
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/automated-messages", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: patch,
          ...(scopePropertyId ? { propertyId: scopePropertyId } : {}),
          ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
        }),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as {
        settings?: unknown;
        error?: string;
        overriddenPropertyIds?: string[];
        source?: SettingsResolutionSource;
      };
      if (!res.ok) throw new Error(body.error ?? "Could not save automated messages.");
      setSettings(normalizeAutomatedMessageSettings(body.settings));
      reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
      reportSource("automated-messages", body.source);
      reportSaveStatus({ type: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save automated messages.";
      setSettings(previous);
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
    }
  };

  const disabled = disabledProp || settings === null;
  const entryEnabled = (entry: AutomatedMessageCatalogEntry) =>
    entry.audiences.some((audience) => settings?.[automatedMessageKey(entry.domain, entry.event, audience)]?.enabled !== false);
  const setEntryEnabled = (entry: AutomatedMessageCatalogEntry, enabled: boolean) => {
    const patch: AutomatedMessageSettings = {};
    for (const audience of entry.audiences) {
      const key = automatedMessageKey(entry.domain, entry.event, audience);
      patch[key] = { ...(settings?.[key] ?? {}), enabled };
    }
    void save(patch);
  };

  const editingKey = editing ? automatedMessageKey(editing.entry.domain, editing.entry.event, editing.audience) : null;
  const editingCurrent = editingKey ? settings?.[editingKey] : undefined;
  const editingDefault = editingKey ? defaults[editingKey] : undefined;

  return (
    <>
      <PortalSettingsGroup>
        {entries.map((entry) => {
          const enabled = entryEnabled(entry);
          return (
            <PortalSettingsRow key={`${entry.domain}:${entry.event}`} label={entry.label} className="flex-wrap gap-y-2.5">
              <div className="flex flex-wrap items-center justify-end gap-2">
                {enabled
                  ? entry.audiences.map((audience) => (
                      <button
                        key={audience}
                        type="button"
                        className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-primary"
                        disabled={disabled}
                        data-attr={`automated-message-${entry.domain}-${entry.event}-${audience}-template`}
                        onClick={() => setEditing({ entry, audience })}
                      >
                        {AUDIENCE_LABEL[audience]}
                      </button>
                    ))
                  : null}
                <PortalSettingsToggle
                  checked={enabled}
                  onChange={(next) => setEntryEnabled(entry, next)}
                  label={entry.label}
                  disabled={disabled}
                  dataAttr={`automated-message-${entry.domain}-${entry.event}-enabled`}
                />
              </div>
            </PortalSettingsRow>
          );
        })}
      </PortalSettingsGroup>
      {editing && editingKey ? (
        <ReminderMessageUpdateModal
          open
          onClose={() => setEditing(null)}
          subject={editingCurrent?.template?.subject ?? editingDefault?.subject ?? `${editing.entry.label}`}
          body={editingCurrent?.template?.body ?? editingDefault?.body ?? ""}
          recipient={AUDIENCE_LABEL[editing.audience]}
          viaInbox
          viaEmail
          viaSms={false}
          showProplaneChannel={false}
          smsAvailable={false}
          placeholders={`Placeholders: ${editing.entry.placeholders.map((name) => `{${name}}`).join(", ")}`}
          onSave={({ subject, body }) => {
            void save({ [editingKey]: { enabled: editingCurrent?.enabled !== false, template: { subject, body } } });
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}
