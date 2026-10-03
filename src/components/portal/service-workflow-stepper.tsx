"use client";

import { cn } from "@/lib/utils";
import type { ServiceWorkflowStep } from "@/lib/manager-service-workflow";

export function ServiceWorkflowStepper({
  steps,
  vertical = true,
}: {
  steps: ServiceWorkflowStep[];
  vertical?: boolean;
}) {
  return (
    <div
      data-svc-steps
      className={cn(vertical ? "space-y-3" : "flex flex-wrap gap-3")}
    >
      {steps.map((step) => (
        <div
          key={step.id}
          className={cn(
            "mk-step flex gap-3",
            step.state === "done" && "is-done",
            step.state === "current" && "is-cur",
            step.state === "todo" && "is-todo",
          )}
        >
          <div
            className={cn(
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
              step.state === "done" && "bg-emerald-600 text-white",
              step.state === "current" && "bg-primary text-primary-foreground",
              step.state === "todo" && "border border-border bg-card text-muted",
            )}
            aria-hidden
          >
            {step.state === "done" ? "✓" : steps.indexOf(step) + 1}
          </div>
          <div className="min-w-0 flex-1">
            <p className="mk-step-l text-sm font-semibold text-foreground">{step.label}</p>
            {step.detail ? <p className="mt-0.5 text-xs text-muted">{step.detail}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
