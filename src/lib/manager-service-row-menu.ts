import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { managerServiceNextStep } from "@/lib/manager-service-workflow";
import type { ServiceRequest } from "@/lib/service-requests-storage";

export type ManagerServiceRowMenuItem = {
  id: string;
  label: string;
  danger?: boolean;
};

export function managerServiceRowMenuItems(
  row: DemoManagerWorkOrderRow,
  opts: { bidCount?: number; canPay?: boolean; communicationHref: string },
): ManagerServiceRowMenuItem[] {
  const bidCount = opts.bidCount ?? 0;
  const next = managerServiceNextStep(row, { bidCount, canPay: opts.canPay });
  const items: ManagerServiceRowMenuItem[] = [];

  if (!row.bucket || row.bucket !== "completed") {
    if (next?.key === "request-bids") {
      items.push({ id: "request-bids", label: "Request bids" });
      items.push({ id: "assign", label: row.vendorId || row.assignee ? "Reassign" : "Assign" });
    }
    if (next?.key === "compare-bids") {
      items.push({ id: "compare-bids", label: "Compare bids" });
      items.push({ id: "assign", label: row.vendorId || row.assignee ? "Reassign" : "Assign" });
    }
    if (!next && !row.vendorId && !row.assignee && !row.selfAssigned) {
      items.push({ id: "assign", label: "Assign" });
    }
    if (next?.key === "assign") {
      items.push({ id: "assign", label: row.vendorId || row.assignee ? "Reassign" : "Assign" });
    }
    if (next?.key === "schedule" || (row.scheduledAtIso && row.bucket === "scheduled")) {
      items.push({ id: "schedule", label: row.scheduledAtIso ? "Reschedule" : "Schedule" });
    }
    if (next?.key === "complete" || (row.bucket === "scheduled" && !row.automationStatus)) {
      items.push({ id: "complete", label: "Complete" });
    }
    if (next?.key === "approve-pay") {
      items.push({ id: "approve-invoice", label: "Pay" });
    }
    if (next?.key === "pay") {
      items.push({ id: "pay", label: "Pay" });
    }
  }

  items.push({ id: "message", label: "Message" });

  if (row.bucket !== "completed") {
    items.push({ id: "cancel", label: "Delete", danger: true });
  }

  return items;
}

/** Add-on service request row ⋯ — same surface as maintenance, different actions. */
export function managerServiceRequestRowMenuItems(req: ServiceRequest): ManagerServiceRowMenuItem[] {
  const items: ManagerServiceRowMenuItem[] = [];
  if (req.status === "pending") {
    items.push({ id: "approve", label: "Approve" });
    items.push({ id: "deny", label: "Deny" });
  }
  items.push({ id: "edit", label: "Edit" });
  items.push({ id: "message", label: "Message" });
  if (req.status !== "returned") {
    items.push({ id: "delete", label: "Delete", danger: true });
  }
  return items;
}
