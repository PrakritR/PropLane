"use client";

import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import { compactLifecycleLabel, type ResidentLifecycleStep } from "@/lib/resident-lifecycle-journey";

/** Six-step compact tracker — matches studio `jr-track is-compact` (journey-0930). */
export function ResidentLifecycleCompactTracker({
  steps,
  variant = "compact",
}: {
  steps: ResidentLifecycleStep[];
  /** `full` adds each step's sentence-case label and who acts (the application status screen). */
  variant?: "compact" | "full";
}) {
  const full = variant === "full";
  // Phone, compact: six columns share the card, but the CURRENT step prints its full label
  // ("Application received", "Pay move-in") where the rest print a short word, so it gets the wider
  // column. Every label then sits under its own number and wraps inside that column.
  const compactColumns = steps
    .map((step) => (step.state === "current" ? "minmax(0,1.35fr)" : "minmax(0,1fr)"))
    .join(" ");
  return (
    <ol
      className={`grid list-none p-0 ${
        full
          ? "grid-cols-1 gap-0 sm:grid-cols-6 sm:gap-2"
          : "grid-cols-6 gap-1 max-sm:gap-0.5 max-sm:[grid-template-columns:var(--jr-cols)] [html[data-native]_&]:gap-0.5"
      }`}
      style={full ? undefined : ({ "--jr-cols": compactColumns } as CSSProperties)}
      data-jr-track
      aria-hidden={full ? undefined : true}
    >
      {steps.map((step, index) => (
        <li
          key={step.id}
          data-jr-step={index}
          data-state={step.state}
          className={`relative flex min-w-0 gap-1.5 ${
            full ? "flex-row items-center gap-3 py-2 sm:flex-col sm:items-start sm:gap-2 sm:py-0" : "flex-col items-start"
          } ${step.state === "upcoming" ? "text-muted" : "text-foreground"}`}
        >
          {index < steps.length - 1 ? (
            <span
              className={`pointer-events-none absolute top-[13px] hidden h-0.5 sm:block ${
                full ? "left-[34px] right-[-8px]" : "left-[30px] right-[-4px]"
              }`}
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
          <span className="flex w-full min-w-0 flex-col gap-px">
            {full ? (
              <>
                <b
                  className="text-[12.5px] font-extrabold leading-tight"
                  style={step.state === "current" ? { color: "var(--primary)" } : undefined}
                >
                  {step.label}
                </b>
                <i className="text-[11.5px] not-italic text-muted">{step.state === "done" ? "Done" : step.who}</i>
              </>
            ) : (
              <b
                className="block w-full min-w-0 max-w-full text-[10px] font-extrabold leading-tight tracking-tight [overflow-wrap:anywhere] max-[374px]:text-[9px] sm:text-[10.5px] [html[data-native]_&]:text-[10px]"
                style={step.state === "current" ? { color: "var(--primary)" } : undefined}
              >
                {compactLifecycleLabel(step)}
              </b>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
