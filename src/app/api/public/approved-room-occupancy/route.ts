import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import { aggregateRoomOccupancy, type PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import {
  applicationHoldsRoomPublicly,
  executedApplicationIdsFromLeaseRecords,
} from "@/lib/rental-application/room-public-occupancy-eligibility";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";

export const runtime = "nodejs";

function day(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const normalized = slash ? `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : null;
}

async function executedApplicationIdsByOwner(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  owners: string[],
): Promise<Map<string, Set<string>>> {
  const byOwner = new Map<string, Set<string>>();
  for (const ownerId of owners) byOwner.set(ownerId, new Set());
  for (let chunk = 0; chunk < owners.length; chunk += 100) {
    const slice = owners.slice(chunk, chunk + 100);
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db
        .from("portal_lease_pipeline_records")
        .select("manager_user_id, row_data")
        .in("manager_user_id", slice)
        .order("id")
        .range(offset, offset + 499);
      if (error) throw error;
      for (const row of data ?? []) {
        const ownerId = String(row.manager_user_id ?? "").trim();
        if (!ownerId) continue;
        const bucket = byOwner.get(ownerId) ?? new Set<string>();
        for (const id of executedApplicationIdsFromLeaseRecords([row])) bucket.add(id);
        byOwner.set(ownerId, bucket);
      }
      if ((data ?? []).length < 500) break;
    }
  }
  return byOwner;
}

export async function GET() {
  try {
    const db = createSupabaseServiceRoleClient();
    const listings = await getPublicListings();
    const placements = new Map<string, Map<string, { start: string; end: string | null; count?: number }>>();
    for (const listing of listings) {
      for (const room of listing.listingSubmission?.rooms ?? []) {
        placements.set(`${listing.id}::${room.id}`, new Map());
      }
    }
    const listingIds = listings.map((p) => p.id);
    const ownerByListing = new Map<string, string>();
    for (let chunk = 0; chunk < listingIds.length; chunk += 100) {
      const { data, error } = await db
        .from("manager_property_records")
        .select("id,manager_user_id")
        .in("id", listingIds.slice(chunk, chunk + 100));
      if (error) throw error;
      for (const record of data ?? []) {
        if (record.manager_user_id) ownerByListing.set(String(record.id), String(record.manager_user_id));
      }
    }
    const owners = [...new Set(ownerByListing.values())];
    const executedByOwner = await executedApplicationIdsByOwner(db, owners);

    for (let chunk = 0; chunk < owners.length; chunk += 100) {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db
          .from("manager_application_records")
          .select(
            "id,occupancy_start,manager_user_id,property_id,assigned_property_id,assigned:row_data->>assignedPropertyId,property:row_data->>propertyId,application_property:row_data->application->>propertyId,withdrawn:row_data->>withdrawnAt,manually_added:row_data->>manuallyAdded,choice:row_data->>assignedRoomChoice,preferred:row_data->application->>roomChoice1,manual_room:row_data->manualResidentDetails->>roomNumber,manual_start:row_data->manualResidentDetails->>moveInDate,manual_end:row_data->manualResidentDetails->>moveOutDate,lease_start:row_data->application->>leaseStart,lease_end:row_data->application->>leaseEnd",
          )
          .eq("row_data->>bucket", "approved")
          .in("manager_user_id", owners.slice(chunk, chunk + 100))
          .order("id")
          .range(offset, offset + 499);
        if (error) throw error;
        for (const row of data ?? []) {
          if (row.withdrawn) continue;
          const ownerId = String(row.manager_user_id ?? "").trim();
          const executedIds = executedByOwner.get(ownerId) ?? new Set<string>();
          const appRow = {
            id: normalizeApplicationAxisId(String(row.id)),
            manuallyAdded: row.manually_added === true || row.manually_added === "true",
          };
          if (!applicationHoldsRoomPublicly(appRow, executedIds)) continue;

          const property = listings.find((p) => p.id === (row.assigned || row.property || row.application_property));
          if (!property || ownerByListing.get(property.id) !== row.manager_user_id) continue;
          const choice = row.choice || row.preferred;
          const candidates = property.listingSubmission?.rooms ?? [];
          const matched = candidates.filter(
            (r) =>
              `${property.id}::${r.id}` === choice ||
              r.id === choice ||
              (!String(choice).includes("::") &&
                r.name.trim().toLowerCase() === String(row.manual_room || choice).trim().toLowerCase()),
          );
          const rooms = choice === property.id ? candidates : matched.length === 1 ? matched : [];
          if (!rooms.length) continue;

          const start = day(row.manual_start) || day(row.lease_start);
          if (!start) continue;
          const occupancyStart = row.occupancy_start && row.occupancy_start < start ? row.occupancy_start : start;
          const end = day(row.manual_end) || day(row.lease_end);
          if (end && end < occupancyStart) continue;
          for (const room of rooms) {
            placements.get(`${property.id}::${room.id}`)?.set(String(row.id).toUpperCase(), {
              start: occupancyStart,
              end,
              count: choice === property.id ? (room.occupancyCapacity ?? 1) : 1,
            });
          }
        }
        if ((data ?? []).length < 500) break;
      }
    }
    const rooms: PublicRoomOccupancy[] = [...placements].map(([roomChoice, rows]) => ({
      roomChoice,
      spans: aggregateRoomOccupancy([...rows.values()]),
    }));
    return NextResponse.json({ rooms }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } });
  } catch {
    return NextResponse.json({ error: "Could not load room availability." }, { status: 503 });
  }
}
