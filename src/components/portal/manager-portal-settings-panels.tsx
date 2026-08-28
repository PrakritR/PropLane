"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import type { ApplicationFeeChargePolicy } from "@/lib/manager-application-settings";
import {
  MAX_MANAGER_APPLICATION_FEE_CENTS,
  MIN_MANAGER_APPLICATION_FEE_CENTS,
} from "@/lib/manager-application-settings";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
  normalizeTourReminderMinutesBeforeList,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
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
  DEFAULT_TASK_AUTOMATION,
  type TaskAutomationPreferences,
} from "@/lib/task-automation-preferences";

const TOUR_PREVIEW_CONTEXT = {
  guestName: "Alex Prospect",
  propertyTitle: "5257 Brooklyn Avenue Northeast",
  tourTime: "Aug 15, 2026 at 10:00 AM",
  managerName: "Your team",
  instructions: "Meet at the front door. Text when you arrive.",
};

const TOUR_PLACEHOLDERS =
  "Placeholders: {guestName}, {propertyTitle}, {tourTime}, {managerName}, {instructions}";

export function ApplicationsSettingsPanel({
  automation,
  taskAutomation,
  teamMembers,
  loading,
  saving,
  waiverCode,
  feeCents,
  onFeeCentsChange,
  chargePolicy,
  onChargePolicyChange,
  otherInstructionsEnabled,
  onOtherInstructionsEnabledChange,
  otherInstructions,
  onOtherInstructionsChange,
  onAutomationChange,
  onTaskAutomationChange,
  onWaiverCodeChange,
  onSave,
}: {
  automation: ApplicationAutomationPreferences;
  taskAutomation: TaskAutomationPreferences;
  teamMembers: WorkAssignmentTeamMember[];
  loading: boolean;
  saving: boolean;
  waiverCode: string;
  feeCents: number | null;
  onFeeCentsChange: (cents: number | null) => void;
  chargePolicy: ApplicationFeeChargePolicy;
  onChargePolicyChange: (policy: ApplicationFeeChargePolicy) => void;
  otherInstructionsEnabled: boolean;
  onOtherInstructionsEnabledChange: (enabled: boolean) => void;
  otherInstructions: string;
  onOtherInstructionsChange: (value: string) => void;
  onAutomationChange: (next: ApplicationAutomationPreferences) => void;
  onTaskAutomationChange: (next: TaskAutomationPreferences) => void;
  onWaiverCodeChange: (value: string) => void;
  onSave: () => void;
}) {
  const confirmAutoApproveEnable = () =>
    window.confirm(
      "Auto-approve will approve submitted applications without manual review, creating resident accounts and approval-time charges. Withdrawn applications are still skipped.\n\nTurn on auto-approve?",
    );

  return (
    <div className="space-y-4">
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
          Auto-approve is on. New submissions are approved without a manual review step.
        </p>
      ) : null}
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-[13px] font-semibold text-foreground">Application fee</p>
        <p className="text-xs text-muted">
          Applies to every listing unless a listing sets its own fee. Enter dollars — use 0 for free applications.
        </p>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">$</span>
          <Input
            aria-label="Application fee amount"
            type="number"
            min={0}
            step={1}
            disabled={loading || saving}
            data-attr="manager-application-fee-amount-input"
            className="max-w-[8rem]"
            value={feeCents == null ? "" : String(feeCents / 100)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (!raw) {
                onFeeCentsChange(null);
                return;
              }
              const dollars = Number.parseFloat(raw);
              if (!Number.isFinite(dollars) || dollars < 0) return;
              if (dollars === 0) {
                onFeeCentsChange(0);
                return;
              }
              const cents = Math.round(dollars * 100);
              if (cents < MIN_MANAGER_APPLICATION_FEE_CENTS || cents > MAX_MANAGER_APPLICATION_FEE_CENTS) return;
              onFeeCentsChange(cents);
            }}
            placeholder="50"
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-foreground">Repeat applicants</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="application-fee-charge-policy"
              className="mt-1"
              checked={chargePolicy === "first_only"}
              disabled={loading || saving}
              onChange={() => onChargePolicyChange("first_only")}
            />
            <span>
              <span className="font-medium text-foreground">First application only</span>
              <span className="mt-0.5 block text-xs text-muted">
                Waive the fee when someone already applied to or paid you — any of your properties.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="application-fee-charge-policy"
              className="mt-1"
              checked={chargePolicy === "every_time"}
              disabled={loading || saving}
              onChange={() => onChargePolicyChange("every_time")}
            />
            <span>
              <span className="font-medium text-foreground">Every application</span>
              <span className="mt-0.5 block text-xs text-muted">Charge the fee again for each new application.</span>
            </span>
          </label>
        </fieldset>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={otherInstructionsEnabled}
            disabled={loading || saving}
            data-attr="manager-application-fee-other-enabled"
            onChange={(e) => onOtherInstructionsEnabledChange(e.target.checked)}
          />
          <span className="min-w-0 text-sm">
            <span className="block font-medium text-foreground">Custom payment instructions</span>
            <span className="block text-xs text-muted">
              Show applicants case-by-case directions (Zelle, Venmo, cash, etc.) on the fee step.
            </span>
          </span>
        </label>
        {otherInstructionsEnabled ? (
          <Textarea
            aria-label="Custom application fee payment instructions"
            value={otherInstructions}
            onChange={(e) => onOtherInstructionsChange(e.target.value)}
            disabled={loading || saving}
            rows={4}
            placeholder="Example: Send $50 via Zelle to payments@yourcompany.com — include your full name in the memo."
            data-attr="manager-application-fee-other-instructions"
          />
        ) : null}
      </div>
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-[13px] font-semibold text-foreground">Promo code</p>
        <Input
          aria-label="Promo code"
          value={waiverCode}
          onChange={(e) => onWaiverCodeChange(e.target.value)}
          placeholder="E.G. WELCOME50"
          data-attr="manager-application-waiver-code-input"
          disabled={loading || saving}
          className="w-full font-mono uppercase"
        />
        <p className="text-xs text-muted">Applicants entering this code apply for free. Leave empty to turn it off.</p>
      </div>
      <TaskAutomationSettingsFields
        templateKeys={["review_application"]}
        taskAutomation={taskAutomation}
        teamMembers={teamMembers}
        loading={loading}
        saving={saving}
        onChange={onTaskAutomationChange}
      />
      <div className="flex justify-end border-t border-border pt-3">
        <Button
          type="button"
          className="rounded-full px-4 text-[13px]"
          onClick={onSave}
          disabled={loading || saving}
          data-attr="manager-application-fee-save"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function LeaseSettingsPanel({
  automation,
  taskAutomation,
  teamMembers,
  loading,
  saving,
  onAutomationChange,
  onTaskAutomationChange,
  onSave,
}: {
  automation: ApplicationAutomationPreferences;
  taskAutomation: TaskAutomationPreferences;
  teamMembers: WorkAssignmentTeamMember[];
  loading: boolean;
  saving: boolean;
  onAutomationChange: (next: ApplicationAutomationPreferences) => void;
  onTaskAutomationChange: (next: TaskAutomationPreferences) => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-4">
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
      <TaskAutomationSettingsFields
        templateKeys={["review_and_send_lease", "collect_rent"]}
        taskAutomation={taskAutomation}
        teamMembers={teamMembers}
        loading={loading}
        saving={saving}
        onChange={onTaskAutomationChange}
      />
      <div className="flex justify-end border-t border-border pt-3">
        <Button type="button" className="rounded-full px-4 text-[13px]" onClick={onSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
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

export function CalendarSettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tourSettings, setTourSettings] = useState<ManagerTourSettings>(DEFAULT_MANAGER_TOUR_SETTINGS);
  const [automation, setAutomation] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
  const [messageModalOpen, setMessageModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (demo) {
        setTourSettings(DEFAULT_MANAGER_TOUR_SETTINGS);
        setAutomation(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
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
      setTourSettings(tourBody.settings ?? DEFAULT_MANAGER_TOUR_SETTINGS);
      setAutomation(autoBody.settings ?? DEFAULT_MANAGER_AUTOMATION_SETTINGS);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load calendar settings.");
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const templatePreview = useMemo(
    () => fillTourReminderTemplate(automation.templates.tourReminder, TOUR_PREVIEW_CONTEXT),
    [automation.templates.tourReminder],
  );

  const save = async () => {
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
        showToast("Calendar settings saved (demo).");
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
      showToast("Calendar settings saved.");
      onSaved?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save calendar settings.");
    } finally {
      setSaving(false);
    }
  };

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

        <div className="flex justify-end border-t border-border pt-3">
          <Button
            type="button"
            className="rounded-full px-4 text-[13px]"
            onClick={() => void save()}
            disabled={saving}
            data-attr="manager-calendar-settings-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
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

export function PaymentsSettingsPanel({ onSaved }: { onSaved?: () => void }) {
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
          setDraft(body.settings);
          setPresetId(detectReminderPreset(body.settings));
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

  const save = async () => {
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
  };

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
      <div className="flex justify-end border-t border-border pt-3">
        <Button type="button" className="rounded-full px-4 text-[13px]" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function CommunicationSettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);

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
        if (!res.ok) throw new Error("Could not load communication settings.");
        const body = (await res.json()) as { settings: ManagerAutomationSettings };
        if (!cancelled) setDraft(body.settings);
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

  const save = async () => {
    if (!draft.paymentReminderDeliverViaEmail && !draft.paymentReminderDeliverViaSms) {
      showToast("Choose at least one channel for payment reminders.");
      return;
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
  };

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-5">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={draft.inboxAiDraftAutoSend}
          onChange={(e) => {
            const next = e.target.checked;
            if (
              next &&
              !window.confirm(
                "Auto-send will email or text AI-drafted replies without your approval. Inbound resident and prospect messages are untrusted — misleading content could influence what goes out under your name.\n\nTurn on auto-send?",
              )
            ) {
              return;
            }
            setDraft((prev) => ({ ...prev, inboxAiDraftAutoSend: next }));
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
      {draft.inboxAiDraftAutoSend ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-foreground">
          Auto-send is on. Review each thread carefully — AI drafts send without a second confirmation.
        </p>
      ) : null}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-[13px] font-semibold text-foreground">Payment reminders</p>
        <ReminderSendViaField
          viaEmail={draft.paymentReminderDeliverViaEmail !== false}
          viaSms={draft.paymentReminderDeliverViaSms === true}
          smsLabel="SMS (when resident opted in)"
          onChange={({ viaEmail, viaSms }) =>
            setDraft((prev) => ({
              ...prev,
              paymentReminderDeliverViaEmail: viaEmail,
              paymentReminderDeliverViaSms: viaSms,
            }))
          }
          dataAttr="payment-reminder-send-via"
        />
      </div>
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-[13px] font-semibold text-foreground">Tour reminders</p>
        <ReminderSendViaField
          viaEmail={draft.tourReminderDeliverViaEmail !== false}
          viaSms={draft.tourReminderDeliverViaSms === true}
          smsLabel="SMS (when guest opted in)"
          onChange={({ viaEmail, viaSms }) =>
            setDraft((prev) => ({
              ...prev,
              tourReminderDeliverViaEmail: viaEmail,
              tourReminderDeliverViaSms: viaSms,
            }))
          }
          dataAttr="communication-tour-reminder-send-via"
        />
      </div>
      <div className="flex justify-end border-t border-border pt-3">
        <Button type="button" className="rounded-full px-4 text-[13px]" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export { DEFAULT_APPLICATION_AUTOMATION, normalizeApplicationAutomation, DEFAULT_TASK_AUTOMATION };
