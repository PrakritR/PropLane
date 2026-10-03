import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import { formatServiceVisitLabel } from "@/lib/schedule-service-visit";
import type { ServiceWorkflowStep } from "@/lib/manager-service-workflow";

/** Vendors see a general area before hire — never the street address or entry notes. */
export function workOrderGeneralArea(row: Pick<DemoManagerWorkOrderRow, "propertyAddress" | "propertyName">): string {
  const addr = row.propertyAddress?.trim();
  if (addr) {
    const parts = addr.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const city = parts[parts.length - 2];
      if (city && !/^\d/.test(city)) return city;
    }
  }
  const name = row.propertyName?.trim();
  if (name && name.includes(",")) return name.split(",")[0]!.trim();
  return name || "Nearby";
}

/** After hire the vendor sees the full site (address, resident, entry). */
export function vendorCanSeeFullWorkOrderSite(
  row: DemoManagerWorkOrderRow,
  bid?: WorkOrderBid | null,
): boolean {
  if (bid?.status === "accepted") return true;
  if (row.vendorAssignedAt && row.vendorId && !row.biddingOpen) return true;
  if (row.bucket === "scheduled" || row.bucket === "completed") {
    return Boolean(row.vendorId || row.vendorName);
  }
  return false;
}

export function vendorServiceWorkflowSteps(
  row: DemoManagerWorkOrderRow,
  bid?: WorkOrderBid | null,
): ServiceWorkflowStep[] {
  const hired = vendorCanSeeFullWorkOrderSite(row, bid);
  const quoted = Boolean(bid);
  const scheduled = Boolean(row.scheduledAtIso);
  const done = row.bucket === "completed" || Boolean(row.completedAt);
  const paid = row.automationStatus === "paid";

  const raw = [
    { id: "lead", label: "Lead", done: true, detail: workOrderGeneralArea(row) },
    { id: "quoted", label: "Quoted", done: quoted, detail: "" },
    { id: "hired", label: "Hired", done: hired, detail: "" },
    {
      id: "scheduled",
      label: "Scheduled",
      done: scheduled || done,
      detail: row.scheduledAtIso ? formatServiceVisitLabel(row.scheduledAtIso) : "",
    },
    { id: "done", label: "Done", done, detail: "" },
    { id: "paid", label: "Paid", done: paid, detail: "" },
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

export function vendorLeadMapsQuery(row: DemoManagerWorkOrderRow): string {
  const area = workOrderGeneralArea(row);
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(area)}`;
}
