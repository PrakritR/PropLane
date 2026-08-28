import "server-only";

import { isAdminUser } from "@/lib/auth/admin-preview";
import { syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { getShareablePropertyForUser } from "@/lib/manager-property-share-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { formatRangeLabel } from "@/lib/tour-inquiry-confirm.server";
import { canAssign, normalizeAssignee, type WorkAssignee } from "@/lib/work-assignment";
import { isActivePlannedTourEvent } from "@/lib/tour-slot-math";
import { PLANNED_RECORD_ID, rowsFromRecord } from "@/lib/tour-inquiry-confirm.server";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ManualPlannedTourInput = {
  propertyId: string;
  propertyTitle?: string;
  roomLabel?: string;
  guestName: string;
  guestEmail?: string;
  guestPhone?: string;
  start: string;
  end: string;
  notes?: string;
  assignee?: WorkAssignee | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

async function managerCanScheduleTourOnProperty(
  db: Db,
  managerUserId: string,
  propertyId: string,
): Promise<{ ok: true; propertyTitle: string } | { ok: false; error: string }> {
  const shareable = await getShareablePropertyForUser(managerUserId, propertyId);
  if (shareable) {
    const street = shareable.address.split(",")[0]?.trim();
    const title = street || shareable.buildingName?.trim() || shareable.title?.trim() || "Property";
    return { ok: true, propertyTitle: title };
  }

  const { data: record, error } = await db
    .from("manager_property_records")
    .select("manager_user_id, property_data")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!record) return { ok: false, error: "Property not found." };

  const property = asObject(record.property_data);
  const street = textField(property, "address").split(",")[0]?.trim();
  const fallbackTitle =
    street ||
    textField(property, "buildingName") ||
    textField(property, "title") ||
    "Property";

  if (record.manager_user_id === managerUserId) {
    return { ok: true, propertyTitle: fallbackTitle };
  }

  if (await isAdminUser(managerUserId)) {
    return { ok: true, propertyTitle: fallbackTitle };
  }

  const { data: linkRows } = await db
    .from("account_link_invites")
    .select("assigned_property_ids")
    .eq("status", "accepted")
    .or(`inviter_user_id.eq.${managerUserId},invitee_user_id.eq.${managerUserId}`);
  for (const row of (linkRows ?? []) as { assigned_property_ids?: unknown }[]) {
    if (!Array.isArray(row.assigned_property_ids)) continue;
    for (const pid of row.assigned_property_ids) {
      if (typeof pid === "string" && pid.trim() === propertyId) {
        return { ok: true, propertyTitle: fallbackTitle };
      }
    }
  }

  return { ok: false, error: "You do not have access to this property." };
}

function plannedTourOverlaps(
  plannedRows: Record<string, unknown>[],
  managerUserId: string,
  start: string,
  end: string,
): boolean {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return plannedRows.some((event) => {
    if (textField(event, "kind") !== "tour") return false;
    if (!isActivePlannedTourEvent(event)) return false;
    if (textField(event, "managerUserId") !== managerUserId) return false;
    const evStart = new Date(textField(event, "start")).getTime();
    const evEnd = new Date(textField(event, "end")).getTime();
    if (![evStart, evEnd].every(Number.isFinite)) return false;
    return startMs < evEnd && evStart < endMs;
  });
}

export type CreateManualPlannedTourResult =
  | { ok: true; plannedEvent: Record<string, unknown>; message: string }
  | { ok: false; status: number; error: string };

export async function createManualPlannedTour(
  db: Db,
  actorUserId: string,
  input: ManualPlannedTourInput,
): Promise<CreateManualPlannedTourResult> {
  const managerUserId = actorUserId.trim();
  const propertyId = input.propertyId.trim();
  const guestName = input.guestName.trim();
  const start = input.start.trim();
  const end = input.end.trim();

  if (!managerUserId) return { ok: false, status: 401, error: "Unauthorized." };
  if (!propertyId) return { ok: false, status: 400, error: "Property is required." };
  if (!guestName) return { ok: false, status: 400, error: "Guest name is required." };
  if (!start || !end) return { ok: false, status: 400, error: "Start and end time are required." };
  if (Date.parse(end) <= Date.parse(start)) {
    return { ok: false, status: 400, error: "End time must be after start time." };
  }

  const property = await managerCanScheduleTourOnProperty(db, managerUserId, propertyId);
  if (!property.ok) return { ok: false, status: 403, error: property.error };

  const assignee = normalizeAssignee(input.assignee);
  if (assignee && !canAssign(assignee.type, "tour")) {
    return { ok: false, status: 400, error: "This assignee cannot take tours." };
  }

  const { data: plannedRecord, error: plannedReadError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (plannedReadError) return { ok: false, status: 500, error: plannedReadError.message };

  const plannedRows = rowsFromRecord(plannedRecord?.row_data);
  if (plannedTourOverlaps(plannedRows, managerUserId, start, end)) {
    return {
      ok: false,
      status: 409,
      error: "That time is already booked. Pick another slot.",
    };
  }

  const plannedEvent: Record<string, unknown> = {
    id: crypto.randomUUID(),
    title: `Tour · ${guestName}`,
    start,
    end,
    kind: "tour",
    managerUserId,
    propertyId,
    propertyTitle: input.propertyTitle?.trim() || property.propertyTitle,
    roomLabel: input.roomLabel?.trim() || undefined,
    adminUserId: managerUserId,
    attendeeName: guestName,
    attendeeEmail: input.guestEmail?.trim() || undefined,
    attendeePhone: input.guestPhone?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    assignee: assignee ?? undefined,
  };

  const { error: writeError } = await db.from("portal_schedule_records").upsert({
    id: PLANNED_RECORD_ID,
    manager_user_id: null,
    property_id: propertyId,
    record_type: PLANNED_RECORD_ID,
    starts_at: start,
    ends_at: end,
    row_data: {
      id: PLANNED_RECORD_ID,
      recordType: PLANNED_RECORD_ID,
      managerUserId: null,
      propertyId: null,
      payload: [...plannedRows, plannedEvent],
    },
    updated_at: new Date().toISOString(),
  });
  if (writeError) return { ok: false, status: 500, error: writeError.message };

  await syncPlannedTourToGoogleCalendar(db, managerUserId, {
    plannedEventId: String(plannedEvent.id),
    title: String(plannedEvent.title),
    start,
    end,
    propertyTitle: textField(plannedEvent, "propertyTitle") || undefined,
    attendeeName: guestName,
    attendeeEmail: textField(plannedEvent, "attendeeEmail") || undefined,
    attendeePhone: textField(plannedEvent, "attendeePhone") || undefined,
    notes: textField(plannedEvent, "notes") || undefined,
  }).catch(() => undefined);

  return {
    ok: true,
    plannedEvent,
    message: formatRangeLabel(start, end),
  };
}
