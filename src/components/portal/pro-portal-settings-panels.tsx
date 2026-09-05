"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
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
  patchDeliverViaForKind,
} from "@/lib/manager-communication-deliver-via";
import {
  ManagerSmsWorkNumberHint,
  ManagerWorkNumberCopyControl,
} from "@/components/portal/pro-sms-work-number-hint";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";
import {
  PAYMENT_REMINDER_PRESETS,
  applyReminderPreset,
  detectReminderPreset,
  type ReminderPresetId,
} from "@/lib/payment-reminder-presets";
import { DEFAULT_MANAGER_TOUR_SETTINGS, type ManagerTourSettings } from "@/lib/manager-tour-settings";
import { TOUR_NOTICE_DAY_SELECT_OPTIONS } from "@/lib/tour-notice-labels";
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
  ServiceRemindersSettingsBundle,
} from "@/components/portal/reminder-settings-bundles";
import { ReminderTypePicker } from "@/components/portal/reminder-type-picker";
import { TaskAutomationSettingsFields } from "@/components/portal/task-automation-settings-fields";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import {
  DEFAULT_LIFECYCLE_AUTOMATION,
  type LifecycleTaskAutomation,
} from "@/lib/task-lifecycle-automation";

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

export function ApplicationsSettingsPanel({
  automation,
  loading,
  saving,
  propertyOptions,
  propertyId,
  onPropertyIdChange,
  onAutomationChange,
  waiverCode = "",
  onWaiverCodeChange,
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
  waiverCode?: string;
  onWaiverCodeChange?: (code: string) => void;
  /** When opened from one property's Application tab, the house is already known. */
  hidePropertyField?: boolean;
  teamMembers?: WorkAssignmentTeamMember[];
  reminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  return (
    <div className="space-y-6">
      {hidePropertyField ? null : (
        <ManagerSettingsPropertyField
          propertyOptions={propertyOptions}
          propertyId={propertyId}
          onPropertyIdChange={onPropertyIdChange}
          disabled={loading || saving || propertyOptions.length === 0}
        />
      )}
      {onWaiverCodeChange ? (
        <div className="space-y-2">
          <label className="block text-[13px] font-medium text-foreground" htmlFor="manager-application-promo-code">
            Promo code
          </label>
          <input
            id="manager-application-promo-code"
            type="text"
            className="w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm uppercase text-foreground"
            value={waiverCode}
            disabled={loading || saving || !propertyId}
            placeholder="E.G. WELCOME50"
            data-attr="manager-application-settings-promo-code"
            onChange={(e) => onWaiverCodeChange(e.target.value.toUpperCase())}
          />
          <p className="text-xs text-muted">
            Applicants who enter this code on this property&apos;s application waive the application fee. Leave
            empty to turn it off.
          </p>
        </div>
      ) : null}
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={automation.autoApproveApplications}
          disabled={loading || saving}
          data-attr="manager-application-automation-autoApproveApplications"
          // No confirm() gate. The consequence is stated under the label and
          // again in the banner once it is on, and the setting is one click to
          // undo — a browser dialog restating the caption is a step to click
          // past, not a safeguard.
          onChange={(e) =>
            onAutomationChange({ ...automation, autoApproveApplications: e.target.checked })
          }
        />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-foreground">Auto-approve applications</span>
          <span className="block text-xs text-muted">
            Approve a submitted application without reviewing it first. Withdrawn applications are never approved.
          </span>
        </span>
      </label>
      {automation.autoApproveApplications ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-foreground">
          Auto-approve is on for this property. New submissions are approved without a manual review step.
        </p>
      ) : null}
      <ApplicationRemindersSettingsBundle
        teamMembers={teamMembers}
        formRef={reminderFormRef}
        disabled={loading || saving}
      />
    </div>
  );
}

export function TaskSettingsPanel({
  teamMembers,
  onFooterReady,
  onSaved,
  reminderFormRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  onSaved?: () => void;
  reminderFormRef?: React.Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automation, setAutomation] = useState<LifecycleTaskAutomation>(DEFAULT_LIFECYCLE_AUTOMATION);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) setAutomation(DEFAULT_LIFECYCLE_AUTOMATION);
          return;
        }
        const res = await fetch("/api/portal/task-automation-settings", { credentials: "include", cache: "no-store" });
        if (!res.ok) throw new Error("Could not load task settings.");
        const body = (await res.json()) as { automation?: LifecycleTaskAutomation };
        if (!cancelled) setAutomation(body.automation ?? DEFAULT_LIFECYCLE_AUTOMATION);
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

  const save = useCallback(async () => {
    setSaving(true);
    try {
      if (demo) {
        showToast("Task settings saved (demo).");
        onSaved?.();
        return;
      }
      const res = await fetch("/api/portal/task-automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automation }),
      });
      const body = (await res.json().catch(() => ({}))) as { automation?: LifecycleTaskAutomation; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save task settings.");
      if (body.automation) setAutomation(body.automation);
      showToast("Task settings saved.");
      onSaved?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save task settings.");
    } finally {
      setSaving(false);
    }
  }, [automation, demo, onSaved, showToast]);

  const triggerSave = useCallback(() => {
    void save();
  }, [save]);

  const footerState = useMemo(
    (): ManagerSettingsPanelFooter | null =>
      loading
        ? null
        : {
            saving,
            onSave: triggerSave,
            dataAttr: "manager-task-automation-save",
          },
    [loading, saving, triggerSave],
  );

  useReportSettingsPanelFooter(onFooterReady, footerState);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-6">
      <ManagerReminderRuleSettingsPanel
        kind="task"
        audienceMode="manager"
        sectionTitle="Task reminders"
        teamMembers={teamMembers}
        formRef={reminderFormRef}
        disabled={saving}
      />
      <div className="border-t border-border pt-4">
        <p className="mb-3 text-[13.5px] font-semibold text-foreground">Lifecycle automation</p>
        <TaskAutomationSettingsFields
          automation={automation}
          teamMembers={teamMembers}
          loading={loading}
          saving={saving}
          onChange={setAutomation}
        />
      </div>
    </div>
  );
}

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
  return (
    <div className="space-y-6">
      {hidePropertyField ? null : (
        <ManagerSettingsPropertyField
          propertyOptions={propertyOptions}
          propertyId={propertyId}
          onPropertyIdChange={onPropertyIdChange}
          disabled={loading || saving || propertyOptions.length === 0}
        />
      )}
      <p className="text-xs text-muted">
        After you approve an application, PropLane can build and send the lease for you. Every safety check
        that applies when you do this manually still applies. The landlord named on generated leases comes
        from your full name in Settings → Profile.
      </p>
      {(
        [
          {
            step: "autoGenerateLease" as const,
            label: "Auto-generate the lease on approval",
            hint: "Build the lease document as soon as an application is approved.",
          },
          {
            step: "autoSendLease" as const,
            label: "Auto-send the lease to the resident",
            hint: "Send the generated lease for signature when it is ready.",
          },
        ] as const
      ).map(({ step, label, hint }) => (
        <label key={step} className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={automation[step]}
            disabled={loading || saving}
            data-attr={`manager-application-automation-${step}`}
            onChange={(e) => onAutomationChange({ ...automation, [step]: e.target.checked })}
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-foreground">{label}</span>
            <span className="block text-xs text-muted">{hint}</span>
          </span>
        </label>
      ))}
      <LeaseRemindersSettingsBundle
        teamMembers={teamMembers}
        formRef={reminderFormRef}
        disabled={loading || saving}
      />
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
    <ServiceRemindersSettingsBundle
      teamMembers={teamMembers}
      workOrderFormRef={workOrderReminderFormRef}
      serviceOrderFormRef={serviceOrderReminderFormRef}
    />
  );
}

export function ResidentSettingsPanel() {
  return (
    <p className="text-sm text-muted">
      Portfolio-wide payment reminder presets live under Payments settings. To customize reminders for one
      household, open that resident and use Reminders on their Payments tab.
    </p>
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
      showToast("Choose at least one tour reminder timing.");
      return false;
    }
    if (
      automation.tourReminderDeliverViaInbox === false &&
      automation.tourReminderDeliverViaEmail === false &&
      automation.tourReminderDeliverViaSms !== true
    ) {
      showToast("Choose at least one channel under Tour reminders → Send via.");
      return false;
    }
    setSaving(true);
    try {
      if (demo) {
        if (!options?.silent) showToast("Tour settings saved (demo).");
        onSaved?.();
        return true;
      }
      const [tourRes, autoRes] = await Promise.all([
        fetch("/api/portal/manager-tour-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tourSettings),
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
        }),
      ]);
      if (!tourRes.ok || !autoRes.ok) throw new Error("Could not save calendar settings.");
      window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      setSavedTourSettings(tourSettings);
      setSavedAutomationSnapshot(tourAutomationSnapshot(automation));
      if (!options?.silent) showToast("Tour settings saved.");
      onSaved?.();
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save tour settings.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [automation, demo, onSaved, showToast, tourSettings]);

  const saveIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    return save({ silent: true });
  }, [isDirty, save]);

  useImperativeHandle(formRef, () => ({ saveIfDirty }), [saveIfDirty]);

  // Autosaves on close — no explicit Save button in the modal footer.
  useReportSettingsPanelFooter(onFooterReady, null);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <>
      <div className="space-y-5">
        <div className="space-y-2">
          <FieldSingleSelect
            label="Notice required"
            value={String(tourSettings.tourNoticeDays)}
            options={TOUR_NOTICE_DAY_SELECT_OPTIONS.map((opt) => ({
              value: String(opt.value),
              label: opt.label,
            }))}
            onChange={(value) =>
              setTourSettings((prev) => ({
                ...prev,
                tourNoticeDays: Number.parseInt(value, 10) || 0,
              }))
            }
            dataAttr="manager-tour-notice-days"
          />
        </div>

        <label className="flex items-start gap-3 border-t border-border pt-4">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={automation.proposeTourConfirmations}
            data-attr="manager-tour-auto-confirm-proposals"
            onChange={(e) => setAutomation((prev) => ({ ...prev, proposeTourConfirmations: e.target.checked }))}
          />
          <span className="min-w-0 text-[13px] font-medium text-foreground">Auto confirm tours</span>
        </label>

        <div className="space-y-4 border-t border-border pt-4">
          <p className="text-[13.5px] font-semibold text-foreground">Tour reminders</p>
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
      </div>

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
        onSave={(next) => {
          setAutomation((prev) => ({
            ...prev,
            templates: { ...prev.templates, tourReminder: next },
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
      <OutgoingPaymentRemindersSettingsBundle
        teamMembers={teamMembers}
        formRef={outgoingReminderFormRef}
      />
    );
  }

  return (
    <IncomingPaymentRemindersSettingsBundle
      teamMembers={teamMembers}
      onSaved={onSaved}
      formRef={formRef}
    />
  );
}

export function CommunicationSettingsPanel({
  onSaved,
  onFooterReady,
}: {
  onSaved?: () => void;
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
  const [smsSetup, setSmsSetup] = useState<{ phone: string | null; canSend: boolean } | null>(null);
  const [activeSendViaSectionId, setActiveSendViaSectionId] = useState<
    (typeof MANAGER_COMMUNICATION_SEND_VIA_SECTIONS)[number]["id"]
  >(MANAGER_COMMUNICATION_SEND_VIA_SECTIONS[0].id);

  const activeSendViaSection = useMemo(
    () =>
      MANAGER_COMMUNICATION_SEND_VIA_SECTIONS.find((section) => section.id === activeSendViaSectionId) ??
      MANAGER_COMMUNICATION_SEND_VIA_SECTIONS[0],
    [activeSendViaSectionId],
  );

  const sendViaSectionOptions = useMemo(
    () =>
      MANAGER_COMMUNICATION_SEND_VIA_SECTIONS.map((section) => ({
        value: section.id,
        label: section.label,
      })),
    [],
  );

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
        if (!cancelled) setDraft(normalizeManagerAutomationSettings(body.settings));
        if (!cancelled) {
          const status =
            numberRes && numberRes.ok
              ? ((await numberRes.json()) as ManagerMessagingNumberStatus)
              : null;
          setSmsSetup(
            status
              ? {
                  phone: typeof status.number?.phoneNumber === "string"
                    ? status.number.phoneNumber.trim() || null
                    : null,
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

  const save = useCallback(async () => {
    for (const section of MANAGER_COMMUNICATION_SEND_VIA_SECTIONS) {
      const channels = deliverViaFromManagerSettings(draft, section.kind);
      const allowsInbox = section.kind === "payment_reminder" || section.kind === "tour_reminder";
      const hasChannel =
        channels.viaEmail ||
        channels.viaSms ||
        (allowsInbox && channels.viaInbox !== false);
      if (!hasChannel) {
        showToast(`Choose at least one channel under ${section.label}.`);
        return;
      }
    }
    setSaving(true);
    try {
      if (demo) {
        showToast("Communication settings saved (demo).");
        onSaved?.();
        return;
      }
      const res = await fetch("/api/portal/automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inboxDefaultDeliverViaEmail: draft.inboxDefaultDeliverViaEmail,
          inboxDefaultDeliverViaSms: draft.inboxDefaultDeliverViaSms,
          messagesDeliverViaEmail: draft.messagesDeliverViaEmail,
          messagesDeliverViaSms: draft.messagesDeliverViaSms,
          leasesDeliverViaEmail: draft.leasesDeliverViaEmail,
          leasesDeliverViaSms: draft.leasesDeliverViaSms,
          applicationsDeliverViaEmail: draft.applicationsDeliverViaEmail,
          applicationsDeliverViaSms: draft.applicationsDeliverViaSms,
          maintenanceDeliverViaEmail: draft.maintenanceDeliverViaEmail,
          maintenanceDeliverViaSms: draft.maintenanceDeliverViaSms,
          paymentReminderDeliverViaEmail: draft.paymentReminderDeliverViaEmail,
          paymentReminderDeliverViaSms: draft.paymentReminderDeliverViaSms,
          paymentReminderDeliverViaInbox: draft.paymentReminderDeliverViaInbox,
          tourReminderDeliverViaEmail: draft.tourReminderDeliverViaEmail,
          tourReminderDeliverViaSms: draft.tourReminderDeliverViaSms,
          tourReminderDeliverViaInbox: draft.tourReminderDeliverViaInbox,
          inboxAiDraftAutoSend: draft.inboxAiDraftAutoSend,
        }),
      });
      if (!res.ok) throw new Error("Could not save communication settings.");
      window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      showToast("Communication settings saved.");
      onSaved?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save communication settings.");
    } finally {
      setSaving(false);
    }
  }, [demo, draft, onSaved, showToast]);

  const triggerSave = useCallback(() => {
    void save();
  }, [save]);

  const footerState = useMemo(
    (): ManagerSettingsPanelFooter | null =>
      loading
        ? null
        : {
            saving,
            onSave: triggerSave,
            dataAttr: "communication-settings-save",
          },
    [loading, saving, triggerSave],
  );

  useReportSettingsPanelFooter(onFooterReady, footerState);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-5">
      {smsSetup?.phone ? (
        <ManagerWorkNumberCopyControl
          phone={smsSetup.phone}
          className="rounded-xl border border-border bg-accent/30 px-3 py-2.5"
          dataAttr="communication-work-number-copy"
        />
      ) : null}
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={draft.inboxAiDraftAutoSend}
          onChange={(e) => {
            setDraft((prev) => ({ ...prev, inboxAiDraftAutoSend: e.target.checked }));
          }}
          data-attr="communication-inbox-ai-draft-auto-send"
        />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-foreground">Auto-send AI drafts</span>
          <span className="block text-xs text-muted">
            When PropLane AI finishes a draft reply, send it without waiting for Approve. The same toggle appears on
            each draft card in your inbox.
          </span>
        </span>
      </label>
      <ManagerSmsWorkNumberHint
        show={anySmsEnabled && !(smsSetup?.canSend === true && Boolean(smsSetup?.phone))}
        phone={smsSetup?.phone ?? null}
        canSend={smsSetup?.canSend === true}
        className="rounded-xl border border-border bg-accent/30 px-3 py-2.5"
      />
      <div className="space-y-3 border-t border-border pt-4">
        <FieldSingleSelect
          label="Send via for"
          value={activeSendViaSection.id}
          options={sendViaSectionOptions}
          onChange={(value) => {
            const match = MANAGER_COMMUNICATION_SEND_VIA_SECTIONS.find((section) => section.id === value);
            if (match) setActiveSendViaSectionId(match.id);
          }}
          dataAttr="communication-send-via-category"
        />
        <ReminderSendViaField
          showProplaneChannel={
            activeSendViaSection.kind === "payment_reminder" || activeSendViaSection.kind === "tour_reminder"
          }
          viaInbox={deliverViaFromManagerSettings(draft, activeSendViaSection.kind).viaInbox}
          viaEmail={deliverViaFromManagerSettings(draft, activeSendViaSection.kind).viaEmail}
          viaSms={deliverViaFromManagerSettings(draft, activeSendViaSection.kind).viaSms}
          smsLabel={
            activeSendViaSection.kind === "payment_reminder"
              ? "SMS (when resident opted in)"
              : activeSendViaSection.kind === "tour_reminder"
                ? "SMS (when guest opted in)"
                : "SMS"
          }
          onChange={({ viaEmail, viaSms, viaInbox }) =>
            setDraft((prev) =>
              patchDeliverViaForKind(prev, activeSendViaSection.kind, { viaEmail, viaSms, viaInbox }),
            )
          }
          dataAttr={`communication-${activeSendViaSection.id}-send-via`}
        />
      </div>
    </div>
  );
}

export { DEFAULT_APPLICATION_AUTOMATION, normalizeApplicationAutomation };
