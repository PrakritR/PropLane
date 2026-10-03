import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { managerServiceNextStep } from "@/lib/manager-service-workflow";

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
    if (next?.key === "publish") {
      items.push({ id: "publish", label: "Publish to vendors" });
    }
    if (next?.key === "compare-quotes") {
      items.push({ id: "compare-quotes", label: "Compare quotes" });
      items.push({ id: "assign", label: row.vendorId || row.assignee ? "Reassign" : "Assign" });
    }
    if (next?.key === "assign") {
      items.push({ id: "assign", label: row.vendorId || row.assignee ? "Reassign" : "Assign" });
    }
    if (next?.key === "schedule" || (row.scheduledAtIso && row.bucket === "scheduled")) {
      items.push({ id: "schedule", label: row.scheduledAtIso ? "Reschedule" : "Schedule" });
    }
    if (next?.key === "mark-done" || (row.bucket === "scheduled" && !row.automationStatus)) {
      items.push({ id: "mark-done", label: "Mark done" });
    }
    if (next?.key === "approve-pay") {
      items.push({ id: "approve-invoice", label: "Approve invoice" });
    }
    if (next?.key === "pay") {
      items.push({ id: "pay", label: "Pay" });
    }
  }

  items.push({ id: "message", label: "Message" });

  if (row.bucket !== "completed") {
    items.push({ id: "cancel", label: "Cancel service", danger: true });
  }

  return items;
}
