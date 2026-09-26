"use client";

/**
 * Reminders hub — quiet hours, EVERY area's reminder rules and automated
 * messages (C111), and sent history.
 *
 * This is the Profile → Reminders module (the tab id stays `automation`;
 * the hub query and rail label are `reminders`). Manager
 * alert routing lives on Account → Notifications, not here.
 *
 * Top to bottom:
 * 1. Quiet hours (this panel's own state, from `/api/portal/reminder-settings`).
 * 2. Team & automated sends (send-mode globals).
 * 3. `WhatProplaneSends` — the read-only list of shipped-default messages
 *    that have no per-workspace rule at all (e.g. tour reminders, C191).
 * 4. "Rules & messages" — every reminder rule and automated-message toggle
 *    that used to live on an area's own Settings tab (Applications, Lease,
 *    Tasks, Residents, Payments, Services, Communication), PLUS Bookings and
 *    Inspections, whose settings tabs held only this content and are gone
 *    (C116: captain decision, drop rather than keep an empty tab). One area
 *    filter (a dropdown, never pills) narrows the list; "All" is the
 *    default. Every control here is the SAME self-contained component the
 *    old area tab rendered — same fetch, same save, same normalizer — only
 *    its location moved, so nothing that was editable before stopped being
 *    editable.
 * 5. The read-only Sent history log.
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
import { SettingsGroupSourceTag, scopeTagLabel } from "@/components/portal/settings-scope-bar";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  normalizeManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { loadManagerAutomationSettingsCached } from "@/lib/manager-automation-settings-client";
import { AutomationRuleRows } from "@/components/portal/automation-rule-rows";
import { AutomatedMessagesList } from "@/components/portal/automated-messages-list";
import { LeaseAutomationSettingsRows } from "@/components/portal/lease-automation-settings-rows";
import {
  ServiceRequestAutomationRows,
  ServiceVendorAutomationRows,
} from "@/components/portal/service-automation-settings-section";
import {
  ManagerReminderRuleSettingsPanel,
  type ManagerReminderRuleSettingsHandle,
} from "@/components/portal/manager-reminder-rule-settings";
import type { PaymentAutomationSettingsHandle } from "@/components/portal/payment-schedule-ui";
import {
  ApplicationRemindersSettingsBundle,
  IncomingPaymentRemindersSettingsBundle,
  LeaseRemindersSettingsBundle,
  OutgoingPaymentRemindersSettingsBundle,
  InspectionRemindersSettingsBundle,
  ServiceRemindersSettingsBundle,
} from "@/components/portal/reminder-settings-bundles";
import {
  AutoMessageAssigneeRow,
  ManagerAutomationSelectRow,
} from "@/components/portal/pro-portal-settings-panels";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";

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
 * C111: every area's reminder rules and automated messages now render HERE,
 * grouped by area, instead of on that area's own Settings tab. "All" (the
 * default) shows every group; picking one area narrows to just its group.
 * Bookings and Inspections are areas here even though their settings TABS
 * are gone (C116) — their reminder content still needs a home.
 */
const REMINDER_AREA_OPTIONS: { value: ReminderAreaFilter; label: string }[] = [
  { value: "all", label: "All areas" },
  { value: "applications", label: "Applications" },
  { value: "lease", label: "Lease, move-in & move-out" },
  { value: "tasks", label: "Tasks" },
  { value: "resident", label: "Residents" },
  { value: "payments", label: "Payments" },
  { value: "services", label: "Services & vendors" },
  { value: "communication", label: "Communication" },
  { value: "bookings", label: "Bookings" },
  { value: "inspections", label: "Inspections" },
];

type ReminderAreaFilter =
  | "all"
  | "applications"
  | "lease"
  | "tasks"
  | "resident"
  | "payments"
  | "services"
  | "communication"
  | "bookings"
  | "inspections";

/**
 * "Auto-send AI drafts" moved off Settings → Communication (C111) — one
 * self-contained field, same shape as `AutoMessageAssigneeRow`, so the inbox
 * AI-draft toggle keeps exactly one writer (`/api/portal/automation-settings`).
 */
export function AutoSendAiDraftsRow() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const { userId } = usePortalSession();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [value, setValue] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS.inboxAiDraftAutoSend);
        return;
      }
      if (!userId) return;
      try {
        const loaded = await loadManagerAutomationSettingsCached(userId);
        if (!cancelled) setValue(normalizeManagerAutomationSettings(loaded.settings).inboxAiDraftAutoSend);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load communication settings.");
        if (!cancelled) setValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS.inboxAiDraftAutoSend);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast, userId]);

  const flip = async (next: boolean) => {
    const previous = value;
    setValue(next);
    if (demo) return;
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inboxAiDraftAutoSend: next }),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save communication settings.");
      setValue(normalizeManagerAutomationSettings(body.settings).inboxAiDraftAutoSend);
      reportSaveStatus({ type: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save communication settings.";
      setValue(previous);
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
    }
  };

  return (
    <PortalSettingsGroup>
      <PortalSettingsRow label="Auto-send AI drafts">
        <PortalSettingsToggle
          checked={value === true}
          onChange={(next) => void flip(next)}
          label="Auto-send AI drafts"
          disabled={value === null}
          dataAttr="communication-inbox-ai-draft-auto-send"
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}

export function ManagerPortalAutomationSettingsPanel({
  formRef,
  teamMembers = [],
  applicationsReminderFormRef,
  leaseReminderFormRef,
  taskReminderFormRef,
  incomingPaymentReminderFormRef,
  outgoingPaymentReminderFormRef,
  workOrderReminderFormRef,
  serviceOrderReminderFormRef,
  inspectionDueReminderFormRef,
  inspectionReviewReminderFormRef,
  bookingReminderFormRef,
}: {
  formRef?: React.Ref<{ saveIfDirty: () => Promise<boolean> }>;
  teamMembers?: WorkAssignmentTeamMember[];
  applicationsReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  leaseReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  taskReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  incomingPaymentReminderFormRef?: React.Ref<PaymentAutomationSettingsHandle>;
  outgoingPaymentReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  workOrderReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  serviceOrderReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  inspectionDueReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  inspectionReviewReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  bookingReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
} = {}) {
  const [areaFilter, setAreaFilter] = useState<ReminderAreaFilter>("all");
  const showArea = (area: ReminderAreaFilter) => areaFilter === "all" || areaFilter === area;
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

        <div className="flex items-center justify-between gap-3">
          <p className="text-[15px] font-bold tracking-[-0.01em] text-foreground">Rules & messages</p>
          <FieldSingleSelect
            label="Area"
            hideLabel
            variant="cell"
            wrapperClassName="w-48"
            value={areaFilter}
            options={REMINDER_AREA_OPTIONS}
            onChange={(next) => setAreaFilter(next as ReminderAreaFilter)}
            dataAttr="reminders-area-filter"
          />
        </div>

        {showArea("applications") ? (
          <PortalSettingsSection title="Applications" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <ManagerAutomationSelectRow
              label="Response promise"
              field="applicationResponsePromiseDays"
              options={[
                { value: "3", label: "Answer within 3 days" },
                { value: "1", label: "Answer within 1 day" },
                { value: "2", label: "Answer within 2 days" },
                { value: "5", label: "Answer within 5 days" },
                { value: "0", label: "No promise" },
              ]}
              parse={(value) => Number(value) as 0 | 1 | 2 | 3 | 5}
              dataAttr="applications-response-promise"
            />
            <AutomationRuleRows
              rows={[{ kind: "application_decision_manager" }, { kind: "application_no_lease_manager" }]}
            />
            <ApplicationRemindersSettingsBundle teamMembers={teamMembers} formRef={applicationsReminderFormRef} />
            <AutomatedMessagesList area="applications" />
          </PortalSettingsSection>
        ) : null}

        {showArea("lease") ? (
          <PortalSettingsSection title="Lease, move-in & move-out" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <AutomationRuleRows
              rows={[
                { kind: "lease_ending_manager", multi: true },
                { kind: "lease_ending", multi: true },
                { kind: "renewal_offer_expiry" },
                { kind: "countersign_overdue" },
              ]}
            />
            <AutomationRuleRows rows={[{ kind: "move_in", multi: true }, { kind: "move_in_payment_method" }]} />
            <AutomationRuleRows
              rows={[
                { kind: "move_out", multi: true },
                { kind: "move_out_inspection_manager" },
                { kind: "deposit_accounting", multi: true },
              ]}
            />
            <LeaseAutomationSettingsRows />
            <LeaseRemindersSettingsBundle teamMembers={teamMembers} formRef={leaseReminderFormRef} />
            <AutomationRuleRows rows={[{ kind: "document_signature" }]} />
            <AutomatedMessagesList area="lease" />
          </PortalSettingsSection>
        ) : null}

        {showArea("tasks") ? (
          <PortalSettingsSection title="Tasks" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <ManagerReminderRuleSettingsPanel
              kind="task"
              audienceMode="manager"
              teamMembers={teamMembers}
              formRef={taskReminderFormRef}
            />
            <AutomationRuleRows rows={[{ kind: "task_overdue" }]} />
          </PortalSettingsSection>
        ) : null}

        {showArea("resident") ? (
          <PortalSettingsSection title="Residents" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <AutomationRuleRows rows={[{ kind: "resident_welcome", multi: true }]} />
          </PortalSettingsSection>
        ) : null}

        {showArea("payments") ? (
          <PortalSettingsSection title="Payments" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <IncomingPaymentRemindersSettingsBundle teamMembers={teamMembers} formRef={incomingPaymentReminderFormRef} />
            <AutomationRuleRows rows={[{ kind: "delinquency_manager" }]} />
            <AutomatedMessagesList area="payments" />
            <OutgoingPaymentRemindersSettingsBundle teamMembers={teamMembers} formRef={outgoingPaymentReminderFormRef} />
          </PortalSettingsSection>
        ) : null}

        {showArea("services") ? (
          <PortalSettingsSection title="Services & vendors" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <AutoMessageAssigneeRow />
            <ServiceRemindersSettingsBundle
              teamMembers={teamMembers}
              workOrderFormRef={workOrderReminderFormRef}
              serviceOrderFormRef={serviceOrderReminderFormRef}
            />
            <ServiceRequestAutomationRows />
            <AutomationRuleRows
              rows={[
                { kind: "work_order_unassigned" },
                { kind: "work_order_unassigned_emergency" },
                { kind: "service_request_decision" },
                { kind: "service_request_unpaid" },
              ]}
            />
            <ServiceVendorAutomationRows />
            <AutomationRuleRows
              rows={[
                { kind: "vendor_offer_expiry" },
                { kind: "work_order_no_on_my_way" },
                { kind: "vendor_invoice_nudge" },
                { kind: "invoice_approval" },
                { kind: "vendor_document_expiry", label: "Warn before vendor documents expire" },
              ]}
            />
            <AutomatedMessagesList area="services" />
          </PortalSettingsSection>
        ) : null}

        {showArea("communication") ? (
          <PortalSettingsSection title="Communication" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <AutoSendAiDraftsRow />
            <AutomationRuleRows rows={[{ kind: "message_unanswered" }]} />
            <AutomatedMessagesList area="communication" />
          </PortalSettingsSection>
        ) : null}

        {showArea("bookings") ? (
          <PortalSettingsSection title="Bookings" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <ManagerReminderRuleSettingsPanel
              kind="booking"
              audienceMode="manager"
              teamMembers={teamMembers}
              formRef={bookingReminderFormRef}
            />
          </PortalSettingsSection>
        ) : null}

        {showArea("inspections") ? (
          <PortalSettingsSection title="Inspections" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
            <InspectionRemindersSettingsBundle
              teamMembers={teamMembers}
              dueFormRef={inspectionDueReminderFormRef}
              reviewFormRef={inspectionReviewReminderFormRef}
            />
            <AutomatedMessagesList area="inspections" />
          </PortalSettingsSection>
        ) : null}

        <PortalSettingsSection title="Sent history">
          <ReminderSentHistory />
        </PortalSettingsSection>
      </div>
    </div>
  );
}
