import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { MEETING_CONFIRMED_COLOR } from "@/components/portal/portal-calendar-panels";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { SLOT_DURATION_MINUTES, toLocalDateStr } from "@/lib/demo-admin-scheduling";
import { readManagerWorkOrderRows } from "@/lib/manager-work-orders-storage";
import { moduleRowVisibleToPortalUser } from "@/lib/manager-portfolio-access";

const SERVICE_VISIT_DURATION_MINUTES = 60;

const MANAGER_SELF_WORK_COLOR =
  "border-amber-300 bg-amber-100 text-amber-950 [html[data-theme=dark]_&]:border-amber-400/40 [html[data-theme=dark]_&]:bg-amber-500/15 [html[data-theme=dark]_&]:text-amber-100";

function workOrderPropertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

export function managerWorkOrderToCalendarMeeting(row: DemoManagerWorkOrderRow): DemoMeeting | null {
  if (!row.scheduledAtIso || row.bucket === "completed") return null;
  const start = new Date(row.scheduledAtIso);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + SERVICE_VISIT_DURATION_MINUTES * 60_000);
  const selfAssigned = Boolean(row.selfAssigned);
  return {
    id: `manager-service-${row.id}`,
    source: "external",
    sourceId: row.id,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateStr: toLocalDateStr(start),
    startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
    span: Math.max(1, Math.ceil(SERVICE_VISIT_DURATION_MINUTES / SLOT_DURATION_MINUTES)),
    durationMinutes: SERVICE_VISIT_DURATION_MINUTES,
    title: selfAssigned ? `My work · ${row.title}` : row.vendorName ? `${row.vendorName} · ${row.title}` : row.title,
    color: selfAssigned ? MANAGER_SELF_WORK_COLOR : MEETING_CONFIRMED_COLOR,
    statusLabel: selfAssigned ? "You" : row.vendorName ? `Vendor · ${row.vendorName}` : "Scheduled visit",
    name: row.residentName?.trim() || undefined,
    email: row.residentEmail?.trim() || undefined,
    kind: "service",
    propertyTitle: workOrderPropertyLabel(row),
    propertyId: row.propertyId ?? row.assignedPropertyId,
    notes: row.description || undefined,
  };
}

/** Scheduled vendor visits and manager self-assigned work orders for the services calendar. */
export function listManagerServiceCalendarMeetings(
  managerUserId: string,
  propertyScope?: string | string[] | null,
): DemoMeeting[] {
  const propertyIds = Array.isArray(propertyScope)
    ? propertyScope.map((id) => id.trim()).filter(Boolean)
    : propertyScope?.trim()
      ? [propertyScope.trim()]
      : [];
  return readManagerWorkOrderRows()
    .filter((row) => moduleRowVisibleToPortalUser(row, managerUserId, "services"))
    .filter((row) => row.bucket === "scheduled" || (row.bucket === "open" && Boolean(row.scheduledAtIso)))
    .filter((row) => {
      if (propertyIds.length === 0) return true;
      const rowPid = (row.propertyId ?? row.assignedPropertyId ?? "").trim();
      return propertyIds.some((id) => id === rowPid);
    })
    .map(managerWorkOrderToCalendarMeeting)
    .filter((m): m is DemoMeeting => m != null)
    .sort((a, b) => a.startIso.localeCompare(b.startIso));
}
