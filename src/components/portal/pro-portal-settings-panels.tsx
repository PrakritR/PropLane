"use client";
import { TourInterestSettings } from "./tour-interest-settings";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Copy, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect, CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  allWorkspacePropertyOptions,
  propertyOptionsFromWorkspacePayload,
  unionLabeledPropertyOptions,
} from "@/lib/workspaces/selection";
import {
  PortalSettingsGroup,
  PortalSettingsLinkRow,
  PortalSettingsRow,
  PortalSettingsScopeTag,
  PortalSettingsSection,
  PortalSettingsSections,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import { useRouter } from "next/navigation";
import { propertyDetailHref } from "@/lib/portal-detail-routes";
import {
  useSettingsPropertyScope,
  type SettingsResolutionSource,
} from "@/components/portal/settings-property-scope";
import { SettingsGroupSourceTag, scopeTagLabel } from "@/components/portal/settings-scope-bar";
import { AutomationRuleRows } from "@/components/portal/automation-rule-rows";
import { LeaseAutomationSettingsRows } from "@/components/portal/lease-automation-settings-rows";
import { AutomatedMessagesList } from "@/components/portal/automated-messages-list";
import { ServiceRequestAutomationRows, ServiceVendorAutomationRows } from "@/components/portal/service-automation-settings-section";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
  cacheShowUpcomingChargesSetting,
  normalizeManagerAutomationSettings,
  normalizeTourReminderMinutesBeforeList,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import {
  MANAGER_COMMUNICATION_SEND_VIA_SECTIONS,
  deliverViaFromManagerSettings,
} from "@/lib/manager-communication-deliver-via";
import { ManagerSmsWorkNumberHint } from "@/components/portal/pro-sms-work-number-hint";
import { isManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import { workEmailAudienceLabel } from "@/components/portal/pro-assistant-email-settings-panel";
import { normalizeE164 } from "@/lib/phone-e164";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";
import {
  PAYMENT_REMINDER_PRESETS,
  applyReminderPreset,
  detectReminderPreset,
  type ReminderPresetId,
} from "@/lib/payment-reminder-presets";
import { DEFAULT_MANAGER_TOUR_SETTINGS, type ManagerTourSettings } from "@/lib/manager-tour-settings";
import { tourNoticeDaysLabel } from "@/lib/tour-notice-labels";
import { normalizeTourNoticeDays } from "@/lib/tour-slot-math";
import { fillTourReminderTemplate } from "@/lib/tour-reminder";

import {
  ReminderMessagePreviewCard,
  ReminderMessageUpdateModal,
  ReminderSendViaField,
  TourReminderTimingSelect,
} from "@/components/portal/reminder-settings-shared";
import {
  PaymentAutomationSettingsPanel,
  type PaymentAutomationSettingsHandle,
} from "@/components/portal/payment-schedule-ui";
import {
  ManagerReminderRuleSettingsPanel,
  type ManagerReminderRuleSettingsHandle,
} from "@/components/portal/manager-reminder-rule-settings";
import {
  ApplicationRemindersSettingsBundle,
  IncomingPaymentRemindersSettingsBundle,
  LeaseRemindersSettingsBundle,
  OutgoingPaymentRemindersSettingsBundle,
  InspectionRemindersSettingsBundle,
  ServiceRemindersSettingsBundle,
} from "@/components/portal/reminder-settings-bundles";
import {
  PaymentListingLateFeeSettings,
  type PaymentListingLateFeeHandle,
} from "@/components/portal/payment-late-fee-settings";
import { ManagerPaymentSetupPanel } from "@/components/portal/pro-payment-setup-modal";
import { ReminderTypePicker } from "@/components/portal/reminder-type-picker";
import { TaskAutomationSettingsFields } from "@/components/portal/task-automation-settings-fields";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import {
  DEFAULT_LIFECYCLE_AUTOMATION,
  type LifecycleTaskAutomation,
} from "@/lib/task-lifecycle-automation";
import {
  useFlushSettingsAutosaveOnUnmount,
  useReportSettingsSaveStatus,
} from "@/components/portal/settings-save-status-context";

const TOUR_PREVIEW_CONTEXT = {
  guestName: "Alex Prospect",
  propertyTitle: "5257 Brooklyn Avenue Northeast",
  tourTime: "Aug 15, 2026 at 10:00 AM",
  managerName: "Your team",
  instructions: "Meet at the front door. Text when you arrive.",
};

const TOUR_PLACEHOLDERS =
  "Placeholders: {guestName}, {propertyTitle}, {tourTime}, {managerName}, {instructions}";

function SettingsFormJumpRow({
  detailTab,
  propertyId,
  propertyOptions,
}: {
  detailTab: "application" | "lease";
  propertyId?: string;
  propertyOptions: { id: string; label: string }[];
}) {
  const router = useRouter();
  const scope = useSettingsPropertyScope();
  const houseId = (scope.propertyId || propertyId || propertyOptions[0]?.id || "").trim();
  if (!houseId) return null;
  return (
    <PortalSettingsGroup>
      <PortalSettingsLinkRow
        label="Form"
        dataAttr={`settings-${detailTab}-form`}
        onClick={() => router.push(propertyDetailHref("/portal", "all", houseId, detailTab))}
      />
    </PortalSettingsGroup>
  );
}

function tourAutomationSnapshot(settings: ManagerAutomationSettings) {
  const minutesBeforeList = normalizeTourReminderMinutesBeforeList(
    settings.tourReminderMinutesBeforeList,
    settings.tourReminderMinutesBefore,
  );
  return {
    proposeTourConfirmations: settings.proposeTourConfirmations,
    tourReminderMinutesBeforeList: minutesBeforeList,
    tourReminderDeliverViaEmail: settings.tourReminderDeliverViaEmail,
    tourReminderDeliverViaSms: settings.tourReminderDeliverViaSms,
    tourReminderDeliverViaInbox: settings.tourReminderDeliverViaInbox,
    tourReminder: settings.templates.tourReminder,
  };
}

export type TourSettingsHandle = {
  saveIfDirty: () => Promise<boolean>;
};

/**
 * Same shape as `TourSettingsHandle`, for the two panels whose own per-control autosave used to
 * be invisible to `SettingsModulePage.flushPendingSaves()` entirely — `TaskSettingsPanel` and
 * `CommunicationSettingsPanel` never registered a handle, so the explicit flush the standalone
 * page's `goToArea` and the modal's `selectTab`/`closeAndSave` already run BEFORE switching
 * modules or closing found nothing to flush for either one. A real module switch on the
 * standalone page is a full page navigation (`window.location.assign`), which does not reliably
 * let an unmount-time fetch finish — the registry has to actually know about the pending write
 * so the AWAITED flush covers it before that navigation ever fires.
 */
export type TaskSettingsHandle = {
  saveIfDirty: () => Promise<boolean>;
};

export type CommunicationSettingsHandle = {
  saveIfDirty: () => Promise<boolean>;
};

export type ManagerSettingsPanelFooter = {
  saving: boolean;
  disabled?: boolean;
  onSave: () => void;
  dataAttr?: string;
};

export function SettingsPanelModalSaveButton({
  saving,
  disabled,
  onSave,
  dataAttr,
}: ManagerSettingsPanelFooter) {
  return (
    <Button
      type="button"
      className="rounded-full px-4 text-[13px]"
      onClick={onSave}
      disabled={disabled || saving}
      data-attr={dataAttr}
    >
      {saving ? "Saving…" : "Save"}
    </Button>
  );
}

function useReportSettingsPanelFooter(
  onFooterReady: ((footer: ManagerSettingsPanelFooter | null) => void) | undefined,
  footer: ManagerSettingsPanelFooter | null,
) {
  const saving = footer?.saving ?? false;
  const disabled = footer?.disabled;
  const dataAttr = footer?.dataAttr;
  const onSave = footer?.onSave;
  useEffect(() => {
    if (!footer) {
      onFooterReady?.(null);
      return;
    }
    onFooterReady?.(footer);
    return () => onFooterReady?.(null);
  }, [dataAttr, disabled, footer, onFooterReady, onSave, saving]);
}

export function ManagerSettingsPropertyField({
  propertyOptions,
  propertyId,
  onPropertyIdChange,
  disabled,
}: {
  propertyOptions: { id: string; label: string }[];
  propertyId: string;
  onPropertyIdChange: (propertyId: string) => void;
  disabled?: boolean;
}) {
  if (propertyOptions.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-accent/30 px-3 py-2.5 text-sm text-muted">
        Add a property listing before configuring these settings.
      </p>
    );
  }
  return (
    <FieldSingleSelect
      label="Property"
      value={propertyId}
      options={propertyOptions.map((option) => ({ value: option.id, label: option.label }))}
      onChange={onPropertyIdChange}
      disabled={disabled}
      dataAttr="manager-settings-property"
    />
  );
}

/**
 * Applications' per-property scope now comes from the module's own
 * `SettingsScopeBar` (PLAN-0920-0845 phase D), not a row inside this panel —
 * there is exactly one property control per module (AGENTS.md § Icon chrome).
 * `propertyIds` still arrives as a prop: it is what the automation below
 * fans its writes out across (`onAutomationChange` below loops every id).
 */
export function ApplicationsSettingsPanel({
  automation,
  loading,
  saving,
  propertyOptions,
  propertyId,
  onPropertyIdChange,
  propertyIds,
  onPropertyIdsChange,
  onAutomationChange,
  waiverCode = "",
  onWaiverCodeChange,
  onWaiverCodeCommit,
  teamMembers = [],
  reminderFormRef,
  showFormLink = false,
  source,
}: {
  automation: ApplicationAutomationPreferences;
  loading: boolean;
  saving: boolean;
  propertyOptions: { id: string; label: string }[];
  /** @deprecated Prefer `propertyIds` — kept for single-property scoped dialogs. */
  propertyId?: string;
  onPropertyIdChange?: (propertyId: string) => void;
  /** Multi-select for waive-code + automation fan-out (PRP-427). */
  propertyIds?: string[];
  onPropertyIdsChange?: (propertyIds: string[]) => void;
  onAutomationChange: (next: ApplicationAutomationPreferences) => void;
  waiverCode?: string;
  onWaiverCodeChange?: (code: string) => void;
  /** Persist the promo code to every selected property (blur / Apply). */
  onWaiverCodeCommit?: () => void;
  teamMembers?: WorkAssignmentTeamMember[];
  reminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  showFormLink?: boolean;
  /** The `source` the host's `manager-application-settings` GET resolved to, for the Handling tag. */
  source?: SettingsResolutionSource | null;
}) {
  const selectedIds = propertyIds ?? (propertyId ? [propertyId] : []);
  const hasSelection = selectedIds.length > 0;
  // The codes table is unique on (manager, code text): a promo code lives on
  // exactly one property, never a fan-out. Automation toggles are fine across
  // several properties; the promo field is not.
  const hasSingleSelection = selectedIds.length === 1;
  const disabled = loading || saving;
  const scope = useSettingsPropertyScope();

  return (
    <div className="space-y-6">
      <PortalSettingsSection
        title="Handling"
        action={source ? <PortalSettingsScopeTag variant="muted">{scopeTagLabel(source, scope.propertyIds.length)}</PortalSettingsScopeTag> : null}
      >
        {showFormLink ? (
          <SettingsFormJumpRow
            detailTab="application"
            propertyId={selectedIds[0]}
            propertyOptions={propertyOptions}
          />
        ) : null}
        <PortalSettingsGroup>
          {onWaiverCodeChange ? (
            <PortalSettingsRow
              label="Promo code"
            >
              <div className="flex flex-col items-end gap-1">
                <input
                  id="manager-application-promo-code"
                  type="text"
                  aria-label="Promo code"
                  className="w-32 rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm uppercase text-foreground sm:w-40"
                  value={waiverCode}
                  disabled={disabled || !hasSingleSelection}
                  placeholder="E.G. WELCOME50"
                  data-attr="manager-application-settings-promo-code"
                  onChange={(e) => onWaiverCodeChange(e.target.value.toUpperCase())}
                  onBlur={() => onWaiverCodeCommit?.()}
                />
                {hasSelection && !hasSingleSelection ? (
                  <p className="text-right text-[11px] text-muted">A promo code belongs to one property. Pick a single property to set it.</p>
                ) : null}
              </div>
            </PortalSettingsRow>
          ) : null}
          <PortalSettingsRow
            label="Auto-approve applications"
          >
            {/* No confirm() gate. The consequence is stated in this row's meta line
                and again in the banner once it is on, and the setting is one click
                to undo — a browser dialog restating the caption is a step to click
                past, not a safeguard. */}
            <PortalSettingsToggle
              checked={automation.autoApproveApplications}
              onChange={(next) => onAutomationChange({ ...automation, autoApproveApplications: next })}
              label="Auto-approve applications"
              disabled={disabled || !hasSelection}
              dataAttr="manager-application-automation-autoApproveApplications"
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
        {automation.autoApproveApplications ? (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-foreground">
            Auto-approve is on{selectedIds.length > 1 ? " for the selected properties" : " for this property"}. New
            submissions are approved without a manual review step.
          </p>
        ) : null}
      </PortalSettingsSection>

      <PortalSettingsSection title="Reminders" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
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
          rows={[
            { kind: "application_decision_manager" },
            { kind: "application_no_lease_manager" },
          ]}
          disabled={loading || saving}
        />
        <ApplicationRemindersSettingsBundle
          teamMembers={teamMembers}
          formRef={reminderFormRef}
          disabled={loading || saving}
        />
      </PortalSettingsSection>

      <PortalSettingsSection title="Messages sent automatically" action={<SettingsGroupSourceTag namespace="automated-messages" />}>
        <AutomatedMessagesList area="applications" disabled={loading || saving} />
      </PortalSettingsSection>
    </div>
  );
}

export function TaskSettingsPanel({
  teamMembers,
  onFooterReady,
  onSaved,
  reminderFormRef,
  formRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  onSaved?: () => void;
  reminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  formRef?: React.Ref<TaskSettingsHandle>;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  // Workspace + per-property scope (PLAN-0916-1040 / PLAN-0920-0845 phase D); the no-op
  // account scope outside a provider.
  const {
    propertyId: scopePropertyId,
    workspaceId: scopeWorkspaceId,
    reportOverriddenPropertyIds,
    reportSource,
    reportLoading: reportScopeLoading,
    resetSignal,
  } = useSettingsPropertyScope();
  const scopeKey = "task:lifecycle";
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automation, setAutomation] = useState<LifecycleTaskAutomation>(DEFAULT_LIFECYCLE_AUTOMATION);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(DEFAULT_LIFECYCLE_AUTOMATION));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      reportScopeLoading(scopeKey, true);
      try {
        if (demo) {
          if (!cancelled) {
            setAutomation(DEFAULT_LIFECYCLE_AUTOMATION);
            setSavedSnapshot(JSON.stringify(DEFAULT_LIFECYCLE_AUTOMATION));
          }
          return;
        }
        const params = new URLSearchParams();
        if (scopePropertyId) params.set("propertyId", scopePropertyId);
        if (scopeWorkspaceId) params.set("workspaceId", scopeWorkspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/api/portal/task-automation-settings${query}`, { credentials: "include", cache: "no-store" });
        if (!res.ok) throw new Error("Could not load task settings.");
        const body = (await res.json()) as {
          automation?: LifecycleTaskAutomation;
          overriddenPropertyIds?: string[];
          source?: SettingsResolutionSource;
        };
        const next = body.automation ?? DEFAULT_LIFECYCLE_AUTOMATION;
        if (!cancelled) {
          setAutomation(next);
          setSavedSnapshot(JSON.stringify(next));
          reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
          reportSource("task-automation-settings", body.source);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load task settings.");
      } finally {
        if (!cancelled) {
          setLoading(false);
          reportScopeLoading(scopeKey, false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast, scopePropertyId, scopeWorkspaceId, scopeKey, reportOverriddenPropertyIds, reportSource, reportScopeLoading]);

  // Reset the house's lifecycle override when the scope bar requests it. Fire only
  // when the signal advances past the mount value (StrictMode double-invokes mount).
  const lastResetRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === lastResetRef.current) return;
    lastResetRef.current = resetSignal;
    if (!scopePropertyId || demo) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/portal/task-automation-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyId: scopePropertyId, reset: true }),
        });
        const body = (await res.json().catch(() => ({}))) as { automation?: LifecycleTaskAutomation; overriddenPropertyIds?: string[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not reset task settings.");
        const next = body.automation ?? DEFAULT_LIFECYCLE_AUTOMATION;
        if (!cancelled) {
          setAutomation(next);
          setSavedSnapshot(JSON.stringify(next));
          reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not reset task settings.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const isDirty = useMemo(() => JSON.stringify(automation) !== savedSnapshot, [automation, savedSnapshot]);

  const save = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      if (!isDirty) return true;
      setSaving(true);
      reportSaveStatus({ type: "start" });
      try {
        if (demo) {
          setSavedSnapshot(JSON.stringify(automation));
          if (!options?.silent) showToast("Task settings saved (demo).");
          onSaved?.();
          reportSaveStatus({ type: "success" });
          return true;
        }
        const res = await fetch("/api/portal/task-automation-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          // A house PATCH edits that house's own override; "" edits the workspace.
          body: JSON.stringify({
            automation,
            ...(scopePropertyId ? { propertyId: scopePropertyId } : {}),
            ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
          }),
          // A hard page unload (real reload/close, not a same-app route change) can abort an
          // ordinary in-flight fetch before it lands — this is exactly the write the
          // `pagehide`/`visibilitychange` flush in `settings-module-page.tsx` exists to send;
          // `keepalive` is what lets the browser actually finish it after the document goes away.
          keepalive: true,
        });
        const body = (await res.json().catch(() => ({}))) as {
          automation?: LifecycleTaskAutomation;
          overriddenPropertyIds?: string[];
          source?: SettingsResolutionSource;
          error?: string;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not save task settings.");
        const next = body.automation ?? automation;
        setAutomation(next);
        setSavedSnapshot(JSON.stringify(next));
        reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
        reportSource("task-automation-settings", body.source);
        if (!options?.silent) showToast("Task settings saved.");
        onSaved?.();
        reportSaveStatus({ type: "success" });
        return true;
      } catch (e) {
        // Unconditional — silent only suppresses the SUCCESS toast, never the
        // failure one. A per-control autosave that fails must still surface.
        const message = e instanceof Error ? e.message : "Could not save task settings.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [
      automation,
      demo,
      isDirty,
      onSaved,
      reportSaveStatus,
      showToast,
      scopePropertyId,
      scopeWorkspaceId,
      scopeKey,
      reportOverriddenPropertyIds,
      reportSource,
    ],
  );

  // `save` already checks `isDirty` itself, so it doubles directly as `saveIfDirty` — this is
  // what makes the pending write survive the standalone page's flush-before-switch (`goToArea`)
  // and the modal's `selectTab`/`closeAndSave`, not just this panel's own unmount.
  const saveIfDirty = useCallback((): Promise<boolean> => save({ silent: true }), [save]);
  useImperativeHandle(formRef, () => ({ saveIfDirty }), [saveIfDirty]);

  // Autosaves on close — no explicit Save button in the footer.
  useReportSettingsPanelFooter(onFooterReady, null);

  /** Per-control autosave, same debounced-effect shape as `TourSettingsPanel` and
   *  `ManagerReminderRuleSettingsPanel` — no Save button. */
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loading || !isDirty) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void save({ silent: true });
    }, 600);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [isDirty, loading, save]);

  // A debounced write still pending when this module goes away (tab switch the host didn't
  // explicitly flush, or leaving Settings outright) must still land — see
  // `useFlushSettingsAutosaveOnUnmount`'s own doc comment for why this has to live here and not
  // one level up.
  useFlushSettingsAutosaveOnUnmount(save, isDirty);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-6">
      <PortalSettingsSection title="Reminders" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <ManagerReminderRuleSettingsPanel
          kind="task"
          audienceMode="manager"
          teamMembers={teamMembers}
          formRef={reminderFormRef}
          disabled={saving}
        />
        <AutomationRuleRows rows={[{ kind: "task_overdue" }]} disabled={saving} />
      </PortalSettingsSection>

      <PortalSettingsSection title="Lifecycle automation" action={<SettingsGroupSourceTag namespace="task-automation-settings" />}>
        <TaskAutomationSettingsFields
          automation={automation}
          teamMembers={teamMembers}
          loading={loading}
          saving={saving}
          onChange={setAutomation}
        />
      </PortalSettingsSection>
    </div>
  );
}

/**
 * Lease's per-property scope comes from the module's own `SettingsScopeBar`
 * (PLAN-0920-0845 phase D) — see `ApplicationsSettingsPanel`'s doc comment.
 */
export function LeaseSettingsPanel({
  automation,
  loading,
  saving,
  propertyOptions,
  propertyId,
  onPropertyIdChange,
  onAutomationChange,
  teamMembers = [],
  reminderFormRef,
  showFormLink = false,
  source,
}: {
  automation: ApplicationAutomationPreferences;
  loading: boolean;
  saving: boolean;
  propertyOptions: { id: string; label: string }[];
  propertyId: string;
  onPropertyIdChange: (propertyId: string) => void;
  onAutomationChange: (next: ApplicationAutomationPreferences) => void;
  teamMembers?: WorkAssignmentTeamMember[];
  reminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  showFormLink?: boolean;
  /** The `source` the host's `manager-application-settings` GET resolved to, for the Documents tag. */
  source?: SettingsResolutionSource | null;
}) {
  const disabled = loading || saving;
  const scope = useSettingsPropertyScope();
  const LEASE_TOGGLE_ROWS = [
    {
      step: "autoGenerateLease" as const,
      label: "Auto-generate the lease on approval",
      meta: "Build the lease document as soon as an application is approved.",
    },
    {
      step: "autoSendLease" as const,
      label: "Auto-send the lease to the resident",
      meta: "Send the generated lease for signature when it is ready.",
    },
  ];

  return (
    <div className="space-y-6">
      <PortalSettingsSection
        title="Documents"
        action={source ? <PortalSettingsScopeTag variant="muted">{scopeTagLabel(source, scope.propertyIds.length)}</PortalSettingsScopeTag> : null}
      >
        {showFormLink ? (
          <SettingsFormJumpRow
            detailTab="lease"
            propertyId={propertyId}
            propertyOptions={propertyOptions}
          />
        ) : null}
        <PortalSettingsGroup>
          {LEASE_TOGGLE_ROWS.map(({ step, label, meta }) => (
            <PortalSettingsRow key={step} label={label}>
              <PortalSettingsToggle
                checked={automation[step]}
                onChange={(next) => onAutomationChange({ ...automation, [step]: next })}
                label={label}
                disabled={disabled}
                dataAttr={`manager-application-automation-${step}`}
              />
            </PortalSettingsRow>
          ))}
        </PortalSettingsGroup>
      </PortalSettingsSection>

      <PortalSettingsSection title="Ending" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <AutomationRuleRows
          rows={[
            { kind: "lease_ending_manager", multi: true },
            { kind: "lease_ending", multi: true },
            { kind: "renewal_offer_expiry" },
            { kind: "countersign_overdue" },
          ]}
          disabled={loading || saving}
        />
      </PortalSettingsSection>

      <PortalSettingsSection title="Move-in" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <AutomationRuleRows
          rows={[
            { kind: "move_in", multi: true },
            { kind: "move_in_payment_method" },
          ]}
          disabled={loading || saving}
        />
      </PortalSettingsSection>

      <PortalSettingsSection title="Move-out" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <AutomationRuleRows
          rows={[
            { kind: "move_out", multi: true },
            { kind: "move_out_inspection_manager" },
            { kind: "deposit_accounting", multi: true },
          ]}
          disabled={loading || saving}
        />
        <LeaseAutomationSettingsRows />
      </PortalSettingsSection>

      <PortalSettingsSection title="Reminders" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <LeaseRemindersSettingsBundle
          teamMembers={teamMembers}
          formRef={reminderFormRef}
          disabled={loading || saving}
        />
        <AutomationRuleRows rows={[{ kind: "document_signature" }]} disabled={loading || saving} />
      </PortalSettingsSection>

      <PortalSettingsSection title="Messages sent automatically" action={<SettingsGroupSourceTag namespace="automated-messages" />}>
        <AutomatedMessagesList area="lease" disabled={loading || saving} />
      </PortalSettingsSection>
    </div>
  );
}

export function ServicesSettingsPanel({
  teamMembers,
  onFooterReady,
  workOrderReminderFormRef,
  serviceOrderReminderFormRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  workOrderReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  serviceOrderReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  useReportSettingsPanelFooter(onFooterReady, null);

  return (
    <PortalSettingsSections>
      <PortalSettingsSection title="Requests" action={<SettingsGroupSourceTag namespace="service-automation-settings" />}>
        <ServiceRequestAutomationRows />
        <AutomationRuleRows
          rows={[
            { kind: "work_order_unassigned" },
            { kind: "work_order_unassigned_emergency" },
            { kind: "service_request_decision" },
            { kind: "service_request_unpaid" },
          ]}
        />
      </PortalSettingsSection>
      <PortalSettingsSection title="Vendors" action={<SettingsGroupSourceTag namespace="service-automation-settings" />}>
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
      </PortalSettingsSection>
      <PortalSettingsSection title="Reminders" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <AutoMessageAssigneeRow />
        <ServiceRemindersSettingsBundle
          teamMembers={teamMembers}
          workOrderFormRef={workOrderReminderFormRef}
          serviceOrderFormRef={serviceOrderReminderFormRef}
        />
      </PortalSettingsSection>
      <PortalSettingsSection title="Messages sent automatically" action={<SettingsGroupSourceTag namespace="automated-messages" />}>
        <AutomatedMessagesList area="services" />
      </PortalSettingsSection>
    </PortalSettingsSections>
  );
}

/**
 * "Message assignee automatically" — Add service sends the assignment message
 * to a vendor or teammate without the preview when this is on. Autosaves on
 * flip through the same `/api/portal/automation-settings` PATCH every other
 * automation preference uses; the row reports its own failure and reverts.
 */
function AutoMessageAssigneeRow() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [value, setValue] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS.autoMessageAssignee);
        return;
      }
      try {
        const res = await fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown };
        if (!res.ok) throw new Error("Could not load service settings.");
        if (!cancelled) setValue(normalizeManagerAutomationSettings(body.settings).autoMessageAssignee);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load service settings.");
        if (!cancelled) setValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS.autoMessageAssignee);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

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
        body: JSON.stringify({ autoMessageAssignee: next }),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save service settings.");
      setValue(normalizeManagerAutomationSettings(body.settings).autoMessageAssignee);
      reportSaveStatus({ type: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save service settings.";
      setValue(previous);
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
    }
  };

  return (
    <PortalSettingsGroup>
      <PortalSettingsRow label="Message assignee automatically">
        <PortalSettingsToggle
          checked={value === true}
          onChange={(next) => void flip(next)}
          label="Message assignee automatically"
          disabled={value === null}
          dataAttr="service-auto-message-assignee"
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}

/**
 * Bookings settings.
 *
 * Reminders are the whole panel. Settings used to open the Link Airbnb dialog —
 * the same dialog the button beside it already opens — so the section had two
 * controls leading to one place and no home for a booking preference.
 *
 * Manager-side only, so no counterparty switch: an imported channel booking
 * carries no guest contact. See the note at the top of `lib/reminders/rules.ts`.
 */
/**
 * Inspections settings. Reminders are the whole panel: a move-in or move-out condition report
 * has no other per-manager preference to hold, and the reminder is what stops one being missed.
 */
export function InspectionsSettingsPanel({
  teamMembers,
  onFooterReady,
  dueReminderFormRef,
  reviewReminderFormRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  dueReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  reviewReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  useReportSettingsPanelFooter(onFooterReady, null);

  return (
    <PortalSettingsSections>
      <PortalSettingsSection title="Reminders" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <InspectionRemindersSettingsBundle
          teamMembers={teamMembers}
          dueFormRef={dueReminderFormRef}
          reviewFormRef={reviewReminderFormRef}
        />
      </PortalSettingsSection>
      <PortalSettingsSection title="Messages sent automatically" action={<SettingsGroupSourceTag namespace="automated-messages" />}>
        <AutomatedMessagesList area="inspections" />
      </PortalSettingsSection>
    </PortalSettingsSections>
  );
}

export function BookingsSettingsPanel({
  teamMembers,
  onFooterReady,
  reminderFormRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  reminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  useReportSettingsPanelFooter(onFooterReady, null);

  return (
    <PortalSettingsSections>
      <PortalSettingsSection title="Reminders" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <ManagerReminderRuleSettingsPanel
          kind="booking"
          audienceMode="manager"
          teamMembers={teamMembers}
          formRef={reminderFormRef}
        />
      </PortalSettingsSection>
    </PortalSettingsSections>
  );
}

export const RESIDENT_SETTINGS_AREAS = [
  { value: "household", label: "Household reminders" },
] as const;

export type ResidentSettingsArea = (typeof RESIDENT_SETTINGS_AREAS)[number]["value"];

/**
 * Resident settings stay in this tab: pick a house, then household / resident-life
 * reminders only. Rent and payment reminders live under Payment settings.
 */
export function ResidentSettingsPanel({
  propertyOptions,
  selectedPropertyId,
  onPropertyIdChange,
  area,
  onAreaChange,
  teamMembers = [],
  paymentsFormRef,
  householdFormRef,
}: {
  propertyOptions: { id: string; label: string }[];
  selectedPropertyId: string;
  onPropertyIdChange: (propertyId: string) => void;
  area: ResidentSettingsArea;
  onAreaChange: (area: ResidentSettingsArea) => void;
  teamMembers?: WorkAssignmentTeamMember[];
  paymentsFormRef?: React.Ref<PaymentAutomationSettingsHandle>;
  householdFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  void propertyOptions;
  void selectedPropertyId;
  void onPropertyIdChange;
  void area;
  void onAreaChange;
  void teamMembers;
  void paymentsFormRef;
  void householdFormRef;

  return (
    <PortalSettingsSections>
      <PortalSettingsSection title="Welcome" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
        <AutomationRuleRows rows={[{ kind: "resident_welcome", multi: true }]} />
      </PortalSettingsSection>
    </PortalSettingsSections>
  );
}

/** Days of notice a stepper will accept — 0 keeps same-day tours open; 30 mirrors `normalizeTourNoticeDays`'s own cap. */
const TOUR_NOTICE_MIN_DAYS = 0;
const TOUR_NOTICE_MAX_DAYS = 30;

/**
 * −/+ stepper for `tourNoticeDays`. A real `<input type="number">` drives the
 * value (native accessible name + value, no hand-rolled `aria-valuenow`
 * bookkeeping to keep in sync), flanked by icon buttons that nudge it by one
 * day; typing a value directly still works and is clamped the same way.
 */
function TourNoticeStepper({
  value,
  onChange,
  disabled,
  dataAttr,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  dataAttr: string;
}) {
  const clamp = (n: number) => Math.min(TOUR_NOTICE_MAX_DAYS, Math.max(TOUR_NOTICE_MIN_DAYS, Math.round(n)));
  const commit = (n: number) => {
    if (!Number.isFinite(n)) return;
    onChange(clamp(n));
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label="Decrease notice required"
        disabled={disabled || value <= TOUR_NOTICE_MIN_DAYS}
        onClick={() => commit(value - 1)}
        data-attr={`${dataAttr}-decrement`}
        className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Minus className="size-3.5" aria-hidden />
      </button>
      <div className="flex flex-col items-center">
        <input
          type="number"
          inputMode="numeric"
          aria-label="Notice required"
          min={TOUR_NOTICE_MIN_DAYS}
          max={TOUR_NOTICE_MAX_DAYS}
          step={1}
          value={value}
          disabled={disabled}
          data-attr={dataAttr}
          onChange={(e) => commit(Number(e.target.value))}
          className="h-8 w-14 rounded-lg border border-border bg-card text-center text-sm font-semibold tabular-nums text-foreground [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="mt-0.5 text-[10px] leading-none text-muted">{tourNoticeDaysLabel(value)}</span>
      </div>
      <button
        type="button"
        aria-label="Increase notice required"
        disabled={disabled || value >= TOUR_NOTICE_MAX_DAYS}
        onClick={() => commit(value + 1)}
        data-attr={`${dataAttr}-increment`}
        className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function TourSettingsPanel({
  onSaved,
  onFooterReady,
  formRef,
  teamMembers = [],
  managerReminderFormRef,
}: {
  onSaved?: () => void;
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  formRef?: React.Ref<TourSettingsHandle>;
  teamMembers?: WorkAssignmentTeamMember[];
  managerReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tourSettings, setTourSettings] = useState<ManagerTourSettings>(DEFAULT_MANAGER_TOUR_SETTINGS);
  const [automation, setAutomation] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
  const [savedTourSettings, setSavedTourSettings] = useState<ManagerTourSettings>(DEFAULT_MANAGER_TOUR_SETTINGS);
  const [savedAutomationSnapshot, setSavedAutomationSnapshot] = useState(() =>
    tourAutomationSnapshot(DEFAULT_MANAGER_AUTOMATION_SETTINGS),
  );
  const [messageModalOpen, setMessageModalOpen] = useState(false);
  const [tourReminderType, setTourReminderType] = useState<"guest" | "manager">("guest");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) {
            setTourSettings(DEFAULT_MANAGER_TOUR_SETTINGS);
            setAutomation(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
            setSavedTourSettings(DEFAULT_MANAGER_TOUR_SETTINGS);
            setSavedAutomationSnapshot(tourAutomationSnapshot(DEFAULT_MANAGER_AUTOMATION_SETTINGS));
          }
          return;
        }
        const [tourRes, autoRes] = await Promise.all([
          fetch("/api/portal/manager-tour-settings", { credentials: "include", cache: "no-store" }),
          fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" }),
        ]);
        const tourBody = (await tourRes.json().catch(() => ({}))) as { settings?: ManagerTourSettings; error?: string };
        const autoBody = (await autoRes.json().catch(() => ({}))) as {
          settings?: ManagerAutomationSettings;
          error?: string;
        };
        if (!tourRes.ok) throw new Error(tourBody.error ?? "Could not load tour settings.");
        if (!autoRes.ok) throw new Error(autoBody.error ?? "Could not load automation settings.");
        if (!cancelled) {
          const nextTour = tourBody.settings ?? DEFAULT_MANAGER_TOUR_SETTINGS;
          const nextAutomation = autoBody.settings ?? DEFAULT_MANAGER_AUTOMATION_SETTINGS;
          setTourSettings(nextTour);
          setAutomation(nextAutomation);
          setSavedTourSettings(nextTour);
          setSavedAutomationSnapshot(tourAutomationSnapshot(nextAutomation));
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load calendar settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

  const templatePreview = useMemo(
    () => fillTourReminderTemplate(automation.templates.tourReminder, TOUR_PREVIEW_CONTEXT),
    [automation.templates.tourReminder],
  );

  const isDirty = useMemo(() => {
    if (loading) return false;
    return (
      JSON.stringify(tourSettings) !== JSON.stringify(savedTourSettings) ||
      JSON.stringify(tourAutomationSnapshot(automation)) !== JSON.stringify(savedAutomationSnapshot)
    );
  }, [automation, loading, savedAutomationSnapshot, savedTourSettings, tourSettings]);

  const save = useCallback(async (options?: { silent?: boolean }) => {
    const minutesBeforeList = normalizeTourReminderMinutesBeforeList(
      automation.tourReminderMinutesBeforeList,
      automation.tourReminderMinutesBefore,
    );
    if (minutesBeforeList.length === 0) {
      const message = "Choose at least one tour reminder timing.";
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
      return false;
    }
    if (
      automation.tourReminderDeliverViaInbox === false &&
      automation.tourReminderDeliverViaEmail === false &&
      automation.tourReminderDeliverViaSms !== true
    ) {
      const message = "Choose at least one channel under Reminders → Send via.";
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
      return false;
    }
    setSaving(true);
    reportSaveStatus({ type: "start" });
    try {
      if (demo) {
        if (!options?.silent) showToast("Tour settings saved (demo).");
        onSaved?.();
        reportSaveStatus({ type: "success" });
        return true;
      }
      // `keepalive` on both: a hard page unload (a real reload/close, not a same-app route
      // change) can abort an ordinary in-flight fetch before it lands — exactly the write the
      // `pagehide`/`visibilitychange` flush in `settings-module-page.tsx` exists to send.
      const [tourRes, autoRes] = await Promise.all([
        fetch("/api/portal/manager-tour-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tourSettings),
          keepalive: true,
        }),
        fetch("/api/portal/automation-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proposeTourConfirmations: automation.proposeTourConfirmations,
            tourReminderEnabled: true,
            tourReminderMinutesBefore: Math.min(...minutesBeforeList),
            tourReminderMinutesBeforeList: minutesBeforeList,
            tourReminderDeliverViaEmail: automation.tourReminderDeliverViaEmail,
            tourReminderDeliverViaSms: automation.tourReminderDeliverViaSms,
            tourReminderDeliverViaInbox: automation.tourReminderDeliverViaInbox,
            templates: { tourReminder: automation.templates.tourReminder },
          }),
          keepalive: true,
        }),
      ]);
      if (!tourRes.ok || !autoRes.ok) throw new Error("Could not save calendar settings.");
      window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      setSavedTourSettings(tourSettings);
      setSavedAutomationSnapshot(tourAutomationSnapshot(automation));
      if (!options?.silent) showToast("Tour settings saved.");
      onSaved?.();
      reportSaveStatus({ type: "success" });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save tour settings.";
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
      return false;
    } finally {
      setSaving(false);
    }
  }, [automation, demo, onSaved, reportSaveStatus, showToast, tourSettings]);

  const saveIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    return save({ silent: true });
  }, [isDirty, save]);

  useImperativeHandle(formRef, () => ({ saveIfDirty }), [saveIfDirty]);

  // Autosaves on close — no explicit Save button in the modal footer.
  useReportSettingsPanelFooter(onFooterReady, null);

  /**
   * Per-control autosave for the redrawn rows below: the notice stepper and
   * the auto-confirm toggle both write straight into `tourSettings` /
   * `automation` via their own `onChange`, and this debounced effect turns
   * that dirty state into a save shortly after — no Save button. `saveIfDirty`
   * above is unchanged and is still what the flush-before-close path in
   * `SettingsModulePage` calls; this effect is just an earlier caller of the
   * same `save`.
   */
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loading || !isDirty) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void save({ silent: true });
    }, 600);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [isDirty, loading, save]);

  // A debounced write still pending when this module goes away (tab switch the host didn't
  // explicitly flush, or leaving Settings outright) must still land — see
  // `useFlushSettingsAutosaveOnUnmount`'s own doc comment for why this has to live here and not
  // one level up.
  useFlushSettingsAutosaveOnUnmount(save, isDirty);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  const disabled = saving;
  const noticeDays = normalizeTourNoticeDays(tourSettings.tourNoticeDays);

  return (
    <>
      <div className="space-y-6">
        <PortalSettingsSection title="Booking">
          <PortalSettingsGroup>
            <PortalSettingsRow
              label="Notice required"
            >
              <TourNoticeStepper
                value={noticeDays}
                disabled={disabled}
                dataAttr="manager-tour-notice-days"
                onChange={(next) => setTourSettings((prev) => ({ ...prev, tourNoticeDays: next }))}
              />
            </PortalSettingsRow>
            <PortalSettingsRow
              label="Auto confirm tours"
            >
              <PortalSettingsToggle
                checked={automation.proposeTourConfirmations}
                onChange={(next) => setAutomation((prev) => ({ ...prev, proposeTourConfirmations: next }))}
                label="Auto confirm tours"
                disabled={disabled}
                dataAttr="manager-tour-auto-confirm-proposals"
              />
            </PortalSettingsRow>
          </PortalSettingsGroup>
        </PortalSettingsSection>

        <PortalSettingsSection title="Reminders" action={<SettingsGroupSourceTag namespace="reminder-settings" />}>
          <div className="space-y-4">
            <ReminderTypePicker
              value={tourReminderType}
              options={[
                {
                  value: "guest",
                  label: "Guest tour reminders",
                },
                {
                  value: "manager",
                  label: "Your tour reminders",
                },
              ]}
              onChange={setTourReminderType}
              dataAttr="tour-reminder-type"
            />
            {tourReminderType === "guest" ? (
              <div className="space-y-3">
                <TourReminderTimingSelect
                  minutesBeforeList={normalizeTourReminderMinutesBeforeList(
                    automation.tourReminderMinutesBeforeList,
                    automation.tourReminderMinutesBefore,
                  )}
                  onChangeMinutesList={(minutesBeforeList) =>
                    setAutomation((prev) => ({
                      ...prev,
                      tourReminderMinutesBeforeList: minutesBeforeList,
                      tourReminderMinutesBefore: minutesBeforeList.length
                        ? Math.min(...minutesBeforeList)
                        : prev.tourReminderMinutesBefore,
                    }))
                  }
                />
                <ReminderSendViaField
                  showProplaneChannel
                  viaInbox={automation.tourReminderDeliverViaInbox !== false}
                  viaEmail={automation.tourReminderDeliverViaEmail !== false}
                  viaSms={automation.tourReminderDeliverViaSms === true}
                  smsLabel="SMS (when guest opted in)"
                  onChange={({ viaEmail, viaSms, viaInbox }) =>
                    setAutomation((prev) => ({
                      ...prev,
                      tourReminderDeliverViaInbox: viaInbox !== false,
                      tourReminderDeliverViaEmail: viaEmail,
                      tourReminderDeliverViaSms: viaSms,
                    }))
                  }
                  dataAttr="tour-reminder-send-via"
                />
                <ReminderMessagePreviewCard
                  subject={templatePreview.subject}
                  body={templatePreview.body}
                  onUpdate={() => setMessageModalOpen(true)}
                  dataAttr="tour-reminder-update-message"
                />
              </div>
            ) : (
              <ManagerReminderRuleSettingsPanel
                kind="tour"
                audienceMode="manager"
                teamMembers={teamMembers}
                formRef={managerReminderFormRef}
              />
            )}
          </div>
        </PortalSettingsSection>

        <PortalSettingsSection title="Requests and follow-ups">
          <AutomationRuleRows
            rows={[
              { kind: "tour_request_unanswered" },
              { kind: "tour_request_reoffer" },
              { kind: "tour_no_show_manager" },
            ]}
          />
        </PortalSettingsSection>

        <PortalSettingsSection title="Messages sent automatically" action={<SettingsGroupSourceTag namespace="automated-messages" />}>
          <AutomatedMessagesList area="tours" />
        </PortalSettingsSection>
      </div>

      <TourInterestSettings />

      <ReminderMessageUpdateModal
        open={messageModalOpen}
        onClose={() => setMessageModalOpen(false)}
        subject={automation.templates.tourReminder.subject}
        body={automation.templates.tourReminder.body}
        recipient={TOUR_PREVIEW_CONTEXT.guestName}
        viaInbox={automation.tourReminderDeliverViaInbox !== false}
        viaEmail={automation.tourReminderDeliverViaEmail !== false}
        viaSms={automation.tourReminderDeliverViaSms === true}
        smsLabel="SMS (when guest opted in)"
        placeholders={TOUR_PLACEHOLDERS}
        onSave={({ subject, body, viaInbox, viaEmail, viaSms }) => {
          setAutomation((prev) => ({
            ...prev,
            templates: { ...prev.templates, tourReminder: { subject, body } },
            tourReminderDeliverViaInbox: viaInbox,
            tourReminderDeliverViaEmail: viaEmail,
            tourReminderDeliverViaSms: viaSms,
          }));
        }}
      />
    </>
  );
}

/**
 * Payment settings is workspace-scoped Stripe + processing fee, then late
 * fees and rent reminders. Household / resident-life reminders live under
 * Resident settings. Workspace comes from the portal top-left switcher, or
 * the module's own scope bar when it has overridden it.
 *
 * PLAN-0920-0845 phase E dropped the "Settings" area dropdown that used to
 * show one of Payment setup / Incoming / Outgoing / Late fees at a time —
 * every one of those now stacks, always visible, as its own titled, tagged
 * section: Payment setup, Processing fee, Late fees, Incoming reminders,
 * Outgoing reminders, in that order.
 */
export function PaymentsSettingsPanel({
  onSaved,
  onFooterReady,
  formRef,
  mode = "incoming",
  teamMembers = [],
  outgoingReminderFormRef,
  propertyOptions = [],
}: {
  onSaved?: () => void;
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  formRef?: React.Ref<PaymentAutomationSettingsHandle>;
  /** Incoming = resident rent reminders; outgoing = manager payee reminders. */
  mode?: "incoming" | "outgoing";
  teamMembers?: WorkAssignmentTeamMember[];
  outgoingReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
  propertyOptions?: { id: string; label: string }[];
  initialPropertyId?: string;
}) {
  const workspaces = useWorkspaces();
  const scope = useSettingsPropertyScope();
  const remindersRef = useRef<PaymentAutomationSettingsHandle | null>(null);
  const lateFeeRef = useRef<PaymentListingLateFeeHandle | null>(null);

  useImperativeHandle(
    formRef,
    () => ({
      saveIfDirty: async () => {
        if ((await remindersRef.current?.saveIfDirty()) === false) return false;
        if ((await lateFeeRef.current?.saveIfDirty()) === false) return false;
        return true;
      },
    }),
    [],
  );

  useReportSettingsPanelFooter(onFooterReady, null);

  /* Only workspaces the signed-in manager owns can have their payment setup
     changed here — same fallback `ManagerPaymentSetupPanel` already uses for
     the processing-fee payer: the scope bar's own pick, else the active
     workspace (if owned), else the first owned workspace. */
  const ownedWorkspaces = useMemo(
    () => (workspaces?.workspaces ?? []).filter((w) => w.owned),
    [workspaces?.workspaces],
  );
  const effectiveWorkspace = useMemo(() => {
    if (scope.workspaceId) return workspaces?.workspaces.find((w) => w.id === scope.workspaceId) ?? null;
    if (workspaces?.active?.owned) return workspaces.active;
    return ownedWorkspaces[0] ?? null;
  }, [scope.workspaceId, workspaces, ownedWorkspaces]);

  const houses = useMemo(() => {
    if (!effectiveWorkspace) return propertyOptions;
    const allowed = new Set(effectiveWorkspace.propertyIds.map((id) => id.trim()).filter(Boolean));
    return unionLabeledPropertyOptions(
      propertyOptionsFromWorkspacePayload(effectiveWorkspace),
      propertyOptions.filter((house) => allowed.has(house.id)),
    );
  }, [effectiveWorkspace, propertyOptions]);

  /* Late fees have no workspace/account rung — every listing carries its own
     value — so the "all properties" bucket is every house in this resolved
     workspace, not just the ones the global switcher currently shows. */
  const workspaceProperties = houses;

  const lateFeePropertyCount = scope.propertyIds.length > 0 ? scope.propertyIds.length : workspaceProperties.length;

  if (mode === "outgoing") {
    return (
      <div className="space-y-6">
        <PortalSettingsSection title="Reminders">
          <OutgoingPaymentRemindersSettingsBundle
            teamMembers={teamMembers}
            formRef={outgoingReminderFormRef}
          />
        </PortalSettingsSection>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PortalSettingsSection title="Payment setup">
        <ManagerPaymentSetupPanel active section="setup" propertyOptions={houses} />
        <ManagerAutomationSelectRow
          label="Upcoming charges in Payments"
          field="showUpcomingCharges"
          options={[
            { value: "true", label: "Show" },
            { value: "false", label: "Hide" },
          ]}
          parse={(value) => value === "true"}
          dataAttr="payments-settings-show-upcoming-charges"
        />
      </PortalSettingsSection>

      <PortalSettingsSection
        title="Processing fee"
        action={<SettingsGroupSourceTag namespace="processing-fee-settings" />}
      >
        <ManagerPaymentSetupPanel active section="fee" propertyOptions={houses} />
      </PortalSettingsSection>

      <PortalSettingsSection
        title="Late fees"
        action={<PortalSettingsScopeTag variant="muted">{scopeTagLabel("property", lateFeePropertyCount)}</PortalSettingsScopeTag>}
      >
        <PortalSettingsGroup>
          <PaymentListingLateFeeSettings
            ref={lateFeeRef}
            propertyOptions={workspaceProperties}
            workspaceName={effectiveWorkspace?.name}
            workspaceId={effectiveWorkspace?.id}
          />
        </PortalSettingsGroup>
      </PortalSettingsSection>

      <PortalSettingsSection
        title="Incoming reminders"
        action={<SettingsGroupSourceTag namespace="incoming-payment-reminders" />}
      >
        <IncomingPaymentRemindersSettingsBundle
          teamMembers={teamMembers}
          onSaved={onSaved}
          formRef={remindersRef}
        />
      </PortalSettingsSection>

      <PortalSettingsSection title="Delinquency">
        <AutomationRuleRows rows={[{ kind: "delinquency_manager" }]} />
      </PortalSettingsSection>
      <PortalSettingsSection title="Messages sent automatically">
        <AutomatedMessagesList area="payments" />
      </PortalSettingsSection>

      <PortalSettingsSection
        title="Outgoing reminders"
        action={<SettingsGroupSourceTag namespace="outgoing-payment-reminders" />}
      >
        <OutgoingPaymentRemindersSettingsBundle
          teamMembers={teamMembers}
          formRef={outgoingReminderFormRef}
        />
      </PortalSettingsSection>
    </div>
  );
}

/**
 * Communication used to carry a second "Send via for" editor covering seven
 * categories (default, messages, leases, applications, maintenance, payment
 * reminders, tour reminders) that duplicated the channel choice each of
 * those events already exposes at its own reminder rule (the inline Inbox /
 * Email / Text cells on every `ManagerReminderRuleSettingsPanel` audience
 * row) or, for the guest tour reminder, directly on `TourSettingsPanel`'s own
 * reminder card. Two screens editing one setting meant they could silently
 * disagree, so that editor is gone — what is left here (AI drafts, the work
 * number) is genuinely Communication-specific. Nothing else in this file
 * read `activeSendViaSectionId`/`patchDeliverViaForKind`, and the deleted
 * editor was the only writer of the `…DeliverViaEmail/Sms/Inbox` fields for
 * those seven categories from this screen — their stored values are simply
 * no longer editable from Communication, and `anySmsEnabled` below still
 * reads them (unchanged) to decide whether the work-number hint applies.
 */
export function CommunicationSettingsPanel({
  onSaved,
  onFooterReady,
  formRef,
}: {
  onSaved?: () => void;
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  formRef?: React.Ref<CommunicationSettingsHandle>;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const scope = useSettingsPropertyScope();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(DEFAULT_MANAGER_AUTOMATION_SETTINGS));
  const [smsSetup, setSmsSetup] = useState<{ phone: string | null; canSend: boolean } | null>(null);
  /** "Who can email the assistant" — the Channels row's audience fact, moved here (PLAN-0920-1530). */
  const [workEmailAudience, setWorkEmailAudience] = useState<string | null>(null);
  const [source, setSource] = useState<SettingsResolutionSource | null>(null);

  const anySmsEnabled = useMemo(
    () =>
      MANAGER_COMMUNICATION_SEND_VIA_SECTIONS.some(
        (section) => deliverViaFromManagerSettings(draft, section.kind).viaSms,
      ),
    [draft],
  );

  const scopePropertyId = scope.propertyId;
  const scopeWorkspaceId = scope.workspaceId;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) {
            setDraft(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
            setSavedSnapshot(JSON.stringify(DEFAULT_MANAGER_AUTOMATION_SETTINGS));
            setSmsSetup(null);
            setWorkEmailAudience(null);
          }
          return;
        }
        const params = new URLSearchParams();
        if (scopePropertyId) params.set("propertyId", scopePropertyId);
        if (scopeWorkspaceId) params.set("workspaceId", scopeWorkspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const [settingsRes, numberRes, emailRes] = await Promise.all([
          fetch(`/api/portal/automation-settings${query}`, { credentials: "include", cache: "no-store" }),
          fetch(
            scopeWorkspaceId
              ? `/api/manager/messaging-number?workspaceId=${encodeURIComponent(scopeWorkspaceId)}`
              : "/api/manager/messaging-number",
            { credentials: "include", cache: "no-store" },
          ).catch(() => null),
          fetch(
            scopeWorkspaceId
              ? `/api/manager/assistant-email?workspaceId=${encodeURIComponent(scopeWorkspaceId)}`
              : "/api/manager/assistant-email",
            { credentials: "include", cache: "no-store" },
          ).catch(() => null),
        ]);
        if (!settingsRes.ok) throw new Error("Could not load communication settings.");
        const body = (await settingsRes.json()) as { settings: ManagerAutomationSettings; source?: SettingsResolutionSource };
        const nextSettings = normalizeManagerAutomationSettings(body.settings);
        if (!cancelled) {
          setDraft(nextSettings);
          setSavedSnapshot(JSON.stringify(nextSettings));
          setSource(body.source ?? null);
          scope.reportSource("automation-settings", body.source);
        }
        if (!cancelled) {
          const status =
            numberRes && numberRes.ok
              ? ((await numberRes.json()) as ManagerMessagingNumberStatus)
              : null;
          setSmsSetup(
            status
              ? {
                  phone: normalizeE164(status.number?.phoneNumber),
                  canSend: status.canSend,
                }
              : null,
          );
          const emailBody =
            emailRes && emailRes.ok ? ((await emailRes.json()) as unknown) : null;
          setWorkEmailAudience(
            isManagerAssistantEmailStatus(emailBody) ? workEmailAudienceLabel(emailBody) : null,
          );
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load communication settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // scope.reportSource is a stable useCallback and must not be a dependency here — it fires
    // during this same effect, and its own reference is derived from `sources` state that this
    // very call updates, so listing `scope` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, showToast, scopePropertyId, scopeWorkspaceId]);

  const isDirty = useMemo(() => JSON.stringify(draft) !== savedSnapshot, [draft, savedSnapshot]);

  const save = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      if (!isDirty) return true;
      setSaving(true);
      reportSaveStatus({ type: "start" });
      try {
        if (demo) {
          setSavedSnapshot(JSON.stringify(draft));
          if (!options?.silent) showToast("Communication settings saved (demo).");
          onSaved?.();
          reportSaveStatus({ type: "success" });
          return true;
        }
        // Only the field this screen can still edit — the seven "Send via for"
        // categories are no longer writable from here (see the doc comment above).
        const res = await fetch("/api/portal/automation-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inboxAiDraftAutoSend: draft.inboxAiDraftAutoSend,
            ...(scope.propertyId ? { propertyId: scope.propertyId } : {}),
            ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
          }),
          // A hard page unload can abort an ordinary in-flight fetch before it lands — exactly
          // the write the `pagehide`/`visibilitychange` flush in `settings-module-page.tsx`
          // exists to send.
          keepalive: true,
        });
        const body = (await res.json().catch(() => ({}))) as {
          settings?: ManagerAutomationSettings;
          source?: SettingsResolutionSource;
          error?: string;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not save communication settings.");
        const next = body.settings ? normalizeManagerAutomationSettings(body.settings) : draft;
        setDraft(next);
        setSavedSnapshot(JSON.stringify(next));
        setSource(body.source ?? source);
        scope.reportSource("automation-settings", body.source);
        window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
        if (!options?.silent) showToast("Communication settings saved.");
        onSaved?.();
        reportSaveStatus({ type: "success" });
        return true;
      } catch (e) {
        // Unconditional — silent only suppresses the SUCCESS toast, never the
        // failure one. A per-control autosave that fails must still surface.
        const message = e instanceof Error ? e.message : "Could not save communication settings.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [demo, draft, isDirty, onSaved, reportSaveStatus, showToast, scope.propertyId, scope.workspaceId, scope.reportSource, source],
  );

  // `save` already checks `isDirty` itself, so it doubles directly as `saveIfDirty` — this is
  // what makes the pending write survive the standalone page's flush-before-switch (`goToArea`)
  // and the modal's `selectTab`/`closeAndSave`, not just this panel's own unmount.
  const saveIfDirty = useCallback((): Promise<boolean> => save({ silent: true }), [save]);
  useImperativeHandle(formRef, () => ({ saveIfDirty }), [saveIfDirty]);

  // Autosaves on close — no explicit Save button in the footer.
  useReportSettingsPanelFooter(onFooterReady, null);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loading || !isDirty) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void save({ silent: true });
    }, 600);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [isDirty, loading, save]);

  // A debounced write still pending when this module goes away (tab switch the host didn't
  // explicitly flush, or leaving Settings outright) must still land — see
  // `useFlushSettingsAutosaveOnUnmount`'s own doc comment for why this has to live here and not
  // one level up.
  useFlushSettingsAutosaveOnUnmount(save, isDirty);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <PortalSettingsSection
      title="Automation"
      action={source ? <PortalSettingsScopeTag variant="muted">{scopeTagLabel(source, scope.propertyIds.length)}</PortalSettingsScopeTag> : null}
    >
      <PortalSettingsGroup>
        <PortalSettingsRow label="Auto-send AI drafts">
          <PortalSettingsToggle
            checked={draft.inboxAiDraftAutoSend}
            onChange={(next) => setDraft((prev) => ({ ...prev, inboxAiDraftAutoSend: next }))}
            label="Auto-send AI drafts"
            disabled={saving}
            dataAttr="communication-inbox-ai-draft-auto-send"
          />
        </PortalSettingsRow>
        {workEmailAudience ? (
          <PortalSettingsRow label="Who can email the assistant">
            <span className="text-[13px] font-medium text-foreground" data-attr="communication-who-can-email-assistant">
              {workEmailAudience}
            </span>
          </PortalSettingsRow>
        ) : null}
        <PortalSettingsRow label="Share my profile phone and email when no work number or work email is set">
          <PortalSettingsToggle
            checked={draft.shareProfileContactWithoutWorkChannel}
            onChange={(next) => setDraft((prev) => ({ ...prev, shareProfileContactWithoutWorkChannel: next }))}
            label="Share my profile phone and email when no work number or work email is set"
            disabled={saving}
            dataAttr="communication-share-profile-contact"
          />
        </PortalSettingsRow>
      </PortalSettingsGroup>
      <ManagerSmsWorkNumberHint
        show={anySmsEnabled && !(smsSetup?.canSend === true && Boolean(smsSetup?.phone))}
        phone={smsSetup?.phone ?? null}
        canSend={smsSetup?.canSend === true}
        className="mt-4 rounded-xl border border-border bg-accent/30 px-3 py-2.5"
      />
      <div className="mt-6 space-y-3">
        <p className="text-[15px] font-bold tracking-[-0.01em] text-foreground">Follow-ups</p>
        <AutomationRuleRows rows={[{ kind: "message_unanswered" }]} />
      </div>
      <div className="mt-6 space-y-3">
        <p className="text-[15px] font-bold tracking-[-0.01em] text-foreground">Messages sent automatically</p>
        <AutomatedMessagesList area="communication" />
      </div>
    </PortalSettingsSection>
  );
}

export const PROPERTY_SETTINGS_AREAS = [
  { value: "applications", label: "Application settings" },
  { value: "lease", label: "Lease settings" },
  { value: "tours", label: "Tour settings" },
] as const;

export type PropertySettingsArea = (typeof PROPERTY_SETTINGS_AREAS)[number]["value"];

/**
 * Read-only "Zillow feed URL" row — one feed per account, registered once
 * with Zillow (Rental Network: Zillow, Trulia, HotPads). The row itself
 * never changes the URL; regenerating the key is out of scope, since a
 * manager who already registered it with Zillow would break that
 * registration. Each listing's own opt-in lives on its Review step.
 */
function ZillowFeedUrlRow() {
  const { showToast } = useAppUi();
  const [feedUrl, setFeedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/manager/syndication-feed", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((body: { feedUrl?: string }) => {
        if (!cancelled && body.feedUrl) setFeedUrl(body.feedUrl);
      })
      .catch(() => {
        /* row simply stays hidden while unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PortalSettingsRow label="Zillow feed URL">
      {feedUrl ? (
        <div className="flex min-w-0 items-center gap-1">
          <span className="max-w-[13rem] truncate text-sm text-muted sm:max-w-[18rem]" title={feedUrl}>
            {feedUrl}
          </span>
          <PortalIconAction
            icon={Copy}
            label="Copy Zillow feed URL"
            data-attr="property-settings-zillow-feed-copy"
            onClick={async () => {
              const ok = await copyTextToClipboard(feedUrl);
              showToast(ok ? "Feed URL copied." : "Could not copy the feed URL.");
            }}
          />
        </div>
      ) : (
        <span className="text-sm text-muted">Loading…</span>
      )}
    </PortalSettingsRow>
  );
}

/**
 * Property settings stay in this tab: pick a house, then Application / Lease /
 * Tour. The host mounts those modules underneath with the house locked, so
 * the chevron rows never leave Settings for the listing.
 */
export function PropertySettingsPanel({
  propertyOptions,
  selectedPropertyId,
  onPropertyIdChange,
  area,
  onAreaChange,
}: {
  propertyOptions?: { id: string; label: string }[];
  selectedPropertyId: string;
  onPropertyIdChange: (propertyId: string) => void;
  area: PropertySettingsArea;
  onAreaChange: (area: PropertySettingsArea) => void;
}) {
  const { userId } = useManagerUserId();
  const workspaces = useWorkspaces();
  const scope = useSettingsPropertyScope();
  const scopedWorkspace = scope.workspaceId
    ? workspaces?.workspaces.find((w) => w.id === scope.workspaceId) ?? null
    : null;
  const workspaceName = scopedWorkspace?.name ?? workspaces?.active?.name;
  const options = useMemo(() => {
    const loaded = buildManagerPropertyFilterOptions(resolveManagerScopeUserId(userId));
    const source = propertyOptions && propertyOptions.length > 0 ? propertyOptions : loaded;
    if (!scope.workspaceId) {
      return unionLabeledPropertyOptions(
        allWorkspacePropertyOptions(workspaces?.workspaces ?? []),
        source,
      );
    }
    const workspace = scopedWorkspace ?? workspaces?.workspaces.find((w) => w.id === scope.workspaceId);
    if (!workspace) return source;
    const fromPayload = propertyOptionsFromWorkspacePayload(workspace);
    const allowed = new Set(fromPayload.map((option) => option.id));
    return unionLabeledPropertyOptions(
      fromPayload,
      source.filter((option) => allowed.has(option.id)),
    );
  }, [propertyOptions, userId, scope.workspaceId, scopedWorkspace, workspaces?.workspaces]);
  useEffect(() => {
    if (selectedPropertyId || !options[0]) return;
    onPropertyIdChange(options[0].id);
  }, [options, selectedPropertyId, onPropertyIdChange]);
  const selected = options.find((house) => house.id === selectedPropertyId);
  const title = selected?.label ?? (workspaceName ? `${workspaceName} houses` : "Houses");

  if (options.length === 0) {
    return (
      <PortalSettingsSection title={title}>
        <PortalSettingsGroup>
          <PortalSettingsRow
            label={workspaceName ? `No houses in ${workspaceName} yet` : "No houses yet"}
          />
        </PortalSettingsGroup>
      </PortalSettingsSection>
    );
  }

  return (
    <PortalSettingsSection title={title}>
      <PortalSettingsGroup>
        <PortalSettingsRow label="House">
          <FieldSingleSelect
            hideLabel
            label="House"
            value={selectedPropertyId || options[0]?.id || ""}
            options={options.map((house) => ({ value: house.id, label: house.label }))}
            onChange={onPropertyIdChange}
            dataAttr="property-settings-house"
          />
        </PortalSettingsRow>
        <PortalSettingsRow label="Settings">
          <FieldSingleSelect
            hideLabel
            label="Settings"
            value={area}
            options={PROPERTY_SETTINGS_AREAS.map((row) => ({ value: row.value, label: row.label }))}
            onChange={(next) => {
              if (next === "applications" || next === "lease" || next === "tours") onAreaChange(next);
            }}
            dataAttr="property-settings-area"
          />
        </PortalSettingsRow>
      </PortalSettingsGroup>
      <PortalSettingsGroup className="mt-4">
        <ZillowFeedUrlRow />
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

/**
 * One autosaving select bound to a single `ManagerAutomationSettings` field —
 * the same PATCH every other automation preference uses (PLAN-0915).
 */
function ManagerAutomationSelectRow<K extends keyof ManagerAutomationSettings>({
  label,
  field,
  options,
  parse,
  dataAttr,
}: {
  label: string;
  field: K;
  options: { value: string; label: string }[];
  parse: (value: string) => ManagerAutomationSettings[K];
  dataAttr: string;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [value, setValue] = useState<ManagerAutomationSettings[K] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS[field]);
        return;
      }
      try {
        const res = await fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown };
        if (!res.ok) throw new Error("Could not load settings.");
        const loaded = normalizeManagerAutomationSettings(body.settings);
        cacheShowUpcomingChargesSetting(loaded.showUpcomingCharges);
        if (!cancelled) setValue(loaded[field]);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load settings.");
        if (!cancelled) setValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS[field]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, field, showToast]);

  const change = async (raw: string) => {
    const next = parse(raw);
    const previous = value;
    setValue(next);
    if (demo) return;
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save settings.");
      const saved = normalizeManagerAutomationSettings(body.settings);
      cacheShowUpcomingChargesSetting(saved.showUpcomingCharges);
      setValue(saved[field]);
      window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      reportSaveStatus({ type: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save settings.";
      setValue(previous);
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
    }
  };

  return (
    <PortalSettingsGroup>
      <PortalSettingsRow label={label}>
        <FieldSingleSelect
          label={label}
          hideLabel
          variant="cell"
          wrapperClassName="w-56"
          options={options}
          value={value === null ? options[0]!.value : String(value)}
          onChange={(next) => void change(next)}
          disabled={value === null}
          dataAttr={dataAttr}
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}

export { DEFAULT_APPLICATION_AUTOMATION, normalizeApplicationAutomation };
