import type { LucideIcon } from "lucide-react";
import { AlertCircle, Calendar, Check, Clock, Scale, UserRound, Users, Wallet } from "lucide-react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { managerServiceListStageLabel, resolveWorkOrderAssignee } from "@/lib/manager-service-workflow";

export function managerServicePlaceLine(
  row: {
    residentName?: string | null;
    residentEmail?: string | null;
    propertyLabel?: string;
    unitLabel?: string | null;
  },
  assignee: ReturnType<typeof resolveWorkOrderAssignee>,
): string {
  const resident = row.residentName?.trim() || row.residentEmail?.trim() || "";
  const parts = [resident, row.propertyLabel, row.unitLabel?.trim() || null].filter(Boolean);
  if (assignee) {
    parts.push(assignee.kind === "team" ? `${assignee.name} · Team` : assignee.name);
  }
  return parts.join(" · ");
}

export function managerServiceStageFact(
  row: DemoManagerWorkOrderRow,
  bidCount: number,
): { icon: LucideIcon; text: string } {
  const label = managerServiceListStageLabel(row, bidCount);
  const lower = label.toLowerCase();
  let icon: LucideIcon = Clock;
  if (!resolveWorkOrderAssignee(row) && bidCount === 0 && !row.biddingOpen) {
    icon = AlertCircle;
    return { icon, text: "Unassigned" };
  }
  if (lower.includes("quote") || lower.includes("bid")) icon = Scale;
  else if (lower.startsWith("scheduled")) icon = Calendar;
  else if (lower.includes("paid") || lower.includes("done")) icon = Check;
  else if (lower.includes("payment") || lower.includes("invoice") || lower.includes("awaiting")) icon = Wallet;
  else if (lower.includes("hired") || lower.includes("assigned")) icon = UserRound;
  else if (lower.includes("published")) icon = Users;
  return { icon, text: label };
}
