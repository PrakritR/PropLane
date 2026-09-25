"use client";

/**
 * Reminders hub — quiet hours, the per-area reminder matrix, and sent history.
 *
 * This is the Profile → Reminders module (the tab id stays `automation`;
 * the hub query and rail label are `reminders`). Manager
 * alert routing lives on Account → Notifications, not here.
 *
 * Top to bottom:
 * 1. Quiet hours (this panel's own state, from `/api/portal/reminder-settings`).
 * 2. The event matrix, grouped by the same module mapping co-manager
 *    permissions use, with the resident/counterparty + manager-alert kind
 *    pairs merged into one row each.
 * 3. The read-only Sent history log.
 *
 * Timings are a multi-select dropdown rather than a chip grid — the grid grew
 * to nine wrapping pills per row and buried everything under it. Options carry
 * their own direction ("1 day before", "15 minutes after"), so a section is
 * self-describing and needs no explanatory subtitle.
 */
import { useCallback, useEffect, useImperativeHandle, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Button } from "@/components/ui/button";
import { useAutosaveDraft } from "@/hooks/use-autosave-draft";
import {
  useFlushSettingsAutosaveOnUnmount,
  useReportSettingsSaveStatus,
} from "@/components/portal/settings-save-status-context";
import {
  DEFAULT_REMINDER_SETTINGS,
  normalizeReminderSettings,
  type ReminderSettings,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import type { AutomationSendMode } from "@/lib/automation-send-mode";
import { formatMinutes } from "@/lib/reminders/timings";
import { ReminderSentHistory } from "@/components/portal/reminder-sent-history";
import { WhatProplaneSends } from "@/components/portal/what-proplane-sends";
import {
  PortalSettingsGroup,
  PortalSettingsLinkRow,
  PortalSettingsRow,
  PortalSettingsScopeTag,
  PortalSettingsSection,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import type { CoManagerPermissionId } from "@/lib/co-manager-permissions";
import {
  useSettingsPropertyScope,
  type SettingsResolutionSource,
} from "@/components/portal/settings-property-scope";
import { managerSettingsProfilePath } from "@/lib/portal-settings-section";
import { scopeTagLabel } from "@/components/portal/settings-scope-bar";
import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";

/** 00:00 … 23:00 — the quiet-hours pickers, Pacific wall time. */
const QUIET_HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));


/**
 * Client-safe mirror of `REMINDER_SUBJECT_CO_MANAGER_MODULE`
 * (`src/lib/co-manager-notification-recipients.server.ts`). That file is
 * `server-only` (it queries the database for co-manager recipients), so this
 * browser-rendered hub cannot import it directly — this is the same mapping,
 * copied as pure data. Keep the two byte-identical; the server file remains
 * the single source of truth for "which module does this reminder belong to".
 */
// Exported so the parity test can read it; the hub itself no longer draws
// per-module groups (PLAN-0915), but the mapping stays the browser-safe mirror
// other client code may import.
export const REMINDER_KIND_MODULE: Record<ReminderSubjectKind, CoManagerPermissionId> = {
  tour: "calendar",
  tour_interest: "inbox",
  task: "calendar",
  service_order: "services",
  work_order: "services",
  application: "applications",
  application_manager: "applications",
  application_post_tour: "applications",
  lease: "leases",
  lease_manager: "leases",
  payment_manager: "payments",
  outgoing_payment: "financials",
  booking: "calendar",
  inspection: "residents",
  inspection_manager: "residents",
  // ---- PLAN-0915 kinds. Keep byte-identical with REMINDER_KIND_MODULE in
  // pro-portal-automation-settings-panel.tsx (tests/unit/reminder-module-mapping-parity). ----
  work_order_unassigned: "services",
  work_order_unassigned_emergency: "services",
  work_order_no_on_my_way: "services",
  vendor_offer_expiry: "services",
  vendor_invoice_nudge: "services",
  invoice_approval: "financials",
  service_request_decision: "services",
  service_request_unpaid: "services",
  vendor_document_expiry: "services",
  lease_ending: "leases",
  lease_ending_manager: "leases",
  renewal_offer_expiry: "leases",
  countersign_overdue: "leases",
  move_in: "leases",
  move_in_payment_method: "payments",
  move_out: "leases",
  move_out_inspection_manager: "residents",
  deposit_accounting: "payments",
  lease_renewal_offer: "leases",
  move_out_instructions: "leases",
  deposit_return_notice: "payments",
  application_documents: "applications",
  application_decision_manager: "applications",
  application_no_lease_manager: "applications",
  cosigner: "applications",
  group_application: "applications",
  tour_request_unanswered: "calendar",
  tour_request_reoffer: "calendar",
  tour_no_show_manager: "calendar",
  tour_feedback: "calendar",
  delinquency_manager: "payments",
  message_unanswered: "inbox",
  document_signature: "documents",
  task_overdue: "calendar",
  resident_welcome: "residents",
  inspection_acknowledge: "residents",
};


/**
 * The hub is globals only (PLAN-0915): every automated message is configured
 * in the tab that owns its area, and this index is how a manager gets there.
 */
const AREA_INDEX: { tab: ManagerPortalSettingsTab; label: string }[] = [
  { tab: "applications", label: "Applications" },
  { tab: "tours", label: "Tours" },
  { tab: "lease", label: "Lease, move-in & move-out" },
  { tab: "tasks", label: "Tasks" },
  { tab: "resident", label: "Residents" },
  { tab: "payments", label: "Payments" },
  { tab: "services", label: "Services & vendors" },
  { tab: "communication", label: "Communication" },
  { tab: "bookings", label: "Bookings" },
  { tab: "inspections", label: "Inspections" },
];

export function ManagerPortalAutomationSettingsPanel({
  formRef,
}: {
  formRef?: React.Ref<{ saveIfDirty: () => Promise<boolean> }>;
} = {}) {
  const reportSaveStatus = useReportSettingsSaveStatus();
  const {
    propertyId: scopePropertyId,
    propertyIds: scopePropertyIds,
    workspaceId: scopeWorkspaceId,
    reportSource,
  } = useSettingsPropertyScope();
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_REMINDER_SETTINGS);
  const [source, setSource] = useState<SettingsResolutionSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      try {
        const params = new URLSearchParams();
        if (scopePropertyId) params.set("propertyId", scopePropertyId);
        if (scopeWorkspaceId) params.set("workspaceId", scopeWorkspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/api/portal/reminder-settings${query}`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string; source?: SettingsResolutionSource };
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(body.error ?? "Could not load settings.");
          return;
        }
        setSettings(normalizeReminderSettings(body.settings));
        setSource(body.source ?? null);
        reportSource("reminder-settings", body.source);
        setHydrated(true);
      } catch {
        if (!cancelled) setLoadError("Could not load settings.");
      } finally {
        clearTimeout(timer);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, scopePropertyId, scopeWorkspaceId]);

  const persist = useCallback(async (draft: ReminderSettings) => {
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/reminder-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: draft,
          ...(scopePropertyId ? { propertyId: scopePropertyId } : {}),
          ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string; source?: SettingsResolutionSource };
      if (!res.ok) {
        const reason = body.error ?? "Could not save.";
        reportSaveStatus({ type: "failure", reason });
        return { ok: false as const, error: reason };
      }
      setSource(body.source ?? null);
      reportSource("reminder-settings", body.source);
      reportSaveStatus({ type: "success" });
    } catch {
      const reason = "Could not save.";
      reportSaveStatus({ type: "failure", reason });
      return { ok: false as const, error: reason };
    }
  }, [reportSaveStatus, scopePropertyId, scopeWorkspaceId, reportSource]);

  const autosave = useAutosaveDraft({
    draft: settings,
    enabled: hydrated && !loading && !loadError,
    save: persist,
  });

  const flushSave = useCallback(async () => {
    await autosave.flush();
    return autosave.state !== "error";
  }, [autosave]);

  useImperativeHandle(formRef, () => ({ saveIfDirty: flushSave }), [flushSave]);
  useFlushSettingsAutosaveOnUnmount(flushSave, autosave.dirty);

  if (loading) return <p className="py-6 text-sm text-muted">Loading…</p>;

  if (loadError) {
    return (
      <div className="py-6">
        <p className="text-sm text-muted">{loadError}</p>
        <Button
          variant="outline"
          className="mt-3"
          data-attr="automation-settings-retry"
          onClick={() => {
            setLoadError(null);
            setLoading(true);
            setHydrated(false);
            setReloadKey((k) => k + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
        {settings.messagesPaused ? (
          <div
            className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
            data-attr="settings-banner-messages-paused"
          >
            All automated messages are paused for this workspace. Reminders and automatic notices are queued, not sent, until you turn this back on.
          </div>
        ) : null}

        <PortalSettingsSection
          title="Pause all messages"
          action={source ? <PortalSettingsScopeTag variant="muted">{scopeTagLabel(source, scopePropertyIds.length)}</PortalSettingsScopeTag> : null}
        >
          <PortalSettingsGroup>
            <PortalSettingsRow label="Pause every automated message for this workspace">
              <PortalSettingsToggle
                checked={settings.messagesPaused}
                onChange={(messagesPaused) => setSettings((c) => ({ ...c, messagesPaused }))}
                label="Pause all messages"
                dataAttr="settings-toggle-messages-paused"
              />
            </PortalSettingsRow>
          </PortalSettingsGroup>
        </PortalSettingsSection>

        <PortalSettingsSection
          title="Quiet hours"
          action={source ? <PortalSettingsScopeTag variant="muted">{scopeTagLabel(source, scopePropertyIds.length)}</PortalSettingsScopeTag> : null}
        >
          <PortalSettingsGroup>
            <PortalSettingsRow
              label="Delay overnight reminders"
            >
              <PortalSettingsToggle
                checked={settings.quietHours.enabled}
                onChange={(enabled) =>
                  setSettings((c) => ({ ...c, quietHours: { ...c.quietHours, enabled } }))
                }
                label="Quiet hours"
                dataAttr="settings-toggle-quiet-hours"
              />
            </PortalSettingsRow>
            {settings.quietHours.enabled ? (
              <div
                className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted"
                data-attr="settings-row-quiet-hours-range"
              >
                <label className="flex items-center gap-2">
                  From
                  <FieldSingleSelect
                    variant="cell"
                    hideLabel
                    label="Quiet hours start"
                    value={String(settings.quietHours.startHour)}
                    onChange={(next) =>
                      setSettings((c) => ({
                        ...c,
                        quietHours: { ...c.quietHours, startHour: Number(next) },
                      }))
                    }
                    options={QUIET_HOUR_OPTIONS}
                    wrapperClassName="w-24"
                  />
                </label>
                <label className="flex items-center gap-2">
                  until
                  <FieldSingleSelect
                    variant="cell"
                    hideLabel
                    label="Quiet hours end"
                    value={String(settings.quietHours.endHour)}
                    onChange={(next) =>
                      setSettings((c) => ({
                        ...c,
                        quietHours: { ...c.quietHours, endHour: Number(next) },
                      }))
                    }
                    options={QUIET_HOUR_OPTIONS}
                    wrapperClassName="w-24"
                  />
                </label>
                <span className="text-muted">({formatMinutes(60)} blocks, Pacific time)</span>
              </div>
            ) : null}
          </PortalSettingsGroup>
        </PortalSettingsSection>

        <PortalSettingsSection
          title="Team & automated sends"
          action={source ? <PortalSettingsScopeTag variant="muted">{scopeTagLabel(source, scopePropertyIds.length)}</PortalSettingsScopeTag> : null}
        >
          <PortalSettingsGroup>
            <PortalSettingsRow label="Team notices send automatically">
              <PortalSettingsToggle
                checked={settings.automationSendMode.team === "auto"}
                onChange={(checked) =>
                  setSettings((c) => ({
                    ...c,
                    automationSendMode: {
                      ...c.automationSendMode,
                      team: (checked ? "auto" : "draft") satisfies AutomationSendMode,
                    },
                  }))
                }
                label="Team notices auto-send"
                dataAttr="settings-toggle-team-auto-send"
              />
            </PortalSettingsRow>
            <PortalSettingsRow label="Resident & vendor messages need my approval first">
              <PortalSettingsToggle
                checked={settings.automationSendMode.partyFacing === "draft"}
                onChange={(checked) =>
                  setSettings((c) => ({
                    ...c,
                    automationSendMode: {
                      ...c.automationSendMode,
                      partyFacing: (checked ? "draft" : "auto") satisfies AutomationSendMode,
                    },
                  }))
                }
                label="Resident and vendor messages draft for review"
                dataAttr="settings-toggle-party-facing-draft"
              />
            </PortalSettingsRow>
          </PortalSettingsGroup>
        </PortalSettingsSection>

        <WhatProplaneSends />

        <PortalSettingsSection title="Change a rule or a template">
          <PortalSettingsGroup>
            {AREA_INDEX.map((area) => (
              <PortalSettingsLinkRow
                key={area.tab}
                label={area.label}
                href={managerSettingsProfilePath(area.tab)}
                dataAttr={`automation-index-${area.tab}`}
              />
            ))}
          </PortalSettingsGroup>
        </PortalSettingsSection>

        <PortalSettingsSection title="Sent history">
          <ReminderSentHistory />
        </PortalSettingsSection>
      </div>
    </div>
  );
}
