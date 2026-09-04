"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { MODAL_TALL_PANEL_CLASS, PORTAL_MODAL_BODY_SCROLL_CLASS } from "@/components/ui/modal-styles";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { ManagerAutomationSettings } from "@/lib/payment-automation-settings";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  formatStandardReminderSchedule,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
} from "@/lib/payment-automation-settings";
import {
  HOUSEHOLD_CHARGES_EVENT,
  isUnpaidHouseholdCharge,
  readHouseholdCharges,
} from "@/lib/household-charges";
import {
  CLIENT_SCHEDULED_MESSAGE_OVERRIDES_EVENT,
  applyClientPatchesToMessages,
  mergeClientScheduledMessagePatch,
} from "@/lib/client-scheduled-message-overrides";
import { readPortalApiError } from "@/lib/portal-api-error";
import { InboxScheduledCard, ScheduledMessageDetailModal } from "@/components/portal/portal-inbox-ui";
import { ReminderMessagePreviewCard, ReminderMessageUpdateModal, ReminderSendViaField } from "@/components/portal/reminder-settings-shared";
import { sendAutomationScheduledMessageNow } from "@/components/portal/portal-inbox-selection";
import { threadScheduledItemFromAutomationMessage } from "@/lib/inbox-scheduled-thread";
import { applyReminderTemplate, type ReminderTemplateParams } from "@/lib/payment-reminder-email";
import { encodeScheduledMessagePathId } from "@/lib/scheduled-message-path-id";
import {
  applyReminderPreset,
  buildReminderPreviewLines,
  detectReminderPreset,
  formatFriendlyReminderSchedule,
  labelForReminderScheduleToken,
  reminderScheduleTokensFromSettings,
  settingsPatchFromReminderScheduleTokens,
  REMINDER_BEFORE_DUE_DAY_OPTIONS,
  PAYMENT_REMINDER_PRESETS,
  type ReminderPresetId,
  type ReminderScheduleToken,
} from "@/lib/payment-reminder-presets";
import {
  filterScheduledPaymentMessagesForUnpaidCharges,
  filterScheduledPaymentMessagesForVisibility,
  formatScheduledSendAt,
  manageableRemindersForCharge,
  projectScheduledPaymentMessages,
  scheduledReminderShortLabel,
  type ScheduledPaymentMessage,
} from "@/lib/scheduled-payment-messages";
import { combineScheduledPaymentMessages } from "@/lib/combined-payment-reminders";
import { cn } from "@/lib/utils";

export { formatFriendlyReminderSchedule };

/** Ledger link label — opens per-charge reminder editor. */
export function summarizeChargeReminders(messages: ScheduledPaymentMessage[]): string {
  if (!messages.length) return "";
  const active = messages.filter((message) => message.status !== "cancelled");
  if (!active.length) return "Edit reminder (paused)";
  return "Edit reminder";
}

function mergeLocalChargeReminders(
  serverMessages: ScheduledPaymentMessage[],
  settings: ManagerAutomationSettings,
  includeHidden: boolean,
): ScheduledPaymentMessage[] {
  const serverChargeIds = new Set(serverMessages.map((message) => message.chargeId));
  const localOnly = readHouseholdCharges().filter(
    (charge) => isUnpaidHouseholdCharge(charge) && !serverChargeIds.has(charge.id) && charge.managerUserId,
  );
  if (!localOnly.length) return serverMessages;

  const byManager = new Map<string, typeof localOnly>();
  for (const charge of localOnly) {
    const managerUserId = charge.managerUserId!.trim();
    const list = byManager.get(managerUserId) ?? [];
    list.push(charge);
    byManager.set(managerUserId, list);
  }

  const merged = [...serverMessages];
  for (const [managerUserId, charges] of byManager) {
    merged.push(
      ...projectScheduledPaymentMessages({
        managerUserId,
        charges,
        settings,
        includeHidden,
      }),
    );
  }
  return merged.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

function formatSendDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One-line summary for automation settings buttons. */
export function formatAutomationScheduleSummary(settings: ManagerAutomationSettings): string {
  return formatStandardReminderSchedule(settings);
}

/** Persist a one-off reminder for a single charge on a specific calendar date. */
export async function addChargeSetDateReminder(chargeId: string, isoDate: string): Promise<void> {
  const res = await fetch("/api/portal/scheduled-messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ chargeId, date: isoDate }),
  });
  if (!res.ok) {
    const payload = (await res.json()) as { error?: string };
    throw new Error(payload.error ?? "Could not add reminder.");
  }
}

/** Compact date picker + button that adds a one-off set-date reminder. */
export function AddSetDateReminderControl({
  onAdd,
  label = "Add date",
  disabled,
}: {
  onAdd: (isoDate: string) => void | Promise<void>;
  label?: string;
  disabled?: boolean;
}) {
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input
        type="date"
        className="h-8 w-36 text-xs"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        disabled={disabled || busy}
        aria-label="Reminder date"
      />
      <Button
        type="button"
        variant="outline"
        className="rounded-full px-2 py-1 text-xs"
        disabled={disabled || busy || !date}
        onClick={async () => {
          if (!date) return;
          setBusy(true);
          try {
            await onAdd(date);
            setDate("");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Adding…" : label}
      </Button>
    </div>
  );
}

export function ChargeReminderList({
  messages,
  onEdit,
  onToggleCancel,
}: {
  messages: ScheduledPaymentMessage[];
  onEdit?: (message: ScheduledPaymentMessage) => void;
  onToggleCancel?: (message: ScheduledPaymentMessage, cancelled: boolean) => void | Promise<void>;
}) {
  if (!messages.length) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {messages.map((m) => {
        const cancelled = m.status === "cancelled";
        const label = scheduledReminderShortLabel(m.kind, m.daysBeforeDue);
        return (
          <li
            key={m.id}
            className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${
              cancelled ? "border-border bg-accent/15 text-muted" : "border-border bg-card text-foreground"
            }`}
          >
            <button
              type="button"
              className={`min-w-0 flex-1 text-left ${cancelled ? "line-through" : ""}`}
              title={`Edit · sends ${formatSendDate(m.sendAt)}`}
              onClick={() => onEdit?.(m)}
            >
              <span className="font-medium">{label}</span>
              <span className="ml-1 text-muted">· {formatSendDate(m.sendAt)}</span>
            </button>
            {onToggleCancel ? (
              <button
                type="button"
                className="shrink-0 rounded-full px-2 py-0.5 font-semibold text-muted hover:bg-accent/50 hover:text-foreground"
                onClick={() => void onToggleCancel(m, !cancelled)}
              >
                {cancelled ? "Turn on" : "Turn off"}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ChargeRemindersModal({
  open,
  onClose,
  residentName,
  chargeTitle,
  dueDate,
  messages,
  scheduleSummary,
  onMessageSaved,
  onToggleCancel,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  residentName: string;
  chargeTitle: string;
  dueDate: string;
  messages: ScheduledPaymentMessage[];
  /** Default schedule label shown above the per-charge timeline. */
  scheduleSummary?: string;
  onMessageSaved?: () => void;
  onToggleCancel: (message: ScheduledPaymentMessage, cancelled: boolean) => void | Promise<void>;
  onOpenSettings?: () => void;
  onAddSetDate?: (isoDate: string) => void | Promise<void>;
}) {
  const { showToast } = useAppUi();
  const [editingMessage, setEditingMessage] = useState<ScheduledPaymentMessage | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const manageableFromProps = useMemo(
    () => messages.filter((m) => m.status === "scheduled" || m.status === "cancelled"),
    [messages],
  );
  const [manageable, setManageable] = useState(manageableFromProps);

  useEffect(() => {
    setManageable(manageableFromProps);
  }, [manageableFromProps]);

  useEffect(() => {
    if (!open) setEditingMessage(null);
  }, [open]);

  const toggleCancelled = async (message: ScheduledPaymentMessage, cancelled: boolean) => {
    setManageable((prev) =>
      prev.map((row) =>
        row.id === message.id ? { ...row, status: cancelled ? "cancelled" : "scheduled" } : row,
      ),
    );
    try {
      await onToggleCancel(message, cancelled);
      onMessageSaved?.();
    } catch {
      setManageable(manageableFromProps);
      showToast("Could not update reminder.");
    }
  };

  const editingScheduled = editingMessage
    ? threadScheduledItemFromAutomationMessage(editingMessage)
    : null;

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title="Edit reminder"
      dense
      assistantContext={`Edit reminder for ${chargeTitle}`}
      panelClassName={cn("max-w-lg p-3 sm:p-4", MODAL_TALL_PANEL_CLASS)}
      scrollableContent={false}
    >
      <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-accent/20 px-3 py-2.5">
          <p className="text-sm font-semibold text-foreground">{chargeTitle}</p>
          <p className="mt-0.5 text-xs text-muted">
            {residentName} · due {dueDate}
          </p>
          <p className="mt-2 text-xs text-muted">
            Changes here apply only to this payment. Default timing: {scheduleSummary ?? "Standard"}.
          </p>
        </div>
        {manageable.length === 0 ? (
          <p className="text-sm text-muted">No upcoming reminders for this charge.</p>
        ) : (
          <div>
            <p className="text-xs font-semibold text-muted">Scheduled messages</p>
            <ul className="mt-2 space-y-2">
            {manageable.map((m) => {
              const cancelled = m.status === "cancelled";
              const label = scheduledReminderShortLabel(m.kind, m.daysBeforeDue);
              return (
                <li
                  key={m.id}
                  className={`rounded-xl border border-border bg-card px-3 py-2.5 text-foreground shadow-sm ${
                    cancelled ? "opacity-80" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      className={`min-w-0 flex-1 text-left ${cancelled ? "line-through" : ""}`}
                      onClick={() => setEditingMessage(m)}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{label}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            cancelled
                              ? "bg-muted/30 text-muted"
                              : "bg-primary/15 text-primary"
                          }`}
                        >
                          {cancelled ? "Off" : "Scheduled"}
                        </span>
                      </div>
                      <span className="mt-1 block text-xs text-muted">Sends {formatSendDate(m.sendAt)}</span>
                      <span className="mt-0.5 block text-[11px] font-medium text-primary">Update message</span>
                    </button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 shrink-0 rounded-full px-3 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleCancelled(m, !cancelled);
                      }}
                    >
                      {cancelled ? "Turn on" : "Turn off"}
                    </Button>
                  </div>
                </li>
              );
            })}
            </ul>
          </div>
        )}
        {onOpenSettings ? (
          <button
            type="button"
            className="w-full text-center text-xs font-semibold text-primary hover:underline"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            Change default schedule for all payments
          </button>
        ) : null}
      </div>
      </div>
    </Modal>
    <ScheduledMessageDetailModal
      open={open && Boolean(editingMessage)}
      onClose={() => setEditingMessage(null)}
    >
      {editingMessage && editingScheduled ? (
        <InboxScheduledCard
          key={editingMessage.id}
          sendLabel={editingScheduled.sendLabel}
          subject={editingMessage.subject}
          body={editingMessage.body}
          meta={editingScheduled.meta}
          source="automation"
          editable={editingMessage.status === "scheduled"}
          busy={detailBusy}
          presentation="detail"
          onCancel={() => void toggleCancelled(editingMessage, true).then(() => setEditingMessage(null))}
          onSendNow={() => {
            if (editingMessage.status !== "scheduled") return;
            setDetailBusy(true);
            void sendAutomationScheduledMessageNow(editingMessage.id)
              .then(() => {
                showToast("Reminder sent.");
                onMessageSaved?.();
                setEditingMessage(null);
              })
              .catch((e) => {
                showToast(e instanceof Error ? e.message : "Could not send reminder.");
              })
              .finally(() => setDetailBusy(false));
          }}
          onSaveEdit={
            editingMessage.status === "scheduled"
              ? async (next) => {
                  await patchScheduledMessage(editingMessage.id, {
                    customSubject: next.subject,
                    customBody: next.body,
                  });
                  onMessageSaved?.();
                }
              : undefined
          }
        />
      ) : null}
    </ScheduledMessageDetailModal>
    </>
  );
}

export function ScheduledMessageEditForm({
  message,
  onClose,
  onSaved,
  onSendNow,
}: {
  message: ScheduledPaymentMessage;
  onClose: () => void;
  onSaved: () => void;
  onSendNow?: () => void | Promise<void>;
}) {
  const { showToast } = useAppUi();
  const [subject, setSubject] = useState(message.subject);
  const [body, setBody] = useState(message.body);
  const [sendAtLocal, setSendAtLocal] = useState(toLocalInputValue(message.sendAt));
  const [applyToFuture, setApplyToFuture] = useState(false);
  const [busy, setBusy] = useState(false);

  const templateKeyForKind = (kind: ScheduledPaymentMessage["kind"]) => {
    if (kind === "late_fee") return "lateFee" as const;
    if (kind === "pre_due" || kind === "same_day" || kind === "set_date") return "preDue" as const;
    return "overdue" as const;
  };

  const save = async () => {
    const sendAt = new Date(sendAtLocal);
    if (Number.isNaN(sendAt.getTime())) {
      showToast("Choose a valid send date and time.");
      return;
    }
    setBusy(true);
    try {
      const pathId = encodeScheduledMessagePathId(message.id);
      const res = await fetch(`/api/portal/scheduled-messages/${pathId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          customSubject: subject,
          customBody: body,
          customSendAt: sendAt.toISOString(),
        }),
      });
      if (!res.ok) {
        throw new Error(await readPortalApiError(res, "Could not save."));
      }
      mergeClientScheduledMessagePatch(message.id, {
        customSubject: subject,
        customBody: body,
        customSendAt: sendAt.toISOString(),
      });
      if (applyToFuture) {
        const templateKey = templateKeyForKind(message.kind);
        await fetch("/api/portal/automation-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            templates: {
              [templateKey]: { subject, body },
            },
          }),
        });
      }
      showToast("Scheduled message updated.");
      onSaved();
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const toggleCancelled = async (cancelled: boolean) => {
    setBusy(true);
    try {
      const pathId = encodeScheduledMessagePathId(message.id);
      const res = await fetch(`/api/portal/scheduled-messages/${pathId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cancelled }),
      });
      if (!res.ok) throw new Error(await readPortalApiError(res, "Could not update."));
      mergeClientScheduledMessagePatch(message.id, { cancelled });
      showToast(cancelled ? "Send cancelled." : "Send restored.");
      onSaved();
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not update.");
    } finally {
      setBusy(false);
    }
  };

  return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {message.residentName} · {message.chargeTitle} · sends {formatScheduledSendAt(message.sendAt)}
        </p>
        <div>
          <label className="text-xs font-semibold text-muted">Send date &amp; time</label>
          <Input
            type="datetime-local"
            className="mt-1"
            value={sendAtLocal}
            onChange={(e) => setSendAtLocal(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted">Subject</label>
          <Input className="mt-1" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy} />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted">Message</label>
          <Textarea className="mt-1 min-h-[160px]" value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={applyToFuture}
            onChange={(e) => setApplyToFuture(e.target.checked)}
            disabled={busy}
          />
          Apply to future payments
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" className="rounded-full" onClick={() => save()} disabled={busy}>
            Save
          </Button>
          {message.status === "scheduled" && onSendNow ? (
            <Button type="button" variant="outline" className="rounded-full" onClick={() => onSendNow()} disabled={busy}>
              Send now
            </Button>
          ) : null}
          {message.status === "cancelled" ? (
            <Button type="button" variant="outline" className="rounded-full" onClick={() => toggleCancelled(false)} disabled={busy}>
              Restore send
            </Button>
          ) : message.status === "scheduled" ? (
            <Button type="button" variant="outline" className="rounded-full text-rose-700" onClick={() => toggleCancelled(true)} disabled={busy}>
              Cancel send
            </Button>
          ) : null}
          </div>
    </div>
  );
}

export type ScheduleSettingsVariant = "inbox" | "payments";

const SCHEDULE_SETTINGS_COPY: Record<
  ScheduleSettingsVariant,
  {
    savedToast: string;
    title: string;
    description: string;
    daysBeforeLabel: string;
    sameDayLabel: string;
    followUpLabel: string;
    templateLabel: string;
    saveLabel: string;
  }
> = {
  inbox: {
    savedToast: "Schedule settings saved.",
    title: "Schedule settings",
    description: "",
    daysBeforeLabel: "Days before send date",
    sameDayLabel: "Same-day message",
    followUpLabel: "Daily follow-up messages",
    templateLabel: "Default message template",
    saveLabel: "Save schedule settings",
  },
  payments: {
    savedToast: "Reminder schedule saved.",
    title: "Automated reminders",
    description: "",
    daysBeforeLabel: "Days before due",
    sameDayLabel: "Due date",
    followUpLabel: "Every day late",
    templateLabel: "Default pre-due message template",
    saveLabel: "Save",
  },
};

function normalizeAutomationPayload(
  settings: ManagerAutomationSettings,
  visibilityDaysRaw?: string,
): ManagerAutomationSettings {
  const visibilityDays =
    visibilityDaysRaw !== undefined
      ? Math.max(0, Math.min(30, Math.round(Number(visibilityDaysRaw)) || settings.scheduleVisibilityDays))
      : settings.scheduleVisibilityDays;
  return { ...settings, scheduleVisibilityDays: visibilityDays };
}

export type PaymentAutomationSettingsHandle = {
  saveIfDirty: () => Promise<boolean>;
};

const PORTAL_FIELD_LABEL_CLASS = "text-xs font-semibold text-muted";

const REMINDER_TEMPLATE_PREVIEW_PARAMS: ReminderTemplateParams = {
  residentName: "Alex Resident",
  chargeTitle: "April rent",
  balanceDue: "$1,200.00",
  propertyLabel: "Sample property",
  managerName: "Your team",
  dueDateLabel: "Apr 15, 2026",
  daysUntilDue: 3,
};

const REMINDER_PRESET_OPTIONS = [
  ...PAYMENT_REMINDER_PRESETS.map((preset) => ({
    value: preset.id,
    label: `${preset.label}${preset.recommended ? " (recommended)" : ""}`,
  })),
  { value: "custom", label: "Custom" },
] as const;

function sortReminderScheduleTokens(tokens: ReminderScheduleToken[]): ReminderScheduleToken[] {
  const before = tokens
    .filter((t): t is `before:${number}` => t.startsWith("before:"))
    .sort((a, b) => Number(b.slice("before:".length)) - Number(a.slice("before:".length)));
  const ordered: ReminderScheduleToken[] = [...before];
  if (tokens.includes("due_date")) ordered.push("due_date");
  if (tokens.includes("every_day_late")) ordered.push("every_day_late");
  return ordered;
}

function ReminderScheduleChipRow({
  tokens,
  busy,
  onChange,
}: {
  tokens: ReminderScheduleToken[];
  busy: boolean;
  onChange: (next: ReminderScheduleToken[]) => void;
}) {
  const sorted = sortReminderScheduleTokens(tokens);
  if (!sorted.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Selected reminders">
      {sorted.map((token) => (
        <li key={token}>
          <button
            type="button"
            disabled={busy}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-primary/15 disabled:opacity-50"
            onClick={() => onChange(tokens.filter((t) => t !== token))}
            aria-label={`Remove ${labelForReminderScheduleToken(token)}`}
          >
            <span className="truncate">{labelForReminderScheduleToken(token)}</span>
            <span className="text-muted" aria-hidden>
              ×
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReminderPresetDropdown({
  activePreset,
  busy,
  onSelect,
}: {
  activePreset: ReminderPresetId;
  busy: boolean;
  onSelect: (presetId: ReminderPresetId) => void;
}) {
  return (
    <FieldSingleSelect
      label="Start from template"
      labelClassName={PORTAL_FIELD_LABEL_CLASS}
      options={[...REMINDER_PRESET_OPTIONS]}
      value={activePreset}
      disabled={busy}
      dataAttr="payment-reminder-schedule-preset"
      onChange={(next) => onSelect(next as ReminderPresetId)}
    />
  );
}

function UnifiedReminderScheduleSelect({
  draft,
  busy,
  onChange,
}: {
  draft: ManagerAutomationSettings;
  busy: boolean;
  onChange: (patch: ReturnType<typeof settingsPatchFromReminderScheduleTokens>) => void;
}) {
  const [customDayInput, setCustomDayInput] = useState("");

  const beforeDueOptions = useMemo(() => {
    const known = new Set<number>(REMINDER_BEFORE_DUE_DAY_OPTIONS);
    const extras = draft.preDueReminderDays.filter((day) => !known.has(day));
    const days = [...extras, ...REMINDER_BEFORE_DUE_DAY_OPTIONS].sort((a, b) => b - a);
    return days.map((day) => ({
      value: `before:${day}` satisfies ReminderScheduleToken,
      label: labelForReminderScheduleToken(`before:${day}`),
    }));
  }, [draft.preDueReminderDays]);

  const selected = reminderScheduleTokensFromSettings(draft);
  const hasSelection = selected.length > 0;

  const commitSchedule = (tokens: ReminderScheduleToken[]) => {
    onChange(settingsPatchFromReminderScheduleTokens(tokens));
  };

  const addCustomDay = () => {
    const day = Math.round(Number(customDayInput.trim()));
    if (!Number.isFinite(day) || day < 1 || day > 60) return;
    const token = `before:${day}` as ReminderScheduleToken;
    const nextTokens = selected.includes(token) ? selected : [...selected, token];
    const patch = settingsPatchFromReminderScheduleTokens(nextTokens);
    patch.preDueReminderDays = [...new Set([...patch.preDueReminderDays, day])].sort((a, b) => b - a);
    onChange(patch);
    setCustomDayInput("");
  };

  return (
    <div className="space-y-2">
      {hasSelection ? (
        <>
          <p className={PORTAL_FIELD_LABEL_CLASS}>Reminders</p>
          <ReminderScheduleChipRow
            tokens={selected}
            busy={busy}
            onChange={(next) => commitSchedule(next)}
          />
        </>
      ) : null}
      <CheckboxMultiSelect
        label="Reminders"
        labelClassName={PORTAL_FIELD_LABEL_CLASS}
        hideLabel={hasSelection}
        selectionTriggerLabel={hasSelection ? "Add or remove…" : undefined}
        groups={[
          { label: "Before due", options: beforeDueOptions },
          {
            label: "Due & after",
            options: [
              { value: "due_date", label: "Due date" },
              { value: "every_day_late", label: "Every day late" },
            ],
          },
        ]}
        selected={selected}
        onChange={(next) => commitSchedule(next as ReminderScheduleToken[])}
        disabled={busy}
        emptyLabel="Choose reminders…"
        dataAttr="payment-reminder-schedule"
      menuFooter={
        <div className="px-3 py-2">
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Custom day</p>
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              max={60}
              className="h-9 min-h-0 flex-1"
              placeholder="Days before due"
              value={customDayInput}
              disabled={busy}
              data-attr="payment-reminder-custom-day"
              onChange={(e) => setCustomDayInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomDay();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="h-9 shrink-0 rounded-full px-3 text-xs"
              disabled={busy || !customDayInput.trim()}
              onClick={addCustomDay}
            >
              Add
            </Button>
          </div>
        </div>
      }
    />
    </div>
  );
}

export type PaymentReminderSaveScope = "future_only" | "future_and_existing";

function PaymentAutomationSettingsForm({
  initialSettings,
  onSaved,
  onAfterSave,
  variant = "payments",
  layout = "card",
  autoSaveOnClose = false,
  formRef,
}: {
  initialSettings: ManagerAutomationSettings;
  onSaved: (next: ManagerAutomationSettings) => void;
  /** Called after a successful save (e.g. close modal). */
  onAfterSave?: () => void;
  variant?: ScheduleSettingsVariant;
  layout?: "card" | "modal";
  autoSaveOnClose?: boolean;
  formRef?: React.Ref<PaymentAutomationSettingsHandle>;
}) {
  const { showToast } = useAppUi();
  const copy = SCHEDULE_SETTINGS_COPY[variant];
  const [draft, setDraft] = useState(initialSettings);
  const [selectedPreset, setSelectedPreset] = useState<ReminderPresetId>(() => detectReminderPreset(initialSettings));
  const [visibilityDaysInput, setVisibilityDaysInput] = useState(String(initialSettings.scheduleVisibilityDays));
  /*
    Autosaving panels always apply the schedule to existing unpaid payments.
    The checkbox was only meaningful next to an explicit Save; with the save
    implicit there is nothing to tick it before. And the intent behind it is
    the rule anyway — every unpaid payment carries reminders — so a schedule
    that skipped the ones already on the books would be the surprising half.
  */
  const [applyToExistingChoice, setApplyToExistingChoice] = useState(false);
  const applyToExisting = autoSaveOnClose ? true : applyToExistingChoice;
  const [busy, setBusy] = useState(false);
  const [messageModalOpen, setMessageModalOpen] = useState(false);

  useEffect(() => {
    setDraft(initialSettings);
    setSelectedPreset(detectReminderPreset(initialSettings));
    setVisibilityDaysInput(String(initialSettings.scheduleVisibilityDays));
  }, [initialSettings]);

  const savedBaseline = useMemo(() => normalizeAutomationPayload(initialSettings), [initialSettings]);
  const currentPayload = useMemo(
    () => normalizeAutomationPayload(draft, visibilityDaysInput),
    [draft, visibilityDaysInput],
  );
  const isDirty = useMemo(
    () => JSON.stringify(currentPayload) !== JSON.stringify(savedBaseline),
    [currentPayload, savedBaseline],
  );

  const previewLines = useMemo(() => buildReminderPreviewLines(draft), [draft]);
  const scheduleHasReminders = previewLines.length > 0 && previewLines[0] !== "No automatic reminders";
  const saveEnabled =
    !busy &&
    scheduleHasReminders &&
    (isDirty || (variant === "payments" && applyToExisting));

  const save = useCallback(async (options?: { silent?: boolean }) => {
    if (!scheduleHasReminders) {
      showToast("Choose at least one reminder before saving.");
      return false;
    }
    if (!draft.paymentReminderDeliverViaEmail && !draft.paymentReminderDeliverViaSms) {
      showToast("Choose at least one channel under Send via.");
      return false;
    }
    setBusy(true);
    try {
      const payload = currentPayload;
      const res = await fetch("/api/portal/automation-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ...payload,
          ...(variant === "payments"
            ? { applyReminderScope: applyToExisting ? "future_and_existing" : "future_only" }
            : {}),
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json()) as { error?: string };
        throw new Error(errBody.error ?? "Could not save settings.");
      }
      const body = (await res.json()) as { settings: ManagerAutomationSettings; clearedOverrides?: number };
      setDraft(body.settings);
      setSelectedPreset(detectReminderPreset(body.settings));
      setVisibilityDaysInput(String(body.settings.scheduleVisibilityDays));
      onSaved(body.settings);
      onAfterSave?.();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      }
      if (!options?.silent) {
        if (variant === "payments" && applyToExisting && (body.clearedOverrides ?? 0) > 0) {
          showToast("Reminder schedule saved for future and existing unpaid payments.");
        } else {
          showToast(copy.savedToast);
        }
      }
      if (variant === "payments") {
        setApplyToExistingChoice(false);
      }
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save settings.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [copy.savedToast, currentPayload, onAfterSave, onSaved, applyToExisting, scheduleHasReminders, showToast, variant]);

  const saveIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    return save({ silent: true });
  }, [isDirty, save, autoSaveOnClose]);

  useImperativeHandle(formRef, () => ({ saveIfDirty }), [saveIfDirty]);

  const saveVisible = !autoSaveOnClose;

  const applySchedulePatch = (patch: ReturnType<typeof settingsPatchFromReminderScheduleTokens>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      setSelectedPreset(detectReminderPreset(next));
      return next;
    });
  };

  const compact = layout === "modal" && variant === "payments";

  const selectPreset = (presetId: ReminderPresetId) => {
    if (presetId === "custom") {
      setSelectedPreset("custom");
      return;
    }
    setDraft((prev) => applyReminderPreset(prev, presetId));
    setSelectedPreset(presetId);
  };

  const activePreset = selectedPreset;

  /*
    No "Start from template" picker here. Basics / Standard / Gentle / Due date
    only were five names for arrangements of the same chips shown directly
    below, and picking one only rewrote those chips — so the dropdown mostly
    said "Custom", describing what the manager had already done rather than
    offering anything. The chips are the control.
  */
  const paymentsScheduleBlock = (
    <div className="space-y-3">
      <UnifiedReminderScheduleSelect draft={draft} busy={busy} onChange={applySchedulePatch} />
    </div>
  );

  const templatePreviewSubject = applyReminderTemplate(
    draft.templates.preDue.subject,
    REMINDER_TEMPLATE_PREVIEW_PARAMS,
  );
  const templatePreviewBody = applyReminderTemplate(
    draft.templates.preDue.body,
    REMINDER_TEMPLATE_PREVIEW_PARAMS,
  );

  const paymentsMessageBlock = compact && variant === "payments" ? (
    <>
      <ReminderMessagePreviewCard
        subject={templatePreviewSubject || "Payment reminder"}
        body={templatePreviewBody}
        onUpdate={() => setMessageModalOpen(true)}
        dataAttr="payment-reminder-update-message"
      />
      {/* Both channels by default: a reminder that only emails is the one the
          resident misses, and SMS is the channel they actually read. */}
      <ReminderSendViaField
        viaEmail={draft.paymentReminderDeliverViaEmail !== false}
        viaSms={draft.paymentReminderDeliverViaSms !== false}
        onChange={({ viaEmail, viaSms }) =>
          setDraft((prev) => ({
            ...prev,
            paymentReminderDeliverViaEmail: viaEmail,
            paymentReminderDeliverViaSms: viaSms,
          }))
        }
        dataAttr="payment-reminder-send-via"
      />
    </>
  ) : null;

  return (
    <>
    <div className={layout === "card" ? "rounded-2xl border border-border bg-accent/20 p-4 space-y-4" : "space-y-4"}>
      {layout === "card" ? (
        <div>
          <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
          {copy.description ? <p className="mt-1 text-xs text-muted">{copy.description}</p> : null}
        </div>
      ) : null}

      {compact ? (
        <>
          {paymentsScheduleBlock}
          {paymentsMessageBlock}
        </>
      ) : (
        <>
          <ReminderPresetDropdown activePreset={activePreset} busy={busy} onSelect={selectPreset} />
          <UnifiedReminderScheduleSelect draft={draft} busy={busy} onChange={applySchedulePatch} />
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={draft.lateFeeNoticeEnabled} onChange={(e) => setDraft({ ...draft, lateFeeNoticeEnabled: e.target.checked })} disabled={busy} />
            Late fee notices
          </label>

          {draft.overdueDailyEnabled ? (
            <label className="block text-xs font-semibold text-muted">
              Start daily overdue reminders after
              <div className="mt-1 flex items-center gap-2">
                <Input
                  className="h-8 w-16 text-xs"
                  inputMode="numeric"
                  value={String(draft.overdueDailyStartDays)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      overdueDailyStartDays: Math.max(1, Math.min(30, Math.round(Number(e.target.value)) || 1)),
                    })
                  }
                  disabled={busy}
                />
                <span className="text-sm font-normal text-foreground">day(s) past due</span>
              </div>
            </label>
          ) : null}
        </>
      )}

      {variant === "inbox" ? (
      <div>
        <p className="text-xs font-semibold text-muted">Inbox schedule visibility</p>
        <p className="mt-0.5 text-[11px] text-muted">
          Controls which automated reminders appear in Inbox → Schedule and the tab count.
        </p>
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="schedule-visibility"
              checked={draft.scheduleVisibilityMode === "all"}
              onChange={() => setDraft({ ...draft, scheduleVisibilityMode: "all" })}
              disabled={busy}
            />
            Show all upcoming scheduled messages
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="schedule-visibility"
              checked={draft.scheduleVisibilityMode === "days_before_send"}
              onChange={() => setDraft({ ...draft, scheduleVisibilityMode: "days_before_send" })}
              disabled={busy}
            />
            Show only
          </label>
          <div className="flex flex-wrap items-center gap-1 pl-6 text-sm">
            <Input
              className="h-8 w-14 text-xs"
              inputMode="numeric"
              value={visibilityDaysInput}
              onChange={(e) => setVisibilityDaysInput(e.target.value)}
              disabled={busy || draft.scheduleVisibilityMode !== "days_before_send"}
            />
            <span>days before send date</span>
          </div>
        </div>
      </div>
      ) : null}

      {variant === "inbox" ? (
      <div>
        <p className="text-xs font-semibold text-muted">{copy.templateLabel}</p>
        <Input
          className="mt-1"
          value={draft.templates.preDue.subject}
          onChange={(e) =>
            setDraft({
              ...draft,
              templates: { ...draft.templates, preDue: { ...draft.templates.preDue, subject: e.target.value } },
            })
          }
          disabled={busy}
        />
        <Textarea
          className="mt-2 min-h-[100px]"
          value={draft.templates.preDue.body}
          onChange={(e) =>
            setDraft({
              ...draft,
              templates: { ...draft.templates, preDue: { ...draft.templates.preDue, body: e.target.value } },
            })
          }
          disabled={busy}
        />
        <p className="mt-1 text-[11px] text-muted">
          Placeholders: {"{residentName}"}, {"{chargeTitle}"}, {"{balanceDue}"}, {"{dueDate}"}, {"{daysUntilDue}"}, {"{daysUntilDuePhrase}"}, {"{propertyLine}"}, {"{managerName}"}, {"{residentPortalLogin}"}
        </p>
      </div>
      ) : null}

      {saveVisible ? (
        <>
          {compact && variant === "payments" ? (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={applyToExisting}
                onChange={(e) => setApplyToExistingChoice(e.target.checked)}
                disabled={busy}
              />
              Apply to existing unpaid payments
            </label>
          ) : null}
          <Button
            type="button"
            variant="primary"
            className={`rounded-full ${compact && variant === "payments" ? "w-full" : ""}`}
            onClick={() => save()}
            disabled={!saveEnabled}
          >
            {copy.saveLabel}
          </Button>
        </>
      ) : null}
    </div>
    {compact && variant === "payments" ? (
      <ReminderMessageUpdateModal
        open={messageModalOpen}
        onClose={() => setMessageModalOpen(false)}
        subject={draft.templates.preDue.subject}
        body={draft.templates.preDue.body}
        placeholders='Placeholders: {residentName}, {chargeTitle}, {balanceDue}, {dueDate}, {daysUntilDue}, {daysUntilDuePhrase}, {propertyLine}, {managerName}, {residentPortalLogin}'
        onSave={(next) => {
          setDraft({
            ...draft,
            templates: {
              ...draft.templates,
              preDue: { subject: next.subject, body: next.body },
            },
          });
        }}
      />
    ) : null}
    </>
  );
}

export function PaymentAutomationSettingsPanel({
  settings,
  onSaved,
  onAfterSave,
  variant = "payments",
  layout = "card",
  autoSaveOnClose = false,
  formRef,
}: {
  settings: ManagerAutomationSettings;
  onSaved: (next: ManagerAutomationSettings) => void;
  onAfterSave?: () => void;
  variant?: ScheduleSettingsVariant;
  layout?: "card" | "modal";
  autoSaveOnClose?: boolean;
  formRef?: React.Ref<PaymentAutomationSettingsHandle>;
}) {
  return (
    <PaymentAutomationSettingsForm
      key={`${variant}:${layout}:${JSON.stringify(settings)}`}
      initialSettings={settings}
      onSaved={onSaved}
      onAfterSave={onAfterSave}
      variant={variant}
      layout={layout}
      autoSaveOnClose={autoSaveOnClose}
      formRef={formRef}
    />
  );
}

export async function patchScheduledMessage(
  messageId: string,
  patch: {
    cancelled?: boolean;
    cancelledBecausePaid?: boolean;
    customSubject?: string;
    customBody?: string;
    customDaysBeforeDue?: number;
    customSendAt?: string;
  },
): Promise<void> {
  const pathId = encodeScheduledMessagePathId(messageId);
  const res = await fetch(`/api/portal/scheduled-messages/${pathId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    if (isDemoModeActive() && patch.cancelled !== undefined) {
      mergeClientScheduledMessagePatch(messageId, patch);
      return;
    }
    throw new Error(await readPortalApiError(res, "Could not update reminder."));
  }
  mergeClientScheduledMessagePatch(messageId, patch);
}

/** Cancel upcoming auto reminders when a charge is marked paid (demo + immediate UI). */
export async function cancelFutureRemindersForPaidCharge(
  chargeId: string,
  messages: ScheduledPaymentMessage[],
): Promise<void> {
  const reminders = manageableRemindersForCharge(messages, chargeId, 50).filter((message) => message.status === "scheduled");
  await Promise.all(
    reminders.map((message) =>
      patchScheduledMessage(message.id, { cancelled: true, cancelledBecausePaid: true }),
    ),
  );
}

/** Restore auto reminders cancelled on paid when a charge moves back to pending. */
export async function restoreFutureRemindersForPendingCharge(chargeId: string): Promise<void> {
  const res = await fetch("/api/portal/scheduled-messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "restoreForPending", chargeId }),
  });
  if (!res.ok) {
    throw new Error(await readPortalApiError(res, "Could not restore reminders."));
  }
}

/**
 * Payment reminders autosaves: there is no Save button, and closing the dialog
 * commits whatever was changed. The form already had the machinery for it
 * (`autoSaveOnClose` + `saveIfDirty`); this just uses it, so a manager who
 * ticks a reminder and closes does not silently lose it.
 */
export function ReminderSettingsModal({
  open,
  onClose,
  settings,
  onSaved,
  variant = "payments",
}: {
  open: boolean;
  onClose: () => void;
  settings: ManagerAutomationSettings | null;
  onSaved: (next: ManagerAutomationSettings) => void;
  variant?: ScheduleSettingsVariant;
}) {
  const formRef = useRef<PaymentAutomationSettingsHandle | null>(null);
  const closeAndSave = useCallback(() => {
    // Close first: the save is silent and the dialog should not sit there while
    // the request runs. A failure still raises its own toast.
    onClose();
    void formRef.current?.saveIfDirty();
  }, [onClose]);

  if (!settings) return null;

  return (
    <Modal
      open={open}
      onClose={closeAndSave}
      title={variant === "inbox" ? "Schedule settings" : "Payment reminders"}
      dense={variant === "payments"}
      assistantContext={variant === "payments" ? "Payment reminders modal" : undefined}
      panelClassName={variant === "payments" ? cn("max-w-md p-3 sm:p-4", MODAL_TALL_PANEL_CLASS) : undefined}
      scrollableContent={false}
    >
      <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
      <PaymentAutomationSettingsPanel
        settings={settings}
        variant={variant}
        layout={variant === "payments" ? "modal" : "card"}
        autoSaveOnClose
        formRef={formRef}
        onSaved={onSaved}
      />
      </div>
    </Modal>
  );
}

export function useScheduledPaymentMessages(opts?: { includeHidden?: boolean }) {
  const applyVisibilityFilter = !(opts?.includeHidden ?? false);
  const query = "?includeHidden=1";
  const [settings, setSettings] = useState<ManagerAutomationSettings | null>(null);
  const [rawMessages, setRawMessages] = useState<ScheduledPaymentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [chargeRevision, setChargeRevision] = useState(0);
  const [settingsRevision, setSettingsRevision] = useState(0);

  const reload = useCallback(async () => {
    if (isDemoModeActive()) {
      const settings = DEFAULT_MANAGER_AUTOMATION_SETTINGS;
      const charges = readHouseholdCharges().filter((c) => c.status !== "paid");
      const messages = projectScheduledPaymentMessages({
        managerUserId: "demo",
        charges,
        settings,
        includeHidden: opts?.includeHidden ?? false,
      });
      setSettings(settings);
      setRawMessages(messages);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/portal/scheduled-messages${query}`, { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { settings: ManagerAutomationSettings; messages: ScheduledPaymentMessage[] };
      setSettings(body.settings);
      setRawMessages(mergeLocalChargeReminders(body.messages, body.settings, opts?.includeHidden ?? false));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const onChargesChanged = () => setChargeRevision((n) => n + 1);
    const onSettingsChanged = () => setSettingsRevision((n) => n + 1);
    const onClientOverrides = () => setSettingsRevision((n) => n + 1);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, onChargesChanged);
    window.addEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettingsChanged);
    window.addEventListener(CLIENT_SCHEDULED_MESSAGE_OVERRIDES_EVENT, onClientOverrides);
    return () => {
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, onChargesChanged);
      window.removeEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, onSettingsChanged);
      window.removeEventListener(CLIENT_SCHEDULED_MESSAGE_OVERRIDES_EVENT, onClientOverrides);
    };
  }, []);

  useEffect(() => {
    queueMicrotask(() => void reload());
  }, [chargeRevision, settingsRevision, reload]);

  const messages = useMemo(() => {
    void chargeRevision;
    void settingsRevision;
    let list = filterScheduledPaymentMessagesForUnpaidCharges(rawMessages, readHouseholdCharges());
    if (applyVisibilityFilter && settings) {
      list = filterScheduledPaymentMessagesForVisibility(list, settings);
    }
    /*
      Group before anyone counts them.

      The projection is per CHARGE, so a resident with six charges due the same
      day and four reminder times produced 24 scheduled rows — the captain saw
      "24 reminders scheduled" for one person and asked why six were repeats.
      The send side already bundles (one message per person per slot); this is
      the same grouping one layer down, so the schedule shows what will actually
      go out.

      Combining is idempotent — a bucket of one is left alone — so the two
      panels that already call it downstream are unaffected.
    */
    return combineScheduledPaymentMessages(applyClientPatchesToMessages(list));
  }, [rawMessages, chargeRevision, settingsRevision, settings, applyVisibilityFilter]);

  return { settings, messages, loading, reload, setSettings };
}
