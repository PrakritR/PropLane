import type { ReactNode } from "react";

/** Shared rental apply layout: label column left, control column right (sm+). */
export function ApplyFieldRow({
  label,
  hint,
  error,
  children,
  className = "",
  optional = false,
  inline = false,
  showRequiredMarker,
  labelClassName = "text-xs font-semibold text-foreground",
  fieldKey,
}: {
  label: ReactNode;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
  optional?: boolean;
  /** Label and control share one row (e.g. Yes/No pills). */
  inline?: boolean;
  /** Defaults to !optional. Use false on inline Yes/No rows — validation still applies. */
  showRequiredMarker?: boolean;
  /** e.g. larger text for long signer questions */
  labelClassName?: string;
  fieldKey?: string;
}) {
  const requiredMarker = showRequiredMarker ?? !optional;

  return (
    <div
      className={`grid gap-3 border-b border-border/60 py-4 last:border-b-0 sm:border-b-0 sm:py-4 sm:grid-cols-[minmax(168px,220px)_minmax(0,1fr)] ${inline ? "sm:items-center" : "sm:items-start"} ${className}`}
    >
      <div className={inline ? undefined : "sm:pt-2"}>
        <div
          className={
            inline
              ? `inline-flex flex-wrap items-baseline gap-x-1 ${labelClassName}`
              : labelClassName
          }
        >
          {label}
          {requiredMarker ? (
            <span className="text-primary" aria-hidden="true">
              {" *"}
            </span>
          ) : null}
          {optional ? <span className="font-normal text-muted/70">(optional)</span> : null}
        </div>
        {hint ? <p className="mt-1 text-[11px] leading-snug text-muted/70">{hint}</p> : null}
      </div>
      <div className="min-w-0" data-wizard-field={fieldKey}>
        {children}
        {error ? (
          <p className="mt-2 flex items-start gap-1.5 text-sm text-red-600">
            <span className="mt-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-100 text-[10px] font-bold leading-none text-red-700">
              !
            </span>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
