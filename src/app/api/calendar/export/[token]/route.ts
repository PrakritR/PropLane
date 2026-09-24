import { NextResponse } from "next/server";

import {
  loadConnectionByExportToken,
  loadPropertyRecord,
} from "@/lib/channel-calendar/sync.server";
import {
  importedRangesFromConnections,
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
  const { data } = await db
    .from("manager_application_records")
    .select(
      "id,assigned_property_id,property_id,choice:row_data->>assignedRoomChoice,preferred:row_data->application->>roomChoice1,lease_start:row_data->application->>leaseStart,lease_end:row_data->application->>leaseEnd,manual_start:row_data->manualResidentDetails->>moveInDate,manual_end:row_data->manualResidentDetails->>moveOutDate,manually_added:row_data->>manuallyAdded,bucket:row_data->>bucket",
    )
    .eq("manager_user_id", managerUserId)
    .eq("row_data->>bucket", "approved")
    .limit(500);
  const leases: { start: string; end: string }[] = [];
  const holds: { start: string; end: string }[] = [];
  const roomToken = `::${roomId}`;
  for (const row of data ?? []) {
    const property = String(row.assigned_property_id || row.property_id || "").trim();
    if (property && property !== propertyId) continue;
    const choice = String(row.choice || row.preferred || "");
    if (choice && !choice.endsWith(roomToken) && choice !== roomId) continue;
    const start = day(row.manual_start) || day(row.lease_start);
    if (!start) continue;
    const end = day(row.manual_end) || day(row.lease_end) || start;
    const range = { start, end };
    if (String(row.manually_added ?? "") === "true") holds.push(range);
    else leases.push(range);
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
    const { data: roomConnections } = await db
      .from("external_calendar_connections")
      .select("imported_ranges")
      .eq("property_id", connection.property_id)
      .eq("room_id", connection.room_id);
    const importedFromConnections = importedRangesFromConnections(roomConnections ?? []);
    const occupancy = await occupancyRangesForRoom(
      db,
      connection.manager_user_id,
      connection.property_id,
      connection.room_id,
    );
    const ranges = exportBlockedRanges({
      leases: occupancy.leases,
      holds: occupancy.holds,
      typedBlocks: [...typedBlocks, ...importedFromConnections],
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
