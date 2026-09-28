"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type WizardStep = {
  id: string;
  label: string;
};

export function WizardShell({
  steps,
  currentStepIndex,
  children,
  footer,
}: {
  steps: WizardStep[];
  currentStepIndex: number;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const progress = steps.length > 1 ? ((currentStepIndex + 1) / steps.length) * 100 : 100;
  // M006 — "the same transition is never used for both directions"
  // (interior.dev Wizard Steps). Derives forward/back from the change in
  // `currentStepIndex` between renders using the recognized
  // getDerivedStateFromProps-via-render pattern (an idempotent, bounded
  // `setState` call during render, not an effect) so the very render that
  // shows the new step already carries the right direction class — no extra
  // frame, no flash of the wrong transition.
  const [prevStepIndex, setPrevStepIndex] = useState(currentStepIndex);
  const [stepDirection, setStepDirection] = useState<"fwd" | "back" | null>(null);
  if (currentStepIndex !== prevStepIndex) {
    setStepDirection(currentStepIndex > prevStepIndex ? "fwd" : "back");
    setPrevStepIndex(currentStepIndex);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0 lg:flex-row">
      {/* Step rail */}
      <nav
        className="hidden shrink-0 flex-col gap-1 border-r border-border p-4 lg:flex lg:w-56"
        aria-label="Wizard steps"
      >
        {steps.map((step, i) => {
          const active = i === currentStepIndex;
          const done = i < currentStepIndex;
          return (
            <div
              key={step.id}
              className={`flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-sm transition-all ${
                active
                  ? "glass-card border-primary/20 bg-primary/5 font-semibold text-foreground"
                  : done
                    ? "text-muted"
                    : "text-muted/70"
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  active
                    ? "bg-primary text-white shadow-[0_4px_12px_-4px_rgba(47,107,255,0.6)]"
                    : done
                      ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
                      : "border border-border bg-card text-muted"
                }`}
              >
                {i + 1}
              </span>
              <span className="truncate">{step.label}</span>
            </div>
          );
        })}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Progress bar */}
        <div className="h-1 w-full shrink-0 bg-border/60" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div
            className="h-full transition-all duration-300 ease-out"
            style={{
              width: `${progress}%`,
              background: "linear-gradient(90deg, var(--primary) 0%, var(--sky) 100%)",
            }}
          />
        </div>

        <div
          key={currentStepIndex}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-4 sm:p-6",
            stepDirection === "fwd" && "motion-wiz-dir-fwd",
            stepDirection === "back" && "motion-wiz-dir-back",
          )}
        >
          {children}
        </div>

        {/* Footer dots + actions */}
        <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3 sm:px-6">
          <div className="flex items-center gap-1.5" aria-hidden>
            {steps.map((step, i) => (
              <span
                key={step.id}
                className={`h-1.5 rounded-full transition-all ${
                  i === currentStepIndex ? "w-4 bg-primary" : i < currentStepIndex ? "w-1.5 bg-primary/40" : "w-1.5 bg-border"
                }`}
              />
            ))}
          </div>
          {footer}
        </div>
      </div>
    </div>
  );
}

/** Compact 3-step progress strip for auth onboarding. */
export function WizardProgressStrip({
  steps,
  currentStepIndex,
}: {
  steps: string[];
  currentStepIndex: number;
}) {
  const progress = steps.length > 1 ? ((currentStepIndex + 1) / steps.length) * 100 : 100;

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        {steps.map((label, i) => (
          <div key={label} className="flex flex-1 flex-col items-center gap-1.5">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                i <= currentStepIndex
                  ? "bg-primary text-white"
                  : "border border-border bg-card text-muted"
              }`}
            >
              {i + 1}
            </span>
            <span className="hidden text-[10px] font-medium text-muted sm:block">{label}</span>
          </div>
        ))}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className="h-full transition-all duration-300"
          style={{
            width: `${progress}%`,
            background: "linear-gradient(90deg, var(--primary) 0%, var(--sky) 100%)",
          }}
        />
      </div>
    </div>
  );
}
