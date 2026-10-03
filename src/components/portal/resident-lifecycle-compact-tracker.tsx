"use client";

import { Check } from "lucide-react";
import type { ResidentLifecycleStep } from "@/lib/resident-lifecycle-journey";

/** Six-step compact tracker — matches studio `jr-track is-compact` (journey-0930). */
export function ResidentLifecycleCompactTracker({ steps }: { steps: ResidentLifecycleStep[] }) {
  return (
    <ol
      className="grid list-none grid-cols-6 gap-1 p-0 [html[data-native]_&]:gap-0.5"
      data-jr-track
      aria-hidden
    >
      {steps.map((step, index) => (
        <li
          key={step.id}
          data-jr-step={index}
          data-state={step.state}
          className={`relative flex min-w-0 flex-col items-start gap-1.5 ${
            step.state === "upcoming" ? "text-muted" : "text-foreground"
          }`}
        >
          {index < steps.length - 1 ? (
            <span
              className="pointer-events-none absolute top-[13px] left-[30px] right-[-4px] hidden h-0.5 sm:block"
              style={{
                background: step.state === "done" ? "var(--foreground)" : "var(--border)",
              }}
            />
          ) : null}
          <span
            className="relative z-[1] inline-flex size-[26px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-xs font-extrabold"
            style={
              step.state === "done"
                ? { background: "var(--foreground)", borderColor: "var(--foreground)", color: "var(--card)" }
                : step.state === "current"
                  ? {
                      background: "var(--primary)",
                      borderColor: "var(--primary)",
                      color: "#fff",
                      boxShadow: "0 0 0 4px color-mix(in srgb, var(--primary) 22%, transparent)",
                    }
                  : { background: "var(--secondary)", borderColor: "var(--border)", color: "var(--muted)" }
            }
          >
            {step.state === "done" ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : index + 1}
          </span>
          <span className="flex min-w-0 flex-col gap-0">
            <b className="text-[10.5px] font-extrabold uppercase leading-tight tracking-[0.05em] [html[data-native]_&]:text-[9px]">
              {step.label}
            </b>
          </span>
        </li>
      ))}
    </ol>
  );
}
