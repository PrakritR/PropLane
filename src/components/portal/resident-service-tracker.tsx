"use client";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { formatServiceVisitLabel } from "@/lib/schedule-service-visit";
import { ServiceWorkflowStepper } from "@/components/portal/service-workflow-stepper";
import type { ServiceWorkflowStep } from "@/lib/manager-service-workflow";

function residentMaintenanceSteps(row: DemoManagerWorkOrderRow): ServiceWorkflowStep[] {
  const scheduled = Boolean(row.scheduledAtIso);
  const hired = Boolean(row.vendorId || row.vendorName);
  const done = row.bucket === "completed" || Boolean(row.completedAt);
  const reported = true;
  const sentToVendors = row.biddingOpen || hired;
  const quoteAccepted = hired;

  const raw = [
    { id: "reported", label: "Reported", done: reported, detail: "" },
    { id: "sent", label: "Sent to vendors", done: sentToVendors, detail: "" },
    { id: "quoted", label: "Quote accepted", done: quoteAccepted, detail: "" },
    { id: "scheduled", label: "Scheduled", done: scheduled || done, detail: row.scheduledAtIso ? formatServiceVisitLabel(row.scheduledAtIso) : "" },
    { id: "done", label: "Done", done, detail: "" },
  ];

  let currentIdx = raw.findIndex((s) => !s.done);
  if (currentIdx < 0) currentIdx = raw.length - 1;

  return raw.map((step, idx) => ({
    id: step.id,
    label: step.label,
    detail: step.detail,
    state: idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo",
  }));
}

export function ResidentServiceTracker({ row }: { row: DemoManagerWorkOrderRow }) {
  const steps = residentMaintenanceSteps(row);
  const banner =
    row.scheduledAtIso
      ? `Your pro starts ${formatServiceVisitLabel(row.scheduledAtIso)}`
      : null;

  return (
    <div className="space-y-3" data-attr="resident-service-tracker">
      {banner ? (
        <p className="rounded-xl border border-primary/25 bg-primary/5 px-3 py-2.5 text-sm font-medium text-foreground">
          {banner}
        </p>
      ) : null}
      <ServiceWorkflowStepper steps={steps} />
    </div>
  );
}
