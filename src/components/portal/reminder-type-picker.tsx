"use client";

import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { REMINDER_FIELD_LABEL_CLASS } from "@/components/portal/reminder-settings-shared";

export type ReminderTypeOption<T extends string> = {
  value: T;
  label: string;
};

/**
 * Top-of-section picker — one reminder type visible at a time.
 *
 * A dropdown, like every other pick in settings (AGENTS.md § No subtext:
 * picks are dropdowns, never pills). With a single option there is nothing
 * to pick, so nothing is drawn: a one-entry "Reminder type" row only told
 * the manager what the section title already said.
 */
export function ReminderTypePicker<T extends string>({
  label = "Reminder",
  value,
  options,
  onChange,
  disabled,
  dataAttr = "reminder-type",
}: {
  label?: string;
  value: T;
  options: readonly ReminderTypeOption<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  dataAttr?: string;
}) {
  if (options.length <= 1) return null;

  return (
    <FieldSingleSelect
      label={label}
      labelClassName={REMINDER_FIELD_LABEL_CLASS}
      value={value}
      options={options.map((option) => ({ value: option.value, label: option.label }))}
      onChange={(next) => onChange(next as T)}
      disabled={disabled}
      dataAttr={dataAttr}
    />
  );
}
