"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A short, fixed set of independently switchable choices, shown as chips
 * instead of hidden behind a checkbox dropdown.
 *
 * `ChoiceChips` is the single-answer version of this. A `CheckboxMultiSelect`
 * costs a click to open, a scan of a menu, and a click to close — and while
 * it is open it covers whatever sits under it — for a set the manager already
 * knows by heart ("30 · 21 · 14 · 7 days before"). Chips put every option and
 * its current state on the screen at once; one tap flips one.
 *
 * Like `ChoiceChips`, this is for option sets that are part of the product,
 * not part of the data. Properties, residents and assignees stay a select: a
 * data-driven set has no natural size, and the day it grows nothing warns you.
 * Unlike `ChoiceChips` there is no four-option cap — a schedule of nine day
 * chips wraps to two short rows and is still faster than a menu.
 */
export type ToggleChipOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  /** Tooltip — used for a hint like "Custom day — turn off to remove". */
  title?: string;
};

export const TOGGLE_CHIP_CLASS =
  // 36px tall: the same target as every other control in a panel, so a chip
  // row does not read as a different class of thing.
  "inline-flex h-9 min-w-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const TOGGLE_CHIP_ON_CLASS = "border-primary bg-primary text-primary-foreground";
export const TOGGLE_CHIP_OFF_CLASS =
  "border-border bg-card text-muted hover:border-foreground/20 hover:text-foreground";

export function ToggleChips<T extends string>({
  label,
  options,
  selected,
  onChange,
  disabled = false,
  className,
  dataAttr,
  trailing,
}: {
  /** Accessible group name — the same words the field label shows. */
  label: string;
  options: ReadonlyArray<ToggleChipOption<T>>;
  selected: ReadonlyArray<T>;
  onChange: (next: T[]) => void;
  disabled?: boolean;
  className?: string;
  dataAttr?: string;
  /**
   * Rendered after the last chip, inside the same wrapping row — the place for
   * an "+ Custom" affordance or an inline input that belongs with the chips.
   */
  trailing?: ReactNode;
}) {
  const toggle = (value: T) => {
    if (selected.includes(value)) {
      onChange(selected.filter((entry) => entry !== value));
      return;
    }
    onChange([...selected, value]);
  };

  return (
    <div
      role="group"
      aria-label={label}
      data-slot="toggle-chips"
      data-attr={dataAttr}
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
    >
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            data-selected={on ? "true" : "false"}
            disabled={disabled || option.disabled}
            title={option.title}
            data-attr={dataAttr ? `${dataAttr}-${option.value}` : undefined}
            onClick={() => toggle(option.value)}
            className={cn(TOGGLE_CHIP_CLASS, on ? TOGGLE_CHIP_ON_CLASS : TOGGLE_CHIP_OFF_CLASS)}
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        );
      })}
      {trailing}
    </div>
  );
}

/**
 * The small uppercase heading that splits one chip field into named rows
 * ("Before due" / "On & after"). Same voice as the group headers the dropdown
 * it replaces used to draw inside its menu.
 */
export function ToggleChipsGroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{children}</p>
  );
}
