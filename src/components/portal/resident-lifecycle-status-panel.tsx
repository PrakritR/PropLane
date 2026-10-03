"use client";

import {
  residentLifecycleActorLine,
  residentLifecycleSteps,
  type ResidentLifecycleInput,
} from "@/lib/resident-lifecycle-journey";

export function ResidentLifecycleStatusPanel({ input }: { input: ResidentLifecycleInput }) {
  const steps = residentLifecycleSteps(input);
  const actor = residentLifecycleActorLine(steps);
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-jr-status>
      <ol className="flex flex-wrap gap-2">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`text-xs font-bold uppercase tracking-wide ${
              step.state === "current" ? "text-foreground" : step.state === "done" ? "text-primary" : "text-muted"
            }`}
          >
            {step.label}
          </li>
        ))}
      </ol>
      {actor ? (
        <p className="mt-3 text-sm font-semibold text-foreground">
          {actor.actor} · {actor.next}
        </p>
      ) : null}
    </div>
  );
}
