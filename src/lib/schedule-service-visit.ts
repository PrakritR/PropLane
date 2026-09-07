/**
 * Shared commit path for the Services "Schedule visit" popup (PRP-403 / PRP-404).
 *
 * Assigns the vendor (or self), moves the work order to Scheduled, creates a
 * task for the assignee, notifies the resident, emails the vendor when one is
 * assigned, and leaves a PropLane inbox note for the manager.
 */

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { track } from "@/lib/analytics/track-client";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForWorkOrder,
} from "@/lib/manager-scheduled-work-tasks";
import { updateManagerWorkOrder } from "@/lib/manager-work-orders-storage";
import { readActiveManagerVendorRows } from "@/lib/manager-vendors-storage";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import type { WorkAssignee } from "@/lib/work-assignment";
import { notifyResidentOfWorkOrderUpdate } from "@/lib/work-order-resident-notifications";

export type ScheduleVisitAssigneeChoice =
  | { kind: "self" }
  | { kind: "vendor"; vendorId: string };

export function formatServiceVisitLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function visitEndIso(startIso: string, durationMinutes = 60): string {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return startIso;
  return new Date(start + durationMinutes * 60_000).toISOString();
}

export function buildManagerVisitScheduledNotice(input: {
  title: string;
  scheduledLabel: string;
  assigneeName: string;
  propertyLabel?: string;
  residentName?: string;
}): { subject: string; text: string } {
  const title = input.title.trim() || "Service";
  const property = input.propertyLabel?.trim();
  const resident = input.residentName?.trim();
  return {
    subject: `Visit scheduled: ${title}`,
    text: [
      `A visit was scheduled for "${title}".`,
      `When: ${input.scheduledLabel}`,
      `Assigned to: ${input.assigneeName}`,
      property ? `Property: ${property}` : "",
      resident ? `Resident: ${resident}` : "",
      "",
      "PropLane",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function sendVendorVisitEmail(
  row: DemoManagerWorkOrderRow,
  iso: string,
  scheduledLabel: string,
): Promise<boolean> {
  if (row.selfAssigned || !row.vendorId) return false;
  const vendor = readActiveManagerVendorRows().find((v) => v.id === row.vendorId);
  const vendorEmail = vendor?.email?.trim() ?? "";
  if (!vendor || !vendorEmail.includes("@")) return false;
  if (isDemoModeActive()) return false;
  try {
    const res = await fetch("/api/portal/send-vendor-visit-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        workOrderId: row.id,
        vendorId: vendor.id,
        vendorEmail,
        vendorName: vendor.name,
        workOrderTitle: row.title,
        propertyLabel: row.propertyName,
        unit: row.unit,
        visitLabel: scheduledLabel,
        description: row.description,
        preferredArrival: row.preferredArrival,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type ScheduleServiceVisitResult = {
  ok: boolean;
  error?: string;
  scheduledLabel?: string;
  vendorEmailed?: boolean;
};

/**
 * Assign + schedule + task + resident/manager messages. Best-effort side effects
 * never undo the work-order write once the bucket flip lands.
 */
export async function scheduleServiceVisit(input: {
  managerUserId: string;
  managerName?: string | null;
  row: DemoManagerWorkOrderRow;
  visitAtIso: string;
  assignee: ScheduleVisitAssigneeChoice;
}): Promise<ScheduleServiceVisitResult> {
  const { managerUserId, row, visitAtIso, assignee } = input;
  if (!visitAtIso.trim() || Number.isNaN(Date.parse(visitAtIso))) {
    return { ok: false, error: "Choose a visit date and time to schedule." };
  }

  const scheduledLabel = formatServiceVisitLabel(visitAtIso);
  let assigneeName = input.managerName?.trim() || "You";
  let taskAssignee: WorkAssignee = {
    type: "team",
    id: managerUserId,
    name: assigneeName,
  };
  let nextRow: DemoManagerWorkOrderRow = { ...row };

  if (assignee.kind === "self") {
    nextRow = {
      ...nextRow,
      vendorId: undefined,
      vendorName: undefined,
      vendorAssignedAt: undefined,
      selfAssigned: true,
    };
  } else {
    const vendor = readActiveManagerVendorRows().find((v) => v.id === assignee.vendorId);
    if (!vendor) return { ok: false, error: "Vendor not found." };
    const assignedAt = new Date().toISOString();
    assigneeName = vendor.name?.trim() || "Vendor";
    taskAssignee = { type: "vendor", id: vendor.id, name: assigneeName };
    nextRow = {
      ...nextRow,
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorAssignedAt: assignedAt,
      selfAssigned: false,
    };
  }

  nextRow = {
    ...nextRow,
    bucket: "scheduled",
    status: "Scheduled",
    scheduledAtIso: visitAtIso,
    scheduled: scheduledLabel,
  };

  updateManagerWorkOrder(row.id, () => nextRow);

  void createScheduledWorkTask(managerUserId, {
    title: scheduledTaskTitleForWorkOrder(nextRow.title),
    propertyId: nextRow.propertyId || nextRow.assignedPropertyId,
    propertyTitle: nextRow.propertyName,
    roomLabel: nextRow.unit,
    start: visitAtIso,
    end: visitEndIso(visitAtIso),
    assignee: taskAssignee,
    taskType: "work_order",
    urgency: "scheduled",
    priority: "medium",
    linkedWorkOrderId: nextRow.id,
    notes: nextRow.description?.trim() || undefined,
  });

  const vendorEmailed = await sendVendorVisitEmail(nextRow, visitAtIso, scheduledLabel);

  if (!isDemoModeActive()) {
    void notifyResidentOfWorkOrderUpdate("visit_scheduled", nextRow, { scheduledLabel }).then(
      (notify) => {
        if (notify.ok) {
          track("work_order_resident_notified", {
            stage: "visit_scheduled",
            work_order_id: nextRow.id,
          });
        }
      },
    );

    const managerNotice = buildManagerVisitScheduledNotice({
      title: nextRow.title,
      scheduledLabel,
      assigneeName,
      propertyLabel: nextRow.propertyName,
      residentName: nextRow.residentName,
    });
    void deliverPortalInboxMessage({
      fromName: "PropLane Portal",
      toUserIds: [managerUserId],
      subject: managerNotice.subject,
      text: managerNotice.text,
      eventCategory: "maintenance",
      deliverViaEmail: false,
      deliverViaSms: false,
    });
  }

  return { ok: true, scheduledLabel, vendorEmailed };
}
