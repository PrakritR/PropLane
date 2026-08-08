import { NextResponse } from "next/server";

import {
  loadConnectionByExportToken,
  loadPropertyRecord,
} from "@/lib/channel-calendar/sync.server";
import { listingSubmissionFromProperty, roomUnavailableRangesForExport } from "@/lib/channel-calendar/connections.server";
import { generateIcsCalendar } from "@/lib/ical/generate";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

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
    const ranges = roomUnavailableRangesForExport(submission, connection.room_id);
    const room = submission?.rooms.find((r) => r.id === connection.room_id);
    const calendarName = connection.label?.trim() || room?.name?.trim() || "PropLane calendar";
    const body = generateIcsCalendar(ranges, { calendarName });

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
