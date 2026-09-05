"use client";

import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { REMINDER_FIELD_LABEL_CLASS } from "@/components/portal/reminder-settings-shared";

export type ReminderTypeOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

/** Top-of-section picker — one reminder type visible at a time. */
export function ReminderTypePicker<T extends string>({
  label = "Reminder type",
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
  const active = options.find((option) => option.value === value);

  return (
    <div className="space-y-1.5">
      <FieldSingleSelect
        label={label}
        labelClassName={REMINDER_FIELD_LABEL_CLASS}
        value={value}
        options={options.map((option) => ({ value: option.value, label: option.label }))}
        onChange={(next) => onChange(next as T)}
        disabled={disabled}
        dataAttr={dataAttr}
      />
      {active?.description ? <p className="text-xs text-muted">{active.description}</p> : null}
    </div>
  );
}
