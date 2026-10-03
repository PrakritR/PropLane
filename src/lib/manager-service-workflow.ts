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

function workOrderCostCents(row: DemoManagerWorkOrderRow, acceptedBid?: WorkOrderBid | null): number | null {
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
  if (row.automationStatus === "vendor_marked_done") return "Awaiting payment";
  if (row.automationStatus === "paid") return "Paid";
  const assignee = resolveWorkOrderAssignee(row);
  if (row.scheduledAtIso) {
    return `Scheduled ${formatServiceVisitLabel(row.scheduledAtIso)}`;
  }
  if (assignee) return assignee.kind === "team" ? "Assigned" : "Hired";
  if (bidCount > 0) return `${bidCount} ${bidCount === 1 ? "quote" : "quotes"}`;
  if (row.biddingOpen) return "Published";
  return "New";
}

export function managerServiceWorkflowSteps(
  row: DemoManagerWorkOrderRow,
  opts: { bidCount?: number; acceptedBid?: WorkOrderBid | null } = {},
): ServiceWorkflowStep[] {
  const assignee = resolveWorkOrderAssignee(row);
  const bidCount = opts.bidCount ?? 0;
  const accepted = opts.acceptedBid;
  const isVendorJob = assignee?.kind === "vendor";
  const scheduled = Boolean(row.scheduledAtIso);
  const done = row.bucket === "completed" || Boolean(row.completedAt);
  const paid = row.automationStatus === "paid";
  const invoicePending = row.automationStatus === "vendor_marked_done";
  const cost = formatServiceMoney(workOrderCostCents(row, accepted));

  const assignedDetail = assignee
    ? isVendorJob
      ? [assignee.name, cost].filter(Boolean).join(" · ")
      : `${assignee.name} · Team`
    : bidCount > 0
      ? `${bidCount} ${bidCount === 1 ? "bid" : "bids"}`
      : row.biddingOpen
        ? "Waiting for bids"
        : "";

  const steps: Omit<ServiceWorkflowStep, "state">[] = [
    { id: "reported", label: "Reported", detail: row.completedAt ? undefined : undefined },
    { id: "assigned", label: "Assigned", detail: assignedDetail },
    { id: "scheduled", label: "Scheduled", detail: row.scheduledAtIso ? formatServiceVisitLabel(row.scheduledAtIso) : "" },
    { id: "done", label: "Done", detail: done ? "Marked done" : "" },
  ];

  if (!assignee || isVendorJob) {
    let paidDetail = "";
    if (invoicePending) paidDetail = cost ? `Invoice to approve · ${cost}` : "Invoice to approve";
    else if (paid && cost) paidDetail = cost;
    else if (row.automationStatus === "vendor_marked_done") paidDetail = "Awaiting approval";
    steps.push({ id: "paid", label: "Paid", detail: paidDetail });
  }

  const flags = {
    reported: true,
    assigned: Boolean(assignee) || bidCount > 0 || Boolean(row.biddingOpen),
    scheduled: scheduled || done,
    done,
    paid: paid || invoicePending,
  };

  const order = steps.map((s) => s.id);
  let currentId: string = "reported";
  if (!flags.assigned) currentId = "assigned";
  else if (!flags.scheduled) currentId = "scheduled";
  else if (!flags.done) currentId = "done";
  else if (steps.some((s) => s.id === "paid") && !flags.paid) currentId = "paid";
  else currentId = steps[steps.length - 1]!.id;

  return steps.map((step) => {
    const idx = order.indexOf(step.id);
    const curIdx = order.indexOf(currentId);
    let state: ServiceWorkflowStep["state"] = "todo";
    if (idx < curIdx) state = "done";
    else if (idx === curIdx) state = "current";
    return { ...step, state };
  });
}

export function managerServiceNextStep(
  row: DemoManagerWorkOrderRow,
  opts: { bidCount?: number; canPay?: boolean } = {},
): ManagerServiceNextStep | null {
  const assignee = resolveWorkOrderAssignee(row);
  const bidCount = opts.bidCount ?? 0;
  if (!assignee) {
    if (bidCount > 0) return { key: "compare-quotes", label: "Compare quotes" };
    if (row.biddingOpen) return { key: "compare-quotes", label: "Compare quotes" };
    return { key: "assign", label: "Assign" };
  }
  if (row.automationStatus === "vendor_marked_done") {
    return { key: "approve-pay", label: "Approve invoice" };
  }
  if (!row.scheduledAtIso && row.bucket !== "completed") {
    return { key: "schedule", label: "Schedule" };
  }
  if (row.bucket === "scheduled" && !row.automationStatus) {
    return { key: "mark-done", label: "Mark done" };
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
