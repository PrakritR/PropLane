"use client";

import { TourInterestSettings } from "./tour-interest-settings";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect, CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsScopeTag,
  PortalSettingsSection,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
  normalizeManagerAutomationSettings,
  normalizeTourReminderMinutesBeforeList,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import {
  MANAGER_COMMUNICATION_SEND_VIA_SECTIONS,
  deliverViaFromManagerSettings,
} from "@/lib/manager-communication-deliver-via";
import {
  ManagerSmsWorkNumberHint,
  ManagerWorkNumberCopyControl,
} from "@/components/portal/pro-sms-work-number-hint";
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

/** Scope tag copy for a property-scoped module's section header. */
function propertyScopeTagLabel(selectedCount: number): string {
  if (selectedCount === 0) return "No properties selected";
  if (selectedCount === 1) return "1 property";
  return `${selectedCount} properties`;
}

/**
 * The FIRST row of a per-property module's settings group: which properties
 * the automation below actually applies to. Multi-select (Applications) or
 * single-select (Lease) render the same "Applies to" row so scope is never
 * buried mid-panel.
 *
 * When `propertyOptions` is empty this renders an honest explanation instead
 * of a picker that looks live but can never select anything — the standalone
 * `/portal/settings/applications` and `/portal/settings/lease` pages
 * currently reach this with an empty list (see `ApplicationsSettingsPanel`'s
 * and `LeaseSettingsPanel`'s own doc comments for why that gap could not be
 * closed from this file).
 */
function PropertyScopeRow({
  multiSelect,
  propertyOptions,
  selectedIds,
  onPropertyIdChange,
  onPropertyIdsChange,
  disabled,
}: {
  multiSelect: boolean;
  propertyOptions: { id: string; label: string }[];
  selectedIds: string[];
  onPropertyIdChange?: (propertyId: string) => void;
  onPropertyIdsChange?: (propertyIds: string[]) => void;
  disabled: boolean;
}) {
  const noOptions = propertyOptions.length === 0;

  return (
    <PortalSettingsRow
      className="flex-wrap items-start gap-y-2.5"
      label="Applies to"
      meta={
        noOptions
          ? "Add a property listing before configuring these settings."
          : multiSelect
            ? "The settings below apply only to the properties checked here."
            : "The settings below apply only to this property."
      }
    >
      {noOptions ? null : multiSelect ? (
        <CheckboxMultiSelect
          label="Properties"
          hideLabel
          options={propertyOptions.map((option) => ({ value: option.id, label: option.label }))}
          selected={selectedIds}
          onChange={onPropertyIdsChange ?? (() => {})}
          disabled={disabled}
          emptyLabel="Select properties…"
          searchPlaceholder="Search properties…"
          dataAttr="manager-settings-properties"
          className="w-56"
          menuFooter={
            <div className="flex gap-2">
              <button
                type="button"
                className="text-xs font-semibold text-primary hover:underline"
                data-attr="manager-settings-properties-select-all"
                disabled={disabled}
                onClick={() => onPropertyIdsChange?.(propertyOptions.map((option) => option.id))}
              >
                Select all
              </button>
              <button
                type="button"
                className="text-xs font-semibold text-muted hover:underline"
                data-attr="manager-settings-properties-clear"
                disabled={disabled || selectedIds.length === 0}
                onClick={() => onPropertyIdsChange?.([])}
              >
                Clear
              </button>
            </div>
          }
        />
      ) : (
        <FieldSingleSelect
          label="Property"
          hideLabel
          value={selectedIds[0] ?? ""}
          options={propertyOptions.map((option) => ({ value: option.id, label: option.label }))}
          onChange={onPropertyIdChange ?? (() => {})}
          disabled={disabled}
          dataAttr="manager-settings-property"
          wrapperClassName="w-56"
        />
      )}
    </PortalSettingsRow>
  );
}

/**
 * The standalone `/portal/settings/applications` host (`portal-settings-section-client.tsx`,
 * off limits to this file) never fetches or passes `propertyOptions`, so it always reaches
 * this component with an empty list even when the manager has properties — the gear on a
 * property's own Application tab passes real options and hides this row entirely
 * (`hidePropertyField`). Closing that gap means fetching properties in `portal-settings-section-client.tsx`
 * or `settings-module-page.tsx`, both outside this file's ownership; `PropertyScopeRow` above
 * renders the honest "add a property listing" explanation rather than a picker that always
 * looks empty.
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
  hidePropertyField = false,
  teamMembers = [],
  reminderFormRef,
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
  /** When opened from one property's Application tab, the house is already known. */
  hidePropertyField?: boolean;
  teamMembers?: WorkAssignmentTeamMember[];
  reminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const multiSelect = Boolean(onPropertyIdsChange);
  const selectedIds = propertyIds ?? (propertyId ? [propertyId] : []);
  const hasSelection = selectedIds.length > 0;
  const disabled = loading || saving;

  return (
    <div className="space-y-6">
      <PortalSettingsSection
        title="Applications"
        description="Automation for approving applications and waiving the application fee."
        action={<PortalSettingsScopeTag>{propertyScopeTagLabel(selectedIds.length)}</PortalSettingsScopeTag>}
      >
        <PortalSettingsGroup>
          {hidePropertyField ? null : (
            <PropertyScopeRow
              multiSelect={multiSelect}
              propertyOptions={propertyOptions}
              selectedIds={selectedIds}
              onPropertyIdChange={onPropertyIdChange}
              onPropertyIdsChange={onPropertyIdsChange}
              disabled={disabled || propertyOptions.length === 0}
            />
          )}
          {onWaiverCodeChange ? (
            <PortalSettingsRow
              label="Promo code"
              meta={
                selectedIds.length > 1
                  ? `Applicants who enter this code on any of the ${selectedIds.length} selected properties waive the application fee. Leave empty to turn it off for those listings.`
                  : "Applicants who enter this code on this property's application waive the application fee. Leave empty to turn it off."
              }
            >
              <input
                id="manager-application-promo-code"
                type="text"
                className="w-32 rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm uppercase text-foreground sm:w-40"
                value={waiverCode}
                disabled={disabled || !hasSelection}
                placeholder="E.G. WELCOME50"
                data-attr="manager-application-settings-promo-code"
                onChange={(e) => onWaiverCodeChange(e.target.value.toUpperCase())}
                onBlur={() => onWaiverCodeCommit?.()}
              />
            </PortalSettingsRow>
          ) : null}
          <PortalSettingsRow
            label="Auto-approve applications"
            meta={
              "Approve a submitted application without reviewing it first. Withdrawn applications are never approved." +
              (selectedIds.length > 1 ? " Applies to every selected property." : "")
            }
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

      <PortalSettingsSection
        title="Reminders"
        description="Nudge applicants to finish, alert yourself when one stalls, or follow up after a tour."
        action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
      >
        <ApplicationRemindersSettingsBundle
          teamMembers={teamMembers}
          formRef={reminderFormRef}
          disabled={loading || saving}
        />
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automation, setAutomation] = useState<LifecycleTaskAutomation>(DEFAULT_LIFECYCLE_AUTOMATION);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(DEFAULT_LIFECYCLE_AUTOMATION));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) {
            setAutomation(DEFAULT_LIFECYCLE_AUTOMATION);
            setSavedSnapshot(JSON.stringify(DEFAULT_LIFECYCLE_AUTOMATION));
          }
          return;
        }
        const res = await fetch("/api/portal/task-automation-settings", { credentials: "include", cache: "no-store" });
        if (!res.ok) throw new Error("Could not load task settings.");
        const body = (await res.json()) as { automation?: LifecycleTaskAutomation };
        const next = body.automation ?? DEFAULT_LIFECYCLE_AUTOMATION;
        if (!cancelled) {
          setAutomation(next);
          setSavedSnapshot(JSON.stringify(next));
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load task settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

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
          body: JSON.stringify({ automation }),
          // A hard page unload (real reload/close, not a same-app route change) can abort an
          // ordinary in-flight fetch before it lands — this is exactly the write the
          // `pagehide`/`visibilitychange` flush in `settings-module-page.tsx` exists to send;
          // `keepalive` is what lets the browser actually finish it after the document goes away.
          keepalive: true,
        });
        const body = (await res.json().catch(() => ({}))) as { automation?: LifecycleTaskAutomation; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not save task settings.");
        const next = body.automation ?? automation;
        setAutomation(next);
        setSavedSnapshot(JSON.stringify(next));
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
    [automation, demo, isDirty, onSaved, reportSaveStatus, showToast],
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
      <PortalSettingsSection
        title="Task reminders"
        description="Nudge the assignee before a task is due, or after it lapses."
        action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
      >
        <ManagerReminderRuleSettingsPanel
          kind="task"
          audienceMode="manager"
          teamMembers={teamMembers}
          formRef={reminderFormRef}
          disabled={saving}
        />
      </PortalSettingsSection>

      <PortalSettingsSection
        title="Lifecycle automation"
        description="Auto-create and auto-assign the routine tasks that follow an application, lease, or inspection."
        action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
      >
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
 * See `ApplicationsSettingsPanel`'s doc comment above `PropertyScopeRow` —
 * the same standalone-host `propertyOptions` gap applies here and is
 * likewise not fixable from this file.
 */
export function LeaseSettingsPanel({
  automation,
  loading,
  saving,
  propertyOptions,
  propertyId,
  onPropertyIdChange,
  onAutomationChange,
  hidePropertyField = false,
  teamMembers = [],
  reminderFormRef,
}: {
  automation: ApplicationAutomationPreferences;
  loading: boolean;
  saving: boolean;
  propertyOptions: { id: string; label: string }[];
  propertyId: string;
  onPropertyIdChange: (propertyId: string) => void;
  onAutomationChange: (next: ApplicationAutomationPreferences) => void;
  hidePropertyField?: boolean;
  teamMembers?: WorkAssignmentTeamMember[];
  reminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const disabled = loading || saving;
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
        title="Lease"
        description="After you approve an application, PropLane can build and send the lease for you. Every safety check that applies when you do this manually still applies. The landlord named on generated leases comes from your full name in Settings → Profile."
        action={<PortalSettingsScopeTag>{propertyScopeTagLabel(propertyId ? 1 : 0)}</PortalSettingsScopeTag>}
      >
        <PortalSettingsGroup>
          {hidePropertyField ? null : (
            <PropertyScopeRow
              multiSelect={false}
              propertyOptions={propertyOptions}
              selectedIds={propertyId ? [propertyId] : []}
              onPropertyIdChange={onPropertyIdChange}
              disabled={disabled || propertyOptions.length === 0}
            />
          )}
          {LEASE_TOGGLE_ROWS.map(({ step, label, meta }) => (
            <PortalSettingsRow key={step} label={label} meta={meta}>
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

      <PortalSettingsSection
        title="Reminders"
        description="Nudge residents to sign, or alert yourself when a lease needs attention."
        action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
      >
        <LeaseRemindersSettingsBundle
          teamMembers={teamMembers}
          formRef={reminderFormRef}
          disabled={loading || saving}
        />
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
    <PortalSettingsSection
      title="Services"
      description="Reminders before a scheduled service visit or an add-on service return date."
      action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
    >
      <ServiceRemindersSettingsBundle
        teamMembers={teamMembers}
        workOrderFormRef={workOrderReminderFormRef}
        serviceOrderFormRef={serviceOrderReminderFormRef}
      />
    </PortalSettingsSection>
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
    <PortalSettingsSection
      title="Inspections"
      description="Reminders around a move-in or move-out condition report."
      action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
    >
      <InspectionRemindersSettingsBundle
        teamMembers={teamMembers}
        dueFormRef={dueReminderFormRef}
        reviewFormRef={reviewReminderFormRef}
      />
    </PortalSettingsSection>
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
    <PortalSettingsSection
      title="Bookings"
      description="Nudge yourself before a booking on your calendar. An imported channel booking carries no guest contact, so there is no resident-facing reminder here."
      action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
    >
      <ManagerReminderRuleSettingsPanel
        kind="booking"
        audienceMode="manager"
        teamMembers={teamMembers}
        formRef={reminderFormRef}
      />
    </PortalSettingsSection>
  );
}

/**
 * Resident settings has no controls of its own today: portfolio-wide payment
 * reminder presets live under Payments settings, and a single household's
 * reminders are customized from that resident's own Payments tab — there is
 * no portfolio-wide resident preference to hold on this module yet. Redrawn
 * to say that plainly on the kit (a scope tag plus two pointer rows) rather
 * than leave an unexplained blank panel. Revisit this once a real
 * resident-scoped preference exists to configure.
 */
export function ResidentSettingsPanel() {
  return (
    <PortalSettingsSection
      title="Residents"
      description="This module has no settings of its own yet — resident-facing reminders live with the settings they belong to."
      action={<PortalSettingsScopeTag variant="muted">Informational</PortalSettingsScopeTag>}
    >
      <PortalSettingsGroup>
        <PortalSettingsRow
          label="Payment reminder presets"
          meta="Portfolio-wide payment reminder presets live under Payments settings."
        />
        <PortalSettingsRow
          label="One household's reminders"
          meta="Open that resident and use Reminders on their Payments tab to customize just their household."
        />
      </PortalSettingsGroup>
    </PortalSettingsSection>
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
      const message = "Choose at least one channel under Tour reminders → Send via.";
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
        <PortalSettingsSection
          title="Tour booking"
          description="How prospects book a tour on your calendar."
          action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
        >
          <PortalSettingsGroup>
            <PortalSettingsRow
              label="Notice required"
              meta="Tours can't be booked less than this many days out — same-day requests stay hidden until this window passes."
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
              meta="Tours book straight into your calendar without asking you first."
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

        <PortalSettingsSection
          title="Tour reminders"
          description="Nudge either the prospect before their tour, or yourself before tours on your calendar."
          action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
        >
          <div className="space-y-4">
            <ReminderTypePicker
              value={tourReminderType}
              options={[
                {
                  value: "guest",
                  label: "Guest tour reminders",
                  description: "Sent to prospects before their scheduled tour.",
                },
                {
                  value: "manager",
                  label: "Your tour reminders",
                  description: "Nudges you before tours on your calendar.",
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
 * Payments settings IS the reminder schedule — there is no second thing here.
 *
 * This tab was four radio presets (Basics / Standard / Gentle / Due date only)
 * writing the very same `/api/portal/automation-settings` fields the Payments
 * page's separate Reminders dialog wrote through a chip picker. Two dialogs,
 * one setting, each able to silently undo the other.
 *
 * The presets went rather than the chips: they asked the manager to choose
 * between named bundles instead of just saying when to remind, and could only
 * express four of the arrangements the chips express directly.
 */
export function PaymentsSettingsPanel({
  onSaved,
  onFooterReady,
  formRef,
  mode = "incoming",
  teamMembers = [],
  outgoingReminderFormRef,
}: {
  onSaved?: () => void;
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  formRef?: React.Ref<PaymentAutomationSettingsHandle>;
  /** Incoming = resident rent reminders; outgoing = manager payee reminders. */
  mode?: "incoming" | "outgoing";
  teamMembers?: WorkAssignmentTeamMember[];
  outgoingReminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  useReportSettingsPanelFooter(onFooterReady, null);

  if (mode === "outgoing") {
    return (
      <PortalSettingsSection
        title="Payments"
        description="Nudge yourself before a bill you owe is due — never sent to payees."
        action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
      >
        <OutgoingPaymentRemindersSettingsBundle
          teamMembers={teamMembers}
          formRef={outgoingReminderFormRef}
        />
      </PortalSettingsSection>
    );
  }

  return (
    <PortalSettingsSection
      title="Payments"
      description="Remind residents before rent is due, and alert yourself when it's still unpaid."
      action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
    >
      <IncomingPaymentRemindersSettingsBundle
        teamMembers={teamMembers}
        onSaved={onSaved}
        formRef={formRef}
      />
    </PortalSettingsSection>
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(DEFAULT_MANAGER_AUTOMATION_SETTINGS));
  const [smsSetup, setSmsSetup] = useState<{ phone: string | null; canSend: boolean } | null>(null);

  const anySmsEnabled = useMemo(
    () =>
      MANAGER_COMMUNICATION_SEND_VIA_SECTIONS.some(
        (section) => deliverViaFromManagerSettings(draft, section.kind).viaSms,
      ),
    [draft],
  );

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
          }
          return;
        }
        const [settingsRes, numberRes] = await Promise.all([
          fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" }),
          fetch("/api/manager/messaging-number", { credentials: "include", cache: "no-store" }).catch(
            () => null,
          ),
        ]);
        if (!settingsRes.ok) throw new Error("Could not load communication settings.");
        const body = (await settingsRes.json()) as { settings: ManagerAutomationSettings };
        const nextSettings = normalizeManagerAutomationSettings(body.settings);
        if (!cancelled) {
          setDraft(nextSettings);
          setSavedSnapshot(JSON.stringify(nextSettings));
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
  }, [demo, showToast]);

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
          body: JSON.stringify({ inboxAiDraftAutoSend: draft.inboxAiDraftAutoSend }),
          // A hard page unload can abort an ordinary in-flight fetch before it lands — exactly
          // the write the `pagehide`/`visibilitychange` flush in `settings-module-page.tsx`
          // exists to send.
          keepalive: true,
        });
        const body = (await res.json().catch(() => ({}))) as {
          settings?: ManagerAutomationSettings;
          error?: string;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not save communication settings.");
        const next = body.settings ? normalizeManagerAutomationSettings(body.settings) : draft;
        setDraft(next);
        setSavedSnapshot(JSON.stringify(next));
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
    [demo, draft, isDirty, onSaved, reportSaveStatus, showToast],
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
      title="Communication"
      description="What is genuinely specific to Communication — per-event channel choice now lives with each event's own reminder."
      action={<PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>}
    >
      <PortalSettingsGroup>
        <PortalSettingsRow
          label="Auto-send AI drafts"
          meta="When PropLane AI finishes a draft reply, send it without waiting for Approve. The same toggle appears on each draft card in your inbox."
        >
          <PortalSettingsToggle
            checked={draft.inboxAiDraftAutoSend}
            onChange={(next) => setDraft((prev) => ({ ...prev, inboxAiDraftAutoSend: next }))}
            label="Auto-send AI drafts"
            disabled={saving}
            dataAttr="communication-inbox-ai-draft-auto-send"
          />
        </PortalSettingsRow>
      </PortalSettingsGroup>
      {smsSetup?.phone ? (
        <ManagerWorkNumberCopyControl
          phone={smsSetup.phone}
          className="mt-4 rounded-xl border border-border bg-accent/30 px-3 py-2.5"
          dataAttr="communication-work-number-copy"
        />
      ) : null}
      <ManagerSmsWorkNumberHint
        show={anySmsEnabled && !(smsSetup?.canSend === true && Boolean(smsSetup?.phone))}
        phone={smsSetup?.phone ?? null}
        canSend={smsSetup?.canSend === true}
        className="mt-4 rounded-xl border border-border bg-accent/30 px-3 py-2.5"
      />
    </PortalSettingsSection>
  );
}

export { DEFAULT_APPLICATION_AUTOMATION, normalizeApplicationAutomation };
