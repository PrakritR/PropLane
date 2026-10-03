"use client";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import { formatResidentShortDate } from "@/lib/manager-resident-lifecycle";

function rowValue(label: string, value: string) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="text-[13.5px] font-semibold text-foreground">{value}</span>
    </div>
  );
}

export function ManagerResidentBackgroundCheckPanel({ row }: { row: DemoApplicantRow }) {
  if (!applicationShowsBackgroundCheck(row)) {
    return <p className="text-sm text-muted">No background check for this resident.</p>;
  }

  const screening = row.screening;
  const check = row.backgroundCheck;
  const orderedAt = check?.orderedAt || screening?.orderedAt;
  const hasOrder = Boolean(check || screening || orderedAt);

  const status =
    check?.status === "complete"
      ? "Complete"
      : check?.status === "pending" || screening?.status === "queued" || screening?.status === "in_progress"
        ? orderedAt
          ? `Requested ${formatResidentShortDate(orderedAt) || orderedAt}`
          : "Pending"
        : hasOrder
          ? orderedAt
            ? `Requested ${formatResidentShortDate(orderedAt) || orderedAt}`
            : "Requested"
          : "Not started";

  const lineForProduct = (pending: string, clear: string, notRun: string) => {
    if (check?.status === "complete") {
      return check.result === "clear" ? clear : "Review";
    }
    if (check?.status === "pending" || check?.status === "canceled") return pending;
    if (screening?.status === "complete") return screening.recommendation === "strong_yes" ? clear : "Review";
    if (hasOrder) return pending;
    return notRun;
  };

  const credit = lineForProduct("Pending", "Clear", "Not run");
  const criminal = lineForProduct("Pending", "Clear", "Not run");
  const eviction = lineForProduct("Pending", "Clear", "Not run");

  return (
    <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm">
      <div className="border-b border-border/60 px-4 py-3">
        <h3 className="text-[13.5px] font-bold tracking-tight text-foreground">Background check</h3>
      </div>
      <div className="px-4 pb-2 pt-1">{rowValue("Status", status)}</div>
      <div className="px-4 pb-2">{rowValue("Credit", credit)}</div>
      <div className="px-4 pb-2">{rowValue("Criminal", criminal)}</div>
      <div className="px-4 pb-3">{rowValue("Eviction", eviction)}</div>
    </div>
  );
}
