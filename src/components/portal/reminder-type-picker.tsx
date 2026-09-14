"use client";

import { ChoiceChips } from "@/components/ui/choice-chips";
import { REMINDER_FIELD_LABEL_CLASS } from "@/components/portal/reminder-settings-shared";

export type ReminderTypeOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

/**
 * Top-of-section picker — one reminder type visible at a time.
 *
 * Two or three fixed choices ("Resident notification" / "Manager
 * notification"), so they are chips, not a dropdown: every alternative is on
 * the screen and the current one is readable without opening anything.
 */
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
      <p className={REMINDER_FIELD_LABEL_CLASS}>{label}</p>
      <ChoiceChips
        label={label}
        value={value}
        options={options.map((option) => ({ value: option.value, label: option.label }))}
        onChange={onChange}
        disabled={disabled}
        dataAttr={dataAttr}
      />
      {active?.description ? <p className="text-xs text-muted">{active.description}</p> : null}
    </div>
  );
}
