"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "@/components/portal/manager-sms-work-number-hint";
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
}) {
  const confirmAutoApproveEnable = () =>
    window.confirm(
      "Auto-approve will approve submitted applications without manual review, creating resident accounts and approval-time charges. Withdrawn applications are still skipped.\n\nTurn on auto-approve?",
    );

  return (
    <div className="space-y-4">
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
          onChange={(e) => {
            const next = e.target.checked;
            if (next && !confirmAutoApproveEnable()) return;
            onAutomationChange({ ...automation, autoApproveApplications: next });
          }}
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
    </div>
  );
}

export function TaskSettingsPanel({
  teamMembers,
  onFooterReady,
  onSaved,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
  onSaved?: () => void;
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
    <TaskAutomationSettingsFields
      automation={automation}
      teamMembers={teamMembers}
      loading={loading}
      saving={saving}
      onChange={setAutomation}
    />
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
}: {
  automation: ApplicationAutomationPreferences;
  loading: boolean;
  saving: boolean;
  propertyOptions: { id: string; label: string }[];
  propertyId: string;
  onPropertyIdChange: (propertyId: string) => void;
  onAutomationChange: (next: ApplicationAutomationPreferences) => void;
  hidePropertyField?: boolean;
}) {
  return (
    <div className="space-y-4">
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
    </div>
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
}: {
  onSaved?: () => void;
  onFooterReady?: (footer: ManagerSettingsPanelFooter | null) => void;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tourSettings, setTourSettings] = useState<ManagerTourSettings>(DEFAULT_MANAGER_TOUR_SETTINGS);
  const [automation, setAutomation] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
  const [messageModalOpen, setMessageModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) {
            setTourSettings(DEFAULT_MANAGER_TOUR_SETTINGS);
            setAutomation(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
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
          setTourSettings(tourBody.settings ?? DEFAULT_MANAGER_TOUR_SETTINGS);
          setAutomation(autoBody.settings ?? DEFAULT_MANAGER_AUTOMATION_SETTINGS);
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

  const save = useCallback(async () => {
    const minutesBeforeList = normalizeTourReminderMinutesBeforeList(
      automation.tourReminderMinutesBeforeList,
      automation.tourReminderMinutesBefore,
    );
    if (minutesBeforeList.length === 0) {
      showToast("Choose at least one tour reminder timing.");
      return;
    }
    if (!automation.tourReminderDeliverViaEmail && !automation.tourReminderDeliverViaSms) {
      showToast("Choose at least one channel under Tour reminders → Send via.");
      return;
    }
    setSaving(true);
    try {
      if (demo) {
        showToast("Tour settings saved (demo).");
        onSaved?.();
        return;
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
            templates: { tourReminder: automation.templates.tourReminder },
          }),
        }),
      ]);
      if (!tourRes.ok || !autoRes.ok) throw new Error("Could not save calendar settings.");
      window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      showToast("Tour settings saved.");
      onSaved?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save tour settings.");
    } finally {
      setSaving(false);
    }
  }, [automation, demo, onSaved, showToast, tourSettings]);

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
            dataAttr: "manager-tour-settings-save",
          },
    [loading, saving, triggerSave],
  );

  useReportSettingsPanelFooter(onFooterReady, footerState);

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

        <div className="space-y-3 border-t border-border pt-4">
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
            viaEmail={automation.tourReminderDeliverViaEmail !== false}
            viaSms={automation.tourReminderDeliverViaSms === true}
            smsLabel="SMS (when guest opted in)"
            onChange={({ viaEmail, viaSms }) =>
              setAutomation((prev) => ({
                ...prev,
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
      </div>

      <ReminderMessageUpdateModal
        open={messageModalOpen}
        onClose={() => setMessageModalOpen(false)}
        subject={automation.templates.tourReminder.subject}
        body={automation.templates.tourReminder.body}
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

export function PaymentsSettingsPanel({
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
  const [presetId, setPresetId] = useState<ReminderPresetId>("standard");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) setDraft(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
          return;
        }
        const res = await fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" });
        if (!res.ok) throw new Error("Could not load payment settings.");
        const body = (await res.json()) as { settings: ManagerAutomationSettings };
        if (!cancelled) {
          const settings = normalizeManagerAutomationSettings(body.settings);
          setDraft(settings);
          setPresetId(detectReminderPreset(settings));
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load payment settings.");
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
        showToast("Payment settings saved (demo).");
        onSaved?.();
        return;
      }
      const res = await fetch("/api/portal/automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preDueReminderDays: draft.preDueReminderDays,
          sameDayReminderEnabled: draft.sameDayReminderEnabled,
          overdueDailyEnabled: draft.overdueDailyEnabled,
          overdueDailyStartDays: draft.overdueDailyStartDays,
          postDueReminderDays: draft.postDueReminderDays,
          lateFeeNoticeEnabled: draft.lateFeeNoticeEnabled,
          lateFeeNoticeDaysAfterDue: draft.lateFeeNoticeDaysAfterDue,
        }),
      });
      if (!res.ok) throw new Error("Could not save payment settings.");
      window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      showToast("Payment settings saved.");
      onSaved?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save payment settings.");
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
            dataAttr: "manager-payments-settings-save",
          },
    [loading, saving, triggerSave],
  );

  useReportSettingsPanelFooter(onFooterReady, footerState);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Choose how PropLane reminds residents about unpaid charges. Per-charge edits on the Payments ledger still
        apply on top of these defaults.
      </p>
      <div className="space-y-2">
        {PAYMENT_REMINDER_PRESETS.map((preset) => (
          <label
            key={preset.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              presetId === preset.id ? "border-primary bg-primary/5" : "border-border"
            }`}
          >
            <input
              type="radio"
              name="payment-reminder-preset"
              className="mt-0.5"
              checked={presetId === preset.id}
              onChange={() => {
                setPresetId(preset.id);
                setDraft((prev) => applyReminderPreset(prev, preset.id));
              }}
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-foreground">
                {preset.label}
                {preset.recommended ? " (recommended)" : ""}
              </span>
              <span className="block text-xs text-muted">{preset.description}</span>
            </span>
          </label>
        ))}
      </div>
      <label className="flex items-start gap-3 border-t border-border pt-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={draft.lateFeeNoticeEnabled}
          onChange={(e) => setDraft((prev) => ({ ...prev, lateFeeNoticeEnabled: e.target.checked }))}
        />
        <span className="min-w-0 text-[13px] text-foreground">
          Notify residents when a late fee is assessed ({draft.lateFeeNoticeDaysAfterDue} days after due)
        </span>
      </label>
    </div>
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
                  phone: status.number?.phoneNumber?.trim() || null,
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
      if (!channels.viaEmail && !channels.viaSms) {
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
          tourReminderDeliverViaEmail: draft.tourReminderDeliverViaEmail,
          tourReminderDeliverViaSms: draft.tourReminderDeliverViaSms,
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
          viaEmail={deliverViaFromManagerSettings(draft, activeSendViaSection.kind).viaEmail}
          viaSms={deliverViaFromManagerSettings(draft, activeSendViaSection.kind).viaSms}
          smsLabel={
            activeSendViaSection.kind === "payment_reminder"
              ? "SMS (when resident opted in)"
              : activeSendViaSection.kind === "tour_reminder"
                ? "SMS (when guest opted in)"
                : "SMS"
          }
          onChange={({ viaEmail, viaSms }) =>
            setDraft((prev) => patchDeliverViaForKind(prev, activeSendViaSection.kind, { viaEmail, viaSms }))
          }
          dataAttr={`communication-${activeSendViaSection.id}-send-via`}
        />
      </div>
    </div>
  );
}

export { DEFAULT_APPLICATION_AUTOMATION, normalizeApplicationAutomation };
