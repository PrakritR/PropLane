"use client";

import { cn } from "@/lib/utils";

const TAX_STATUS_BUTTON =
  "min-h-9 rounded-full border px-4 py-1.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const TAX_STATUS_BUTTON_ACTIVE = "border-primary bg-primary text-primary-foreground";
const TAX_STATUS_BUTTON_IDLE = "border-border bg-card text-muted hover:border-primary/40 hover:text-foreground";

export function ExpenseTaxStatusToggle({
  deductible,
  onChange,
  compact = false,
  className,
}: {
  deductible: boolean;
  onChange: (deductible: boolean) => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      role="group"
      aria-label="Tax status"
      data-attr="expense-tax-status-toggle"
    >
      <button
        type="button"
        className={cn(
          TAX_STATUS_BUTTON,
          compact && "min-h-8 px-3 text-xs",
          deductible ? TAX_STATUS_BUTTON_ACTIVE : TAX_STATUS_BUTTON_IDLE,
        )}
        aria-pressed={deductible}
        onClick={() => onChange(true)}
        data-attr="expense-tax-status-deductible"
      >
        Deductible
      </button>
      <button
        type="button"
        className={cn(
          TAX_STATUS_BUTTON,
          compact && "min-h-8 px-3 text-xs",
          !deductible ? TAX_STATUS_BUTTON_ACTIVE : TAX_STATUS_BUTTON_IDLE,
        )}
        aria-pressed={!deductible}
        onClick={() => onChange(false)}
        data-attr="expense-tax-status-non-deductible"
      >
        Non-deductible
      </button>
    </div>
  );
}
