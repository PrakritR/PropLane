import { NextResponse } from "next/server";

import {
  loadConnectionByExportToken,
  loadPropertyRecord,
} from "@/lib/channel-calendar/sync.server";
import {
  listingSubmissionFromProperty,
  roomUnavailableRangesForExport,
} from "@/lib/channel-calendar/connections.server";
import { importedRangesForFeed, type FeedConnection, type FeedPlacement } from "@/lib/channel-calendar/export-feed";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
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
): Promise<{ leases: { start: string; end: string }[]; holds: { start: string; end: string }[]; importPlacements: FeedPlacement[] }> {
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
  const importPlacements: FeedPlacement[] = [];
  for (const row of data ?? []) {
    if (row.ical_connection) {
      // A stay a channel brought in. Whether it reaches this feed depends on the destination
      // channel, decided by importedRangesForFeed; it is never PropLane's own occupancy.
      const importedStart = day(row.manual_start) || day(row.lease_start);
      if (importedStart) importPlacements.push({ connectionId: String(row.ical_connection), start: importedStart, end: day(row.manual_end) || day(row.lease_end) || importedStart });
      continue;
    }
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
  return { leases, holds, importPlacements };
}

/** Public iCal export for Airbnb "Import calendar" — token is the only auth. */
export async function GET(
  req: Request,
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
    // The token's connection names the channel this link is pasted into; its own bookings are
    // left out so they do not echo back. A token shared by several connections (older links) or
    // a `?channels=all` link (VRBO / other sites) carries every channel's bookings instead.
    const { data: siblingRows } = await db
      .from("external_calendar_connections")
      .select("*")
      .eq("property_id", connection.property_id);
    const siblings: FeedConnection[] = (siblingRows ?? []).map((row) => {
      const parsed = parseConnectionRow(row as Record<string, unknown>);
      return { id: parsed.id, roomId: parsed.room_id, provider: parsed.provider, importedRanges: parsed.imported_ranges ?? [], exportToken: parsed.export_token };
    });
    const sharesToken = siblings.filter((c) => c.exportToken === exportToken).length > 1;
    const allChannels = sharesToken || new URL(req.url).searchParams.get("channels") === "all";
    const imported = importedRangesForFeed({
      propertyId: connection.property_id,
      roomId: connection.room_id,
      destination: allChannels ? null : connection.provider,
      connections: siblings,
      placements: occupancy.importPlacements,
    });
    const ranges = exportBlockedRanges({
      leases: occupancy.leases,
      holds: [...occupancy.holds, ...imported],
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
