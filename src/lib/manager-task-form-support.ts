import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import { createManualPlannedTourClient } from "@/lib/manual-planned-tour.client";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { compactTaskPropertyLabel } from "@/lib/manager-task-display";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import {
  readManagerWorkOrderRows,
  writeManagerWorkOrderRows,
} from "@/lib/manager-work-orders-storage";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import { formatPreferredArrival } from "@/lib/preferred-arrival";
import {
  type ResidentMaintenanceCategoryLabel,
  workOrderCategoryForResidentLabel,
} from "@/lib/work-order-taxonomy";

export const MANAGER_TASK_FORM_KINDS = ["general", "house", "tour", "work-order"] as const;
export type ManagerTaskFormKind = (typeof MANAGER_TASK_FORM_KINDS)[number];

export const MANAGER_TASK_FORM_KIND_LABELS: Record<ManagerTaskFormKind, string> = {
  general: "General task",
  house: "House task",
  tour: "Tour",
  "work-order": "Work order",
};

export type ManagerTaskResidentOption = {
  residentName: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  assignedRoomChoice?: string;
};

function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .split(" · ")[0]!
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

export function buildManagerTaskResidentOptions(managerUserId: string | null): ManagerTaskResidentOption[] {
  return readManagerApplicationRows()
    .filter(
      (row) =>
        isCurrentResidentApplicationRow(row) &&
        applicationVisibleToPortalUser(row, managerUserId) &&
        row.name?.trim() &&
        row.email?.trim().includes("@"),
    )
    .map((row) => {
      const propertyLabel = displayPropertyLabel(row.property?.trim() || "");
      const propertyId =
        row.assignedPropertyId?.trim() ||
        row.propertyId?.trim() ||
        row.application?.propertyId?.trim() ||
        "";
      const roomLabel =
        getRoomChoiceLabel(row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "")
          .split(" · ")[0]
          ?.trim() ||
        row.manualResidentDetails?.roomNumber?.trim() ||
        "";
      return {
        residentName: row.name.trim(),
        residentEmail: row.email!.trim().toLowerCase(),
        propertyId,
        propertyLabel: propertyLabel || "Property",
        roomLabel,
        assignedRoomChoice: row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim(),
      };
    })
    .sort((a, b) => {
      const byProperty = a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" });
      if (byProperty !== 0) return byProperty;
      return a.residentName.localeCompare(b.residentName, undefined, { sensitivity: "base" });
    });
}

export function residentsForManagerTaskProperty(
  residents: ManagerTaskResidentOption[],
  propertyId: string,
  propertyLabel: string,
): ManagerTaskResidentOption[] {
  if (!propertyId.trim()) return residents;
  return residents.filter(
    (resident) =>
      (resident.propertyId && resident.propertyId === propertyId) ||
      resident.propertyLabel.toLowerCase() === propertyLabel.toLowerCase(),
  );
}

export async function ensureManagerTaskResidentDirectory(): Promise<void> {
  await syncManagerApplicationsFromServer().catch(() => undefined);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MANAGER_APPLICATIONS_EVENT));
  }
}

export function createManagerWorkOrderFromTaskForm(input: {
  managerUserId: string;
  title: string;
  notes: string;
  categoryLabel: ResidentMaintenanceCategoryLabel;
  propertyId: string;
  propertyLabel: string;
  resident: ManagerTaskResidentOption;
}): DemoManagerWorkOrderRow {
  const id = `REQ-${Date.now()}`;
  const details =
    input.notes.trim() ||
    `${input.categoryLabel}: Maintenance request logged by your property manager.`;
  const row: DemoManagerWorkOrderRow = {
    id,
    propertyName: input.propertyLabel,
    propertyId: input.propertyId,
    assignedPropertyId: input.propertyId,
    assignedRoomChoice: input.resident.assignedRoomChoice,
    managerUserId: input.managerUserId,
    unit: input.resident.roomLabel || "—",
    title: input.title.trim(),
    priority: "Medium",
    status: "Submitted",
    bucket: "open",
    category: workOrderCategoryForResidentLabel(input.categoryLabel),
    description: details,
    scheduled: "—",
    cost: "—",
    preferredArrival: formatPreferredArrival("Anytime", ""),
    residentName: input.resident.residentName,
    residentEmail: input.resident.residentEmail,
    managerInitiated: true,
  };
  writeManagerWorkOrderRows([row, ...readManagerWorkOrderRows()]);
  return row;
}

export async function createManagerTourFromTaskForm(input: {
  managerUserId: string;
  propertyId: string;
  propertyLabel?: string;
  roomLabel?: string;
  guestName: string;
  guestEmail?: string;
  guestPhone?: string;
  start: string;
  end: string;
  notes?: string;
  assignee?: { type: "team" | "vendor"; id: string; name: string } | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return createManualPlannedTourClient(input.managerUserId, {
    propertyId: input.propertyId,
    propertyTitle: compactTaskPropertyLabel(input.propertyId, input.propertyLabel) ?? input.propertyLabel,
    roomLabel: input.roomLabel,
    guestName: input.guestName.trim(),
    guestEmail: input.guestEmail?.trim() || undefined,
    guestPhone: input.guestPhone?.trim() || undefined,
    start: input.start,
    end: input.end,
    notes: input.notes?.trim() || undefined,
    assignee: input.assignee ?? undefined,
  });
}

export function buildManagerTaskComposePrefill(input: {
  kind: ManagerTaskFormKind;
  title: string;
  notes: string;
  propertyLabel?: string;
  scheduleLabel?: string;
  recipientEmail?: string;
  recipientName?: string;
}): ManagerComposePrefill | null {
  const email = input.recipientEmail?.trim();
  if (!email?.includes("@")) return null;

  const name = input.recipientName?.trim() || "there";
  if (input.kind === "tour") {
    return {
      recipientEmail: email,
      subject: `Tour scheduled${input.propertyLabel ? ` · ${input.propertyLabel}` : ""}`,
      body: [
        `Hi ${name},`,
        "",
        "Your property tour is scheduled:",
        input.scheduleLabel ? `When: ${input.scheduleLabel}` : null,
        input.propertyLabel ? `Property: ${input.propertyLabel}` : null,
        input.notes.trim() ? `Notes: ${input.notes.trim()}` : null,
        "",
        "Reply if you need to reschedule.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (input.kind === "work-order") {
    return {
      recipientEmail: email,
      subject: `Maintenance request: ${input.title.trim()}`,
      body: [
        `Hi ${name},`,
        "",
        "Your property manager logged a maintenance request:",
        "",
        `Title: ${input.title.trim()}`,
        input.notes.trim() ? `Details: ${input.notes.trim()}` : null,
        "",
        "Sign in to your PropLane resident portal to view updates under Services.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return null;
}
