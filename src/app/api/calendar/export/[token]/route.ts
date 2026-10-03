import { NextResponse } from "next/server";

import {
  loadConnectionByExportToken,
  loadPropertyRecord,
} from "@/lib/channel-calendar/sync.server";
import {
  listingSubmissionFromProperty,
  roomUnavailableRangesForExport,
} from "@/lib/channel-calendar/connections.server";
import { generateIcsCalendar } from "@/lib/ical/generate";
import { exportBlockedRanges } from "@/lib/occupancy/snapshot";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function day(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

async function occupancyRangesForRoom(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  managerUserId: string,
  propertyId: string,
  roomId: string,
): Promise<{ leases: { start: string; end: string }[]; holds: { start: string; end: string }[] }> {
  const { data, error } = await db
    .from("manager_application_records")
    .select(
      "id,assigned_property_id,property_id,choice:row_data->>assignedRoomChoice,preferred:row_data->application->>roomChoice1,lease_start:row_data->application->>leaseStart,lease_end:row_data->application->>leaseEnd,manual_start:row_data->manualResidentDetails->>moveInDate,manual_end:row_data->manualResidentDetails->>moveOutDate,manually_added:row_data->>manuallyAdded,bucket:row_data->>bucket,ical_connection:row_data->>icalConnectionId",
    )
    .eq("manager_user_id", managerUserId)
    .eq("row_data->>bucket", "approved")
    .limit(500);
  if (error) throw new Error(error.message);
  const leases: { start: string; end: string }[] = [];
  const holds: { start: string; end: string }[] = [];
  const roomToken = `::${roomId}`;
  for (const row of data ?? []) {
    if (row.ical_connection) continue;
    const property = String(row.assigned_property_id || row.property_id || "").trim();
    if (property !== propertyId && !String(row.choice || row.preferred || "").startsWith(`${propertyId}::`)) continue;
    const choice = String(row.choice || row.preferred || "");
    if (choice && !choice.endsWith(roomToken) && choice !== roomId) continue;
    const start = day(row.manual_start) || day(row.lease_start);
    if (!start) continue;
    const end = day(row.manual_end) || day(row.lease_end) || start;
    const range = { start, end };
    if (String(row.manually_added ?? "") === "true") holds.push(range);
    else leases.push(range);
  }
  const { data: blocks, error: blockError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .eq("record_type", "room_date_block");
  if (blockError) throw new Error(blockError.message);
  for (const block of blocks ?? []) {
    const row = block.row_data as Record<string, unknown> | null;
    if (!row || row.bookingStatus === "cancelled") continue;
    if (row.roomId && row.roomId !== roomId) continue;
    const start = day(row.checkIn);
    const checkout = day(row.checkOut);
    if (!start || !checkout || checkout <= start) continue;
    holds.push({ start, end: new Date(Date.parse(`${checkout}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) });
  }
  return { leases, holds };
}

/** Public iCal export for Airbnb "Import calendar" — token is the only auth. */
export async function GET(
  _req: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token: rawToken } = await context.params;
    const exportToken = decodeURIComponent(rawToken).replace(/\.ics$/i, "").trim();
    if (!exportToken) {
      return new NextResponse("Not found", { status: 404 });
    }

    const db = createSupabaseServiceRoleClient();
    const connection = await loadConnectionByExportToken(db, exportToken);
    if (!connection) {
      return new NextResponse("Not found", { status: 404 });
    }

    const record = await loadPropertyRecord(db, connection.property_id);
    const submission = listingSubmissionFromProperty(record?.property ?? null);
    const typedBlocks = roomUnavailableRangesForExport(submission, connection.room_id);
    const occupancy = await occupancyRangesForRoom(
      db,
      connection.manager_user_id,
      connection.property_id,
      connection.room_id,
    );
    const ranges = exportBlockedRanges({
      leases: occupancy.leases,
      holds: occupancy.holds,
      typedBlocks,
    });
    const room = submission?.rooms.find((r) => r.id === connection.room_id);
    const calendarName = connection.label?.trim() || room?.name?.trim() || "PropLane calendar";
    const body = generateIcsCalendar(ranges, { calendarName, uidPrefix: connection.id });

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="proplane-${connection.room_id}.ics"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new NextResponse("Failed to build calendar.", { status: 500 });
  }
}
