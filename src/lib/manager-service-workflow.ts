import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import { formatServiceVisitLabel } from "@/lib/schedule-service-visit";
import { parseMoneyAmount } from "@/lib/household-charges";

export type ManagerServiceAssignee =
  | { kind: "vendor"; id: string; name: string }
  | { kind: "team"; id: string; name: string }
  | null;

export type ServiceWorkflowStep = {
  id: string;
  label: string;
  state: "done" | "current" | "todo";
  detail?: string;
};

export type ManagerServiceNextStep = {
  key: string;
  label: string;
};

export function resolveWorkOrderAssignee(row: DemoManagerWorkOrderRow): ManagerServiceAssignee {
  if (row.assignee?.type === "team") {
    return { kind: "team", id: row.assignee.id, name: row.assignee.name };
  }
  if (row.assignee?.type === "vendor") {
    return { kind: "vendor", id: row.assignee.id, name: row.assignee.name };
  }
  if (row.selfAssigned) {
    return { kind: "team", id: row.managerUserId ?? "manager", name: "You" };
  }
  if (row.vendorId || row.vendorName) {
    return { kind: "vendor", id: row.vendorId ?? row.vendorName ?? "vendor", name: row.vendorName ?? "Vendor" };
  }
  return null;
}

export function workOrderCostCents(row: DemoManagerWorkOrderRow, acceptedBid?: WorkOrderBid | null): number | null {
  if (acceptedBid?.amountCents != null) {
    return acceptedBid.amountCents + (acceptedBid.materialsCents ?? 0);
  }
  if (row.vendorCostCents != null) {
    return row.vendorCostCents + (row.materialsCostCents ?? 0);
  }
  const parsed = parseMoneyAmount(row.cost ?? "");
  if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed * 100);
  return null;
}

export function managerServiceListCostFigure(
  row: DemoManagerWorkOrderRow,
  acceptedBid?: WorkOrderBid | null,
): string {
  return formatServiceMoney(workOrderCostCents(row, acceptedBid));
}

export function formatServiceMoney(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: dollars % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

export function managerServiceListStageLabel(
  row: DemoManagerWorkOrderRow,
  bidCount: number,
  _acceptedBid?: WorkOrderBid | null,
): string {
  if (row.bucket === "completed" && row.automationStatus === "paid") return "Paid";
  if (row.automationStatus === "vendor_marked_done") return "To pay";
  if (row.automationStatus === "paid") return "Paid";
  const assignee = resolveWorkOrderAssignee(row);
  if (row.scheduledAtIso) {
    return `Scheduled ${formatServiceVisitLabel(row.scheduledAtIso)}`;
  }
  if (assignee) return "Assigned";
  if (bidCount > 0) return `${bidCount} ${bidCount === 1 ? "bid" : "bids"}`;
  if (row.biddingOpen) return "Requested";
  return "New";
}

/**
 * The one next step of a service, from the lifecycle (`service-lifecycle.ts`): Request bids (nobody
 * asked yet) -> Compare bids (a submitted bid is waiting) -> Schedule -> Complete -> Pay. `bidCount`
 * counts SUBMITTED bids only; a service still waiting on vendors has no next step of its own.
 */
export function managerServiceNextStep(
  row: DemoManagerWorkOrderRow,
  opts: { bidCount?: number; canPay?: boolean } = {},
): ManagerServiceNextStep | null {
  if ((row.status ?? "").trim().toLowerCase() === "cancelled") return null;
  const assignee = resolveWorkOrderAssignee(row);
  const bidCount = opts.bidCount ?? 0;
  if (!assignee) {
    if (row.bucket === "scheduled" && !row.automationStatus) return { key: "complete", label: "Complete" };
    if (bidCount > 0) return { key: "compare-bids", label: "Compare bids" };
    if (row.biddingOpen) return null;
    return { key: "request-bids", label: "Request bids" };
  }
  if (row.automationStatus === "vendor_marked_done") {
    return { key: "approve-pay", label: "Pay" };
  }
  if (!row.scheduledAtIso && row.bucket !== "completed") {
    return { key: "schedule", label: "Schedule" };
  }
  if (row.bucket === "scheduled" && !row.automationStatus) {
    return { key: "complete", label: "Complete" };
  }
  if (assignee.kind === "vendor" && row.automationStatus === "paid") return null;
  if (assignee.kind === "vendor" && row.bucket === "completed" && !row.automationStatus && opts.canPay) {
    return { key: "pay", label: "Pay" };
  }
  return null;
}

export function managerServiceListFigure(
  row: DemoManagerWorkOrderRow,
  acceptedBid?: WorkOrderBid | null,
): string {
  const cents = workOrderCostCents(row, acceptedBid);
  return cents != null ? formatServiceMoney(cents) : "";
}
