import { createHash } from "node:crypto";
import { resolveInspectionRoom, inspectionRoomListing } from "@/lib/inspections/room-template";
import type { SupabaseClient } from "@supabase/supabase-js";
import { roomInspectionRequirements } from "@/lib/inspections/requirements";
import type { InspectionKind, InspectionRecord } from "@/lib/inspections/model";
import { materializeReminders, type ReminderQueueRow } from "../queue.server";
import { loadReminderSettingsForManagers } from "../settings.server";
import { loadManagerReminderRecipients } from "../manager-recipients.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

type Placement = { id: string; manager_user_id: string; resident_email: string; property_id: string | null; assigned_property_id: string | null; row_data: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export function inspectionDueDate(row: Placement, kind: InspectionKind): string | null {
  const manual = object(row.row_data.manualResidentDetails), application = object(row.row_data.application);
  const raw = String(kind === "move-in" ? manual.moveInDate || application.leaseStart || "" : manual.moveOutDate || application.leaseEnd || "");
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  const date = slash ? `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = new Date(`${date}T19:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date ? value.toISOString() : null;
}
function assignment(row: Placement) { return String(row.row_data.assignedRoomChoice || object(row.row_data.manualResidentDetails).roomNumber || ""); }
function propertyId(row: Placement) { return row.assigned_property_id || row.property_id || ""; }
async function reportsForApplications(db: SupabaseClient, ids: string[]): Promise<InspectionRecord[]> {
  const reports: InspectionRecord[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await db.from("resident_inspections").select("*").in("application_id", ids).order("id").range(offset, offset + 499);
    if (result.error) throw result.error;
    reports.push(...(result.data ?? []) as InspectionRecord[]);
    if ((result.data ?? []).length < 500) return reports;
  }
}
function active(row: Placement) { return row.row_data.bucket === "approved" && !row.row_data.withdrawnAt; }
function canonicalAssignment(row: Placement, rooms: unknown): string {
  try { return resolveInspectionRoom(propertyId(row), assignment(row), String(object(row.row_data.manualResidentDetails).roomNumber || ""), inspectionRoomListing(rooms, [])).assignment; }
  catch { return ""; }
}
function sameRoom(report: InspectionRecord, row: Placement, rooms: unknown) {
  return report.property_id === propertyId(row) && report.manager_user_id === row.manager_user_id &&
    (report.document.roomScope?.assignment ?? report.room_label) === canonicalAssignment(row, rooms);
}
const hasEvidence = (report: InspectionRecord) => report.document.areas.some(a => a.items.some(i =>
  [i.manager, i.resident].some(o => o.notes.trim() || o.photos.length || o.condition !== "unchecked")));

/** Paginate narrow projections: no applicant identity documents or image bodies in a sweep. */
export async function sweepInspectionReminders(db: SupabaseClient, now = new Date()): Promise<number> {
  let queued = 0;
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await db.from("manager_application_records")
      .select("id,manager_user_id,resident_email,property_id,assigned_property_id,placement:row_data->>assignedRoomChoice,manual_start:row_data->manualResidentDetails->>moveInDate,manual_end:row_data->manualResidentDetails->>moveOutDate,manual_room:row_data->manualResidentDetails->>roomNumber,lease_start:row_data->application->>leaseStart,lease_end:row_data->application->>leaseEnd,bucket:row_data->>bucket,withdrawn:row_data->>withdrawnAt")
      .eq("row_data->>bucket", "approved").order("id").range(offset, offset + 99);
    if (error) throw error;
    const rows = (data ?? []).map(raw => ({ ...raw, row_data: { assignedRoomChoice: raw.placement, manualResidentDetails: { moveInDate: raw.manual_start, moveOutDate: raw.manual_end, roomNumber: raw.manual_room },
      application: { leaseStart: raw.lease_start, leaseEnd: raw.lease_end }, bucket: raw.bucket, withdrawnAt: raw.withdrawn } })) as unknown as Placement[];
    if (!rows.length) break;
    const ids = [...new Set(rows.map(propertyId).filter(Boolean))];
    const owners = [...new Set(rows.map(r => r.manager_user_id).filter(Boolean))];
    const [properties, reportsResult, settings, managers] = await Promise.all([
      db.from("manager_property_records").select("id,manager_user_id,rooms:property_data->listingSubmission->rooms,legacy_rooms:row_data->submission->rooms").in("id", ids),
      reportsForApplications(db, rows.map(r => r.id)),
      loadReminderSettingsForManagers(db, owners), loadManagerReminderRecipients(db, owners),
    ]);
    if (properties.error) throw properties.error;
    const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
    for (const row of rows.filter(active)) {
      const property = properties.data?.find(p => p.id === propertyId(row) && p.manager_user_id === row.manager_user_id);
      const config = settings.get(row.manager_user_id);
      if (!property || !config) continue;
      const manager = managers.get(row.manager_user_id);
      const reports = reportsResult.filter(r => r.application_id === row.id && sameRoom(r as InspectionRecord, row, property.rooms ?? property.legacy_rooms)) as InspectionRecord[];
      for (const kind of roomInspectionRequirements(property.id, assignment(row), property.rooms ?? property.legacy_rooms)) {
        const anchorIso = inspectionDueDate(row, kind);
        if (!anchorIso || reports.some(r => r.kind === kind && r.status === "completed")) continue;
        queued += await materializeReminders(db, { managerUserId: row.manager_user_id, kind: "inspection", subjectId: `${row.id}:${kind}:${createHash("sha256").update(`${anchorIso}:${canonicalAssignment(row, property.rooms ?? property.legacy_rooms)}`).digest("hex").slice(0, 20)}`, anchorIso,
          // Both sides. The rule's audience decides who actually receives it, but the
          // manager has to be OFFERED here or "remind me too" is unreachable from Settings.
          recipients: [{ email: row.resident_email, role: "counterparty" },
            ...(manager ? [{ email: manager.email, userId: row.manager_user_id, role: "manager" as const }] : [])],
          payload: { applicationId: row.id, inspectionKind: kind, roomAssignment: assignment(row), title: `Required ${kind} inspection`, url: `${origin}/resident/move-in/inspections` },
        }, config, now);
      }
      for (const report of reports) {
        if (!manager || report.status === "completed" || !hasEvidence(report) || (report.status === "submitted" && !report.document.residentAcknowledgment)) continue;
        queued += await materializeReminders(db, { managerUserId: row.manager_user_id, kind: "inspection_manager", subjectId: `${report.id}:${report.revision}`, anchorIso: report.updated_at,
          recipients: [{ email: manager.email, userId: row.manager_user_id, role: "manager" }],
          payload: { inspectionId: report.id, revision: report.revision, title: "Review room inspection", url: `${origin}/portal/inspections/${report.kind}/${report.id}` },
        }, config, now);
      }
    }
    if (rows.length < 100) break;
  }
  return queued;
}

/** Cancellation and room reassignment are checked again immediately before delivery. */
export async function inspectionReminderIsCurrent(db: SupabaseClient, queued: ReminderQueueRow): Promise<boolean> {
  if (queued.kind === "inspection_manager") {
    const { data, error } = await db.from("resident_inspections").select("*").eq("id", queued.payload.inspectionId).eq("manager_user_id", queued.managerUserId).maybeSingle();
    if (error) throw error;
    const report = data as InspectionRecord | null;
    if (!report) return false;
    const residency = await db.from("manager_application_records").select("id,manager_user_id,resident_email,property_id,assigned_property_id,row_data").eq("id", report.application_id).eq("manager_user_id", queued.managerUserId).maybeSingle();
    if (residency.error) throw residency.error;
    if (!residency.data || !active(residency.data as Placement)) return false;
    const property = await db.from("manager_property_records").select("rooms:property_data->listingSubmission->rooms,legacy_rooms:row_data->submission->rooms").eq("id", propertyId(residency.data as Placement)).eq("manager_user_id", queued.managerUserId).maybeSingle();
    if (property.error) throw property.error;
    if (!property.data || !sameRoom(report, residency.data as Placement, property.data.rooms ?? property.data.legacy_rooms)) return false;
    return Boolean(report.status !== "completed" && report.revision === queued.payload.revision && hasEvidence(report) &&
      (report.status === "draft" || report.document.residentAcknowledgment));
  }
  const { data, error } = await db.from("manager_application_records").select("id,manager_user_id,resident_email,property_id,assigned_property_id,row_data")
    .eq("id", queued.payload.applicationId).eq("manager_user_id", queued.managerUserId).maybeSingle();
  if (error) throw error;
  const row = data as Placement | null;
  const kind = queued.payload.inspectionKind;
  if (!row || !active(row) || (kind !== "move-in" && kind !== "move-out") || assignment(row) !== queued.payload.roomAssignment ||
      row.resident_email.toLowerCase() !== queued.recipientEmail.toLowerCase() || inspectionDueDate(row, kind) !== queued.payload.anchorIso) return false;
  const [property, reports] = await Promise.all([
    db.from("manager_property_records").select("rooms:property_data->listingSubmission->rooms,legacy_rooms:row_data->submission->rooms").eq("id", propertyId(row)).eq("manager_user_id", row.manager_user_id).maybeSingle(),
    db.from("resident_inspections").select("*").eq("application_id", row.id).eq("kind", kind).eq("status", "completed"),
  ]);
  if (property.error) throw property.error;
  if (reports.error) throw reports.error;
  return roomInspectionRequirements(propertyId(row), assignment(row), property.data?.rooms ?? property.data?.legacy_rooms).includes(kind) &&
    !(reports.data ?? []).some(r => sameRoom(r as InspectionRecord, row, property.data?.rooms ?? property.data?.legacy_rooms));
}
