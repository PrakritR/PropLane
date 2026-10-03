"use client";

import Link from "next/link";
import { Check, House, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResidentLifecycleCompactTracker } from "@/components/portal/resident-lifecycle-compact-tracker";
import {
  residentLifecycleSteps,
  resolveResidentLifecycleNextAction,
  type ResidentLifecycleInput,
} from "@/lib/resident-lifecycle-journey";

export type ResidentLifecycleSummaryRow = { label: string; value: string };

/**
 * The applicant's one status screen (studio journey-0930): whose turn it is and
 * the one thing to do, the six steps with who acts on each, what happens next,
 * and the facts of the move. Everything below the hero is read-only.
 */
export function ResidentLifecycleStatusPanel({
  input,
  summary = [],
  workspaceName,
}: {
  input: ResidentLifecycleInput;
  /** "Your move" facts — Home, Move-in, Rent, fee, Contact. Empty rows are left out. */
  summary?: ResidentLifecycleSummaryRow[];
  workspaceName?: string | null;
}) {
  const base = input.basePath?.trim() || "/resident";
  const steps = residentLifecycleSteps(input);
  const action = resolveResidentLifecycleNextAction({ ...input, workspaceName: workspaceName ?? input.workspaceName });
  const allDone = steps.every((step) => step.state === "done") && action.title === "You're all caught up";
  const upcoming = steps.filter((step) => step.state === "upcoming").slice(0, 3);
  const rows = summary.filter((row) => row.value.trim());
  const youTurn = action.who === "You";

  return (
    <div className="space-y-3.5" data-jr-status>
      <section className="rounded-2xl border border-border bg-card px-6 py-5 max-sm:px-4" data-jr-hero>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-extrabold uppercase tracking-[0.06em]"
          style={
            allDone
              ? { background: "var(--status-confirmed-bg)", color: "var(--status-confirmed-fg)" }
              : { background: "var(--accent)", color: "var(--primary)" }
          }
          data-jr-who
        >
          {allDone ? (
            <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
          ) : youTurn ? (
            <User className="size-3.5" strokeWidth={2.5} aria-hidden />
          ) : (
            <House className="size-3.5" strokeWidth={2.5} aria-hidden />
          )}
          {allDone ? "All done" : youTurn ? "Your turn" : `${action.who} is on it`}
        </span>
        <h2 className="mb-1 mt-2 text-2xl font-extrabold tracking-[-0.02em] max-sm:text-[21px]">
          {allDone ? "You’re moved in" : action.title}
        </h2>
        <p className="mb-4 text-sm text-muted">
          {allDone ? "Your home, payments and documents are in the menu." : action.detail}
        </p>
        <div className="flex flex-wrap gap-2.5">
          <Button asChild variant="primary">
            <Link href={allDone ? `${base}/move-in` : action.href}>{allDone ? "Open my home" : action.ctaLabel}</Link>
          </Button>
          {allDone ? null : (
            <Button asChild variant="outline">
              <Link href={`${base}/communication`}>
                {workspaceName?.trim() ? `Message ${workspaceName.trim()}` : "Message manager"}
              </Link>
            </Button>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card px-5 py-4">
        <ResidentLifecycleCompactTracker steps={steps} variant="full" />
      </section>

      {upcoming.length > 0 ? (
        <section className="rounded-2xl border border-border bg-card px-5 py-4" data-jr-next>
          <h3 className="mb-3 text-sm font-extrabold">What happens next</h3>
          {upcoming.map((step, index) => (
            <div
              key={step.id}
              className={`flex justify-between py-2.5 text-sm ${index > 0 ? "border-t border-border" : ""}`}
            >
              <span>{step.label}</span>
              <span className="font-semibold text-muted">{step.who}</span>
            </div>
          ))}
        </section>
      ) : null}

      {rows.length > 0 ? (
        <section className="rounded-2xl border border-border bg-card px-5 py-4">
          <h3 className="mb-3 text-sm font-extrabold">Your move</h3>
          {rows.map((row, index) => (
            <div
              key={row.label}
              className={`flex items-baseline justify-between gap-4 py-2.5 text-sm ${index > 0 ? "border-t border-border" : ""}`}
            >
              <span className="text-muted">{row.label}</span>
              <span className="min-w-0 text-right font-bold">{row.value}</span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
