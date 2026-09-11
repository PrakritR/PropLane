"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

export type InlineCheckboxOption = { value: string; label: string; hint?: string; disabled?: boolean };

/**
 * A visible checkbox grid — every choice on screen at once, aligned labels,
 * 44px rows. Used where the approved design shows options inline (lease types
 * offered, amenities) rather than behind a dropdown.
 */
export function InlineCheckboxGroup({
  label,
  hideLabel = false,
  options,
  selected,
  onChange,
  columns = 2,
  dataAttr,
  className,
}: {
  label: string;
  hideLabel?: boolean;
  options: readonly InlineCheckboxOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  columns?: 1 | 2 | 3;
  dataAttr?: string;
  className?: string;
}) {
  const id = useId();
  const picked = new Set(selected);
  return (
    <fieldset className={cn("min-w-0", className)} data-attr={dataAttr} aria-labelledby={`${id}-legend`}>
      <legend id={`${id}-legend`} className={cn("text-xs font-semibold uppercase tracking-wide text-muted", hideLabel && "sr-only")}>
        {label}
      </legend>
      <div
        className={cn(
          "grid gap-x-4 gap-y-0.5",
          columns === 1 ? "grid-cols-1" : columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
          !hideLabel && "mt-2",
        )}
      >
        {options.map((option) => {
          const checked = picked.has(option.value);
          return (
            <label
              key={option.value}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg px-1.5 py-2 transition hover:bg-[var(--secondary)]/50",
                option.disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded border-border accent-[var(--primary)]"
                checked={checked}
                disabled={option.disabled}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(option.value);
                  else next.delete(option.value);
                  onChange(options.map((o) => o.value).filter((v) => next.has(v)));
                }}
                data-attr={dataAttr ? `${dataAttr}-${option.value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : undefined}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                {option.hint ? <span className="block text-xs text-muted">{option.hint}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
