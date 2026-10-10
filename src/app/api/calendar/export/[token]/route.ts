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
import { stampExportFetch } from "@/lib/channel-calendar/export-fetch-stamp";
import { generateIcsCalendar } from "@/lib/ical/generate";
import { exportBlockedRanges } from "@/lib/occupancy/snapshot";
import { loadOccupancyAuthors, occupancyAuthorTrusted } from "@/lib/occupancy/row-authorship.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function day(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

const APPROVED_ROW_SELECT =
  "id,manager_user_id,assigned_property_id,property_id,choice:row_data->>assignedRoomChoice,preferred:row_data->application->>roomChoice1,lease_start:row_data->application->>leaseStart,lease_end:row_data->application->>leaseEnd,manual_start:row_data->manualResidentDetails->>moveInDate,manual_end:row_data->manualResidentDetails->>moveOutDate,manually_added:row_data->>manuallyAdded,bucket:row_data->>bucket,ical_connection:row_data->>icalConnectionId";
const APPROVED_ROW_PAGE = 500;
const APPROVED_ROW_MAX_PAGES = 40;

/**
 * Occupancy is read by PROPERTY, never by `manager_user_id`. A row's manager stamp is whoever
 * authored it (the acting teammate of a co-managed workspace, a property's previous owner, or
 * nobody on an older row), while the feed's connection carries the property's current owner —
 * filtering on the pair silently dropped every resident the owner did not personally add and
 * published their nights as free. The feed token already pins one property, and a row naming that
 * property is that property's occupancy whoever wrote it.
 *
 * Where an approved row can name this property. These are exactly the four sources the JavaScript
 * match below consults, so narrowing on them in the DATABASE drops nothing: the property columns,
 * and the two `propertyId::roomId` room-choice values (an imported channel stay carries only the
 * latter). Each is its own filter rather than one `or(...)` expression, so a property id is never
 * interpolated into filter grammar and no id is ever too exotic to narrow on.
 */
const APPROVED_ROW_SOURCES = ["assigned", "property", "assignedChoice", "preferredChoice"] as const;
type ApprovedRowSource = (typeof APPROVED_ROW_SOURCES)[number];

type ApprovedRow = {
  id: unknown;
  manager_user_id: unknown;
  choice: unknown;
  preferred: unknown;
  lease_start: unknown;
  lease_end: unknown;
  manual_start: unknown;
  manual_end: unknown;
  manually_added: unknown;
  ical_connection: unknown;
  assigned_property_id: unknown;
  property_id: unknown;
};

async function readApprovedRowPage(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  propertyId: string,
  source: ApprovedRowSource,
  page: number,
): Promise<ApprovedRow[]> {
  const base = db
    .from("manager_application_records")
    .select(APPROVED_ROW_SELECT)
    .eq("row_data->>bucket", "approved");
  const choicePrefix = `${propertyId}::%`;
  const scoped =
    source === "assigned"
      ? base.eq("assigned_property_id", propertyId)
      : source === "property"
        ? base.eq("property_id", propertyId)
        : source === "assignedChoice"
          ? base.like("row_data->>assignedRoomChoice", choicePrefix)
          : base.like("row_data->application->>roomChoice1", choicePrefix);
  // One row past the page, so "is there more?" is answered by the same read: a source whose row
  // count lands exactly on a page boundary must not be mistaken for a truncated one.
  const { data, error } = await scoped
    .order("id", { ascending: true })
    .range(page * APPROVED_ROW_PAGE, page * APPROVED_ROW_PAGE + APPROVED_ROW_PAGE);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ApprovedRow[];
}

async function readApprovedRowsForProperty(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  propertyId: string,
): Promise<ApprovedRow[]> {
  const rows: ApprovedRow[] = [];
  const seen = new Set<string>();
  for (const source of APPROVED_ROW_SOURCES) {
    let exhausted = false;
    for (let page = 0; page < APPROVED_ROW_MAX_PAGES; page += 1) {
      const batch = await readApprovedRowPage(db, propertyId, source, page);
      const hasMore = batch.length > APPROVED_ROW_PAGE;
      for (const row of hasMore ? batch.slice(0, APPROVED_ROW_PAGE) : batch) {
        const id = typeof row.id === "string" ? row.id.trim() : "";
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        rows.push(row);
      }
      if (!hasMore) {
        exhausted = true;
        break;
      }
    }
    // Rows beyond the bound are occupancy this feed never read. Publishing it anyway would
    // advertise occupied dates as free, so refuse the feed rather than serve a truncated one.
    if (!exhausted) throw new Error("Approved-application read for this room exceeded its page bound.");
  }
  return rows;
}

async function occupancyRangesForRoom(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  propertyId: string,
  roomId: string,
): Promise<{ leases: { start: string; end: string }[]; holds: { start: string; end: string }[]; importPlacements: FeedPlacement[] }> {
  const data = await readApprovedRowsForProperty(db, propertyId);
  // A row counts for this house only when its author is the owner or a teammate linked to it: the
  // read is by property, so an approved row any other manager wrote naming this house is not its occupancy.
  const authors = await loadOccupancyAuthors(db, [propertyId]);
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
    // A row this house's authors did not write is not its occupancy, so it is not published - but a
    // row that SHOULD have counted (a stamp left wrong by a re-assigned grant) would then offer an
    // occupied room as free. Dropping one is reported loudly rather than passing silently, since
    // nothing downstream can tell the two apart.
    if (!occupancyAuthorTrusted(authors, propertyId, row.manager_user_id)) {
      console.error(
        "calendar export dropped an approved row this house did not author",
        JSON.stringify({ propertyId, roomId, rowId: typeof row.id === "string" ? row.id : null, start, end }),
      );
      continue;
    }
    const range = { start, end };
    if (String(row.manually_added ?? "") === "true") holds.push(range);
    else leases.push(range);
  }
  const { data: blocks, error: blockError } = await db
    .from("portal_schedule_records")
    .select("row_data")
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

    // "Airbnb checked PropLane": best-effort and throttled, never part of the feed's outcome.
    await stampExportFetch(db, connection, req.headers.get("user-agent"));

    const record = await loadPropertyRecord(db, connection.property_id);
    const submission = listingSubmissionFromProperty(record?.property ?? null);
    const typedBlocks = roomUnavailableRangesForExport(submission, connection.room_id);
    const occupancy = await occupancyRangesForRoom(
      db,
      connection.property_id,
      connection.room_id,
    );
    // The token's connection names the channel this link is pasted into; its own bookings are
    // left out so they do not echo back. A token shared by several connections (older links) or
    // a `?channels=all` link (any other site) carries every channel's bookings instead.
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
