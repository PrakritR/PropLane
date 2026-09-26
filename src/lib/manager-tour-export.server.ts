import "server-only";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  PARTNER_INQUIRIES_RECORD_ID,
  PLANNED_EVENTS_RECORD_ID,
  projectScheduleRecordsForViewer,
  type ScheduleRecordUser,
} from "@/lib/schedule-record-projection.server";
import {
  filterManagerTourRows,
  sortManagerTourRowsForBucket,
  tourRowsFromInquiries,
  tourRowsFromPlannedEvents,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import type { ManagerTourBucketId } from "@/lib/portal-detail-routes";
import type { PartnerInquiry, PlannedEvent } from "@/lib/demo-admin-scheduling";
import type { ReportColumn, ReportResult, ReportRow } from "@/lib/reports/types";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

function ownedItem(item: Record<string, unknown>, user: ScheduleRecordUser): boolean {
  if (user.role === "admin") return true;
  const managerUserId = String(item.managerUserId ?? item.manager_user_id ?? "").trim();
  return managerUserId === user.id;
}

/**
 * The rows CSV/PDF export draws from — the exact same `ManagerTourRow` shape
 * and bucket/property/search filtering the on-screen Tours list uses
 * (`filterManagerTourRows`/`sortManagerTourRowsForBucket`), so an exported
 * row is never something the list itself would not show.
 *
 * Deliberately narrower than the list's own co-manager visibility for one
 * case: a peer's tour that the list may show as a free/busy calendar block
 * (`projectScheduleRecordsForViewer`'s "busy" projection, which strips guest
 * name/email/property title) is EXCLUDED here rather than exported as a
 * name-less, property-less row — an export is a document someone keeps, not
 * a transient UI hint, so it only ever contains tours this viewer fully owns
 * (their own `managerUserId`, or every tour when the viewer is an admin).
 */
export async function loadManagerTourExportRows(args: {
  db: Db;
  user: ScheduleRecordUser;
  bucket: ManagerTourBucketId;
  propertyFilters: string[];
  search: string;
}): Promise<ManagerTourRow[]> {
  const { db, user, bucket, propertyFilters, search } = args;

  const { data: rawRecords } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, record_type, row_data, updated_at")
    .in("id", [PLANNED_EVENTS_RECORD_ID, PARTNER_INQUIRIES_RECORD_ID]);

  const projected = await projectScheduleRecordsForViewer(
    db,
    user,
    (rawRecords ?? []) as Record<string, unknown>[],
  );

  let inquiryItems: PartnerInquiry[] = [];
  let plannedItems: PlannedEvent[] = [];
  for (const record of projected) {
    const id = String(record.id ?? "").trim();
    const rowData = record.row_data as { payload?: unknown } | null | undefined;
    const payload = Array.isArray(rowData?.payload) ? (rowData!.payload as Record<string, unknown>[]) : [];
    const owned = payload.filter((item) => ownedItem(item, user));
    if (id === PARTNER_INQUIRIES_RECORD_ID) inquiryItems = owned as unknown as PartnerInquiry[];
    else if (id === PLANNED_EVENTS_RECORD_ID) plannedItems = owned as unknown as PlannedEvent[];
  }

  let rows: ManagerTourRow[] = [...tourRowsFromInquiries(inquiryItems), ...tourRowsFromPlannedEvents(plannedItems)];

  // Same workspace narrowing the list applies client-side via
  // `activeWorkspacePropertyIds()`, resolved here from the viewer's own
  // server-side selection cookie so an export can never include a house
  // outside the active workspace.
  const workspaceScope = user.role === "admin" ? null : await activeWorkspacePropertyScope(db, user.id);
  if (workspaceScope !== null) {
    const allowed = new Set(workspaceScope);
    rows = rows.filter((row) => !row.propertyId || allowed.has(row.propertyId));
  }

  rows = filterManagerTourRows(rows, bucket, propertyFilters, search);
  return sortManagerTourRowsForBucket(rows, bucket);
}

const TOUR_EXPORT_COLUMNS: ReportColumn[] = [
  { key: "guest", label: "Guest", format: "text" },
  { key: "property", label: "Property", format: "text" },
  { key: "when", label: "When", format: "text" },
  { key: "format", label: "Format", format: "text" },
  { key: "status", label: "Status", format: "text" },
  { key: "email", label: "Email", format: "text" },
  { key: "phone", label: "Phone", format: "text" },
];

const BUCKET_TITLE: Record<ManagerTourBucketId, string> = {
  pending: "Tours — Pending",
  upcoming: "Tours — Upcoming",
  past: "Tours — Past",
};

/** Shapes export rows into the generic `ReportResult` every list export (CSV/PDF) already renders from. */
export function tourRowsToReportResult(rows: ManagerTourRow[], bucket: ManagerTourBucketId): ReportResult {
  const reportRows: ReportRow[] = rows.map((row) => ({
    guest: row.guestName,
    property: [row.propertyTitle, row.roomLabel].filter(Boolean).join(" · ") || "—",
    when: row.whenLabel,
    format: row.tourFormat === "virtual" ? "Virtual" : "In person",
    status: row.statusLabel,
    email: row.guestEmail || "—",
    phone: row.guestPhone || "—",
  }));
  return {
    id: `tours-${bucket}`,
    title: BUCKET_TITLE[bucket],
    columns: TOUR_EXPORT_COLUMNS,
    rows: reportRows,
  };
}
