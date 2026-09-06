import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import { aggregateRoomOccupancy, type PublicRoomOccupancy } from "@/lib/public-room-occupancy";
export const runtime = "nodejs";
function day(raw: unknown): string | null {
  const value = String(raw ?? "").trim(); if (!value) return null;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const normalized = slash ? `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : null;
}
export async function GET() {
  try {
    const db = createSupabaseServiceRoleClient();
    const listings = await getPublicListings();
    const placements = new Map<string, Map<string, { start: string; end: string | null; count?: number }>>();
    for (const listing of listings) for (const room of listing.listingSubmission?.rooms ?? []) placements.set(`${listing.id}::${room.id}`, new Map());
    // Scoped by OWNER, not by three `.in()` filters over unindexed jsonb paths. A
    // placement only counts when its listing's `managerUserId` equals the row's
    // owner (checked below), so owner-scoping selects exactly the same rows in one
    // indexed query per chunk instead of three full scans on a public endpoint.
    const owners = [...new Set(listings.map(p => p.managerUserId).filter((id): id is string => Boolean(id)))];
    for (let chunk = 0; chunk < owners.length; chunk += 100) {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db.from("manager_application_records")
          .select("id,occupancy_start,manager_user_id,property_id,assigned_property_id,assigned:row_data->>assignedPropertyId,property:row_data->>propertyId,application_property:row_data->application->>propertyId,withdrawn:row_data->>withdrawnAt,choice:row_data->>assignedRoomChoice,preferred:row_data->application->>roomChoice1,manual_room:row_data->manualResidentDetails->>roomNumber,manual_start:row_data->manualResidentDetails->>moveInDate,manual_end:row_data->manualResidentDetails->>moveOutDate,lease_start:row_data->application->>leaseStart,lease_end:row_data->application->>leaseEnd")
          .eq("row_data->>bucket", "approved").in("manager_user_id", owners.slice(chunk, chunk + 100)).order("id").range(offset, offset + 499);
        if (error) throw error;
        for (const row of data ?? []) {
          if (row.withdrawn) continue;
          const property = listings.find(p => p.id === (row.assigned || row.property || row.application_property)); if (!property || property.managerUserId !== row.manager_user_id) continue;
          const choice = row.choice || row.preferred;
          const candidates = property.listingSubmission?.rooms ?? [];
          const matched = candidates.filter(r => `${property.id}::${r.id}` === choice || r.id === choice || (!String(choice).includes("::") && r.name.trim().toLowerCase() === String(row.manual_room || choice).trim().toLowerCase()));
          const rooms = choice === property.id ? candidates : matched.length === 1 ? matched : [];
          if (!rooms.length) continue;
          const currentStart = day(row.manual_start) || day(row.lease_start) || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
          const start = row.occupancy_start && row.occupancy_start < currentStart ? row.occupancy_start : currentStart;
          const end = day(row.manual_end) || day(row.lease_end);
          if (end && end < start) continue;
          for (const room of rooms) placements.get(`${property.id}::${room.id}`)?.set(String(row.id).toUpperCase(), { start, end, count: choice === property.id ? (room.occupancyCapacity ?? 1) : 1 });
        }
        if ((data ?? []).length < 500) break;
      }
    }
    const rooms: PublicRoomOccupancy[] = [...placements].map(([roomChoice, rows]) => ({ roomChoice, spans: aggregateRoomOccupancy([...rows.values()]) }));
    return NextResponse.json({ rooms }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } });
  } catch {
    return NextResponse.json({ error: "Could not load room availability." }, { status: 503 });
  }
}
