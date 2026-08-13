"use client";

import { Modal } from "@/components/ui/modal";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { InboxScheduledCard } from "@/components/portal/portal-inbox-ui";

export const REMINDER_FIELD_LABEL_CLASS = "text-xs font-semibold text-muted";

export function ReminderSendViaField({
  viaEmail,
  viaSms,
  onChange,
  smsAvailable = true,
  smsLabel,
  footerNote,
  dataAttr = "reminder-send-via",
}: {
  viaEmail: boolean;
  viaSms: boolean;
  onChange: (next: { viaEmail: boolean; viaSms: boolean }) => void;
  smsAvailable?: boolean;
  smsLabel?: string;
  footerNote?: string;
  dataAttr?: string;
}) {
  const options = [
    { value: "email", label: "Email" },
    {
      value: "sms",
      label: smsLabel ?? (smsAvailable ? "SMS" : "SMS (not enabled)"),
      disabled: !smsAvailable,
    },
  ];
  const selected = [
    ...(viaEmail ? ["email"] : []),
    ...(viaSms ? ["sms"] : []),
  ];
  const effectiveSelected =
    selected.length > 0 ? selected : viaEmail || !smsAvailable ? ["email"] : ["sms"];
  const selectionTriggerLabel =
    effectiveSelected.includes("email") && effectiveSelected.includes("sms")
      ? "Email & SMS"
      : effectiveSelected.includes("sms")
        ? "SMS"
        : "Email";

  return (
    <div>
      <CheckboxMultiSelect
        label="Send via"
        labelClassName={REMINDER_FIELD_LABEL_CLASS}
        options={options}
        selected={effectiveSelected}
        selectionTriggerLabel={selectionTriggerLabel}
        onChange={(next) => {
          const enabled = next.filter((value) => value !== "sms" || smsAvailable);
          if (enabled.length === 0) return;
          onChange({
            viaEmail: enabled.includes("email"),
            viaSms: enabled.includes("sms"),
          });
        }}
        emptyLabel="Choose channels…"
        dataAttr={dataAttr}
      />
      {footerNote ? <p className="mt-1.5 text-xs text-muted">{footerNote}</p> : null}
    </div>
  );
}

export function ReminderMessagePreviewCard({
  subject,
  body,
  onUpdate,
  dataAttr = "reminder-update-message",
}: {
  subject: string;
  body: string;
  onUpdate: () => void;
  dataAttr?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <p className={REMINDER_FIELD_LABEL_CLASS}>Message</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">{subject || "Reminder"}</p>
      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{body}</p>
      <button
        type="button"
        className="mt-2 text-xs font-semibold text-primary hover:underline"
        onClick={onUpdate}
        data-attr={dataAttr}
      >
        Update message
      </button>
    </div>
  );
}

export function ReminderMessageUpdateModal({
  open,
  onClose,
  subject,
  body,
  placeholders,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  body: string;
  placeholders: string;
  onSave: (next: { subject: string; body: string }) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Update message"
      dense
      assistantStrip={false}
      panelClassName="max-w-lg p-3 sm:p-4"
    >
      <div className="space-y-3">
        <InboxScheduledCard
          sendLabel="Preview"
          subject={subject}
          body={body}
          meta="Placeholders are filled when the reminder sends."
          source="automation"
          editable
          presentation="detail"
          showSendActions={false}
          onCancel={onClose}
          onSendNow={() => {}}
          onSaveEdit={async (next) => {
            onSave(next);
          }}
        />
        <p className="text-[11px] text-muted">{placeholders}</p>
      </div>
    </Modal>
  );
}

export const TOUR_REMINDER_TIMING_PRESETS = [15, 30, 60, 120] as const;

export function formatTourReminderTimingLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes before tour`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hour${hours === 1 ? "" : "s"} before tour`;
  return `${hours}h ${remainder}m before tour`;
}

export function tourReminderTimingPresetValue(minutes: number): string {
  return TOUR_REMINDER_TIMING_PRESETS.includes(minutes as (typeof TOUR_REMINDER_TIMING_PRESETS)[number])
    ? String(minutes)
    : "custom";
}

export function TourReminderTimingSelect({
  minutesBefore,
  disabled,
  onChangeMinutes,
}: {
  minutesBefore: number;
  disabled?: boolean;
  onChangeMinutes: (minutes: number) => void;
}) {
  const presetValue = tourReminderTimingPresetValue(minutesBefore);
  const options = [
    ...TOUR_REMINDER_TIMING_PRESETS.map((minutes) => ({
      value: String(minutes),
      label: formatTourReminderTimingLabel(minutes),
    })),
    { value: "custom", label: "Custom" },
  ];

  return (
    <div className="space-y-2">
      <FieldSingleSelect
        label="Reminder timing"
        labelClassName={REMINDER_FIELD_LABEL_CLASS}
        options={options}
        value={presetValue}
        disabled={disabled}
        dataAttr="tour-reminder-timing"
        onChange={(next) => {
          if (next === "custom") return;
          onChangeMinutes(Number(next));
        }}
      />
      {presetValue === "custom" ? (
        <label className="block text-xs font-semibold uppercase tracking-[0.12em] text-muted">
          Custom minutes before tour
          <input
            type="number"
            min={5}
            max={1440}
            disabled={disabled}
            value={minutesBefore}
            onChange={(e) =>
              onChangeMinutes(Math.max(5, Math.min(1440, Number(e.target.value) || 30)))
            }
            className="mt-1.5 flex h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-primary/40 focus:ring-2 focus:ring-primary/15 disabled:opacity-50"
            data-attr="tour-reminder-minutes-before"
          />
        </label>
      ) : null}
    </div>
  );
}
