"use client";

import { cn } from "@/lib/utils";

/**
 * A small, fixed set of choices, shown as chips instead of hidden behind a select.
 *
 * A `<select>` costs two interactions and hides the alternatives until you open
 * it — worth it for a list of properties, indefensible for "All / Maintenance /
 * Reminder". Chips show every option, answer in one tap, and make the current
 * answer readable without opening anything.
 *
 * This is deliberately NOT a general select replacement. Above
 * {@link CHOICE_CHIPS_MAX_OPTIONS} the row wraps into something worse than the
 * select it replaced, and a set that can grow at runtime (properties,
 * residents, assignees) must stay a select whatever its length happens to be
 * today. {@link shouldRenderAsChips} is the one place that judgement lives.
 */

/** Above this, chips wrap into several rows and stop being faster than a menu. */
export const CHOICE_CHIPS_MAX_OPTIONS = 4;

/**
 * Whether a choice belongs in chips.
 *
 * `fixed` means the option set is part of the product, not part of the data —
 * task types are fixed, the properties a manager owns are not. A data-driven
 * set is never chips even when it happens to be short today, because the day it
 * grows nothing warns you.
 */
export function shouldRenderAsChips(optionCount: number, fixed: boolean): boolean {
  if (!fixed) return false;
  return optionCount >= 2 && optionCount <= CHOICE_CHIPS_MAX_OPTIONS;
}

export type ChoiceChipOption<T extends string> = {
  value: T;
  label: string;
};

export function ChoiceChips<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  dataAttr,
  disabled = false,
}: {
  /** Accessible group name — the same words the field label shows. */
  label: string;
  value: T;
  options: ReadonlyArray<ChoiceChipOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  dataAttr?: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot="choice-chips"
      data-attr={dataAttr}
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-selected={selected ? "true" : "false"}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              // 36px tall: the same target as every other control in a filter
              // panel, so a chip row does not read as a different class of thing.
              "inline-flex h-9 min-w-0 items-center rounded-full border px-3 text-xs font-semibold transition",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted hover:border-foreground/20 hover:text-foreground",
            )}
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
