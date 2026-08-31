"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { InboxScheduledCard, ScheduledMessageDetailModal } from "@/components/portal/portal-inbox-ui";
import { normalizeTourReminderMinutesBeforeList } from "@/lib/payment-automation-settings";

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
    <ScheduledMessageDetailModal open={open} onClose={onClose} title="Update message">
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
    </ScheduledMessageDetailModal>
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

function formatTourReminderTimingTriggerLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${remainder}m`;
}

function sortTourReminderMinutes(minutes: number[]): number[] {
  return normalizeTourReminderMinutesBeforeList(minutes);
}

export function TourReminderTimingSelect({
  minutesBeforeList,
  disabled,
  onChangeMinutesList,
}: {
  minutesBeforeList: number[];
  disabled?: boolean;
  onChangeMinutesList: (minutes: number[]) => void;
}) {
  const [customMinutesInput, setCustomMinutesInput] = useState("");
  const sorted = useMemo(() => sortTourReminderMinutes(minutesBeforeList), [minutesBeforeList]);
  const selectedTokens = sorted.map(String);
  const selectionTriggerLabel = sorted.length
    ? sorted.map((minutes) => formatTourReminderTimingTriggerLabel(minutes)).join(", ")
    : undefined;

  const presetOptions = TOUR_REMINDER_TIMING_PRESETS.map((minutes) => ({
    value: String(minutes),
    label: formatTourReminderTimingLabel(minutes),
  }));
  const customOptions = sorted
    .filter((minutes) => !TOUR_REMINDER_TIMING_PRESETS.includes(minutes as (typeof TOUR_REMINDER_TIMING_PRESETS)[number]))
    .map((minutes) => ({
      value: String(minutes),
      label: formatTourReminderTimingLabel(minutes),
    }));
  const options = [...customOptions, ...presetOptions];

  const commitSelection = (tokens: string[]) => {
    const next = sortTourReminderMinutes(tokens.map((token) => Number(token)).filter((n) => Number.isFinite(n)));
    onChangeMinutesList(next);
  };

  const addCustomMinutes = () => {
    const minutes = Math.round(Number(customMinutesInput.trim()));
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) return;
    commitSelection([...selectedTokens, String(minutes)]);
    setCustomMinutesInput("");
  };

  return (
    <div className="space-y-2">
      <CheckboxMultiSelect
        label="Reminders"
        labelClassName={REMINDER_FIELD_LABEL_CLASS}
        options={options}
        selected={selectedTokens}
        selectionTriggerLabel={selectionTriggerLabel}
        onChange={commitSelection}
        disabled={disabled}
        emptyLabel="Choose reminders…"
        dataAttr="tour-reminder-timing"
        menuFooter={
          <div className="px-3 py-2">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Custom minutes</p>
            <div className="flex gap-2">
              <Input
                type="number"
                min={5}
                max={1440}
                className="h-9 min-h-0 flex-1"
                placeholder="Minutes before tour"
                value={customMinutesInput}
                disabled={disabled}
                data-attr="tour-reminder-custom-minutes"
                onChange={(e) => setCustomMinutesInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomMinutes();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 rounded-full px-3 text-xs"
                disabled={disabled || !customMinutesInput.trim()}
                onClick={addCustomMinutes}
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
