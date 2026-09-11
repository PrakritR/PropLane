"use client";

/**
 * "Your next steps" on the resident dashboard: the move-in and move-out
 * condition reports for the resident's own room, each a required obligation
 * with a due date, opening straight into the report. A resident has no general
 * task list — these two are the tasks.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { INSPECTIONS_CHANGED, loadInspectionList, type InspectionList } from "@/lib/inspections/client";
import type { InspectionKind } from "@/lib/inspections/model";
import { isDemoModeActive } from "@/lib/demo/demo-session";

type NextStep = {
  key: string;
  kind: InspectionKind;
  title: string;
  detail: string;
  required: boolean;
  done: boolean;
  href: string;
};

const KIND_LABEL: Record<InspectionKind, string> = { "move-in": "move-in", "move-out": "move-out" };

function stepsFromList(list: InspectionList, basePath: string): NextStep[] {
  const steps: NextStep[] = [];
  for (const residency of list.residencies) {
    for (const kind of ["move-in", "move-out"] as const) {
      const report = list.reports.find((r) => r.application_id === residency.id && r.kind === kind);
      const required = residency.requiredKinds?.includes(kind) ?? false;
      const due = kind === "move-in" ? residency.moveInDate : residency.moveOutDate;
      if (!required && !report) continue;
      const done = Boolean(report && report.photos.resident > 0);
      // `room` is the assignment key on some rows (`<property>::<room>`), a
      // display label on others; never print a key to a resident.
      const roomLabel = residency.room && !residency.room.includes("::") ? residency.room : "";
      const room = [residency.property, roomLabel].filter(Boolean).join(" · ");
      steps.push({
        key: `${residency.id}:${kind}`,
        kind,
        title: done ? `${kind === "move-in" ? "Move-in" : "Move-out"} inspection photos added` : `Complete ${KIND_LABEL[kind]} inspection`,
        detail: [room, required ? "Required" : "Optional", due ? `due ${due}` : null].filter(Boolean).join(" · "),
        required,
        done,
        href: report
          ? `${basePath}/inspections/${kind}/${encodeURIComponent(report.id)}`
          : `${basePath}/inspections/${kind}`,
      });
    }
  }
  // Open obligations first, move-in before move-out.
  return steps.sort((a, b) => Number(a.done) - Number(b.done) || (a.kind === "move-in" ? -1 : 1));
}

export function ResidentInspectionNextSteps({
  userId,
  basePath = "/resident",
  trailing,
}: {
  userId: string | null | undefined;
  basePath?: string;
  /** Extra rows the dashboard already knows about (lease review, etc.). */
  trailing?: React.ReactNode;
}) {
  const [steps, setSteps] = useState<NextStep[] | null>(null);

  useEffect(() => {
    if (!userId || isDemoModeActive()) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    const load = (force = false) =>
      loadInspectionList(userId, "resident", undefined, force)
        .then((list) => {
          if (!cancelled) setSteps(stepsFromList(list, basePath));
        })
        .catch(() => {
          if (!cancelled) setSteps([]);
        });
    void load();
    const onChange = () => void load(true);
    window.addEventListener(INSPECTIONS_CHANGED, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(INSPECTIONS_CHANGED, onChange);
    };
  }, [userId, basePath]);

  if (steps === null) return null;
  if (steps.length === 0 && !trailing) return null;

  return (
    <section
      className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm"
      data-attr="resident-next-steps"
    >
      <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Your next steps</h2>
      <ul className="mt-2 divide-y divide-border">
        {steps.map((step) => (
          <li key={step.key}>
            <Link
              href={step.href}
              data-attr={`resident-next-step-${step.kind}`}
              className="flex min-h-12 items-center gap-3 py-2.5 transition hover:bg-[var(--secondary)]/40"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-foreground">{step.title}</span>
                <span className="block text-sm text-muted">{step.detail}</span>
              </span>
              {step.done ? (
                <Badge tone="success">Done</Badge>
              ) : step.required ? (
                <Badge tone="info">Required</Badge>
              ) : null}
              <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
            </Link>
          </li>
        ))}
        {trailing}
      </ul>
    </section>
  );
}
