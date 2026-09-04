import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import {
  readManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import type { ManagerServiceResidentOption } from "@/components/portal/pro-create-service-request-modal";

function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .split(" · ")[0]!
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

/** Resolve a current resident row for inbox workflow actions (work order / add-on service). */
export function resolveManagerServiceResidentByEmail(
  managerUserId: string | null,
  email: string,
): (ManagerServiceResidentOption & { assignedRoomChoice?: string }) | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return null;

  const row = readManagerApplicationRows().find(
    (candidate) =>
      isCurrentResidentApplicationRow(candidate) &&
      applicationVisibleToPortalUser(candidate, managerUserId) &&
      candidate.email?.trim().toLowerCase() === normalized,
  );
  if (!row) return null;

  const propertyId =
    row.assignedPropertyId?.trim() ||
    row.propertyId?.trim() ||
    row.application?.propertyId?.trim() ||
    "";
  const assignedRoomChoice =
    row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  const roomLabel =
    getRoomChoiceLabel(assignedRoomChoice).split(" · ")[0]?.trim() ||
    row.manualResidentDetails?.roomNumber?.trim() ||
    "";

  return {
    residentEmail: normalized,
    residentName: row.name?.trim() || "Resident",
    propertyId,
    propertyLabel: displayPropertyLabel(row.property?.trim() || "") || "Property",
    roomLabel,
    assignedRoomChoice: assignedRoomChoice || undefined,
  };
}
