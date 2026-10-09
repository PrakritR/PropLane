import "server-only";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { aggregateRoomOccupancy, type PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { applicationHoldsRoomPublicly, executedApplicationIdsFromLeaseRecords } from "@/lib/rental-application/room-public-occupancy-eligibility";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { canonicalRoomChoiceValue } from "@/lib/rental-application/room-choice-value";
import { CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX } from "@/lib/channel-calendar/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;
type Listing = { id: string; listingSubmission?: ManagerListingSubmissionV1 | null };

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

/** One source for the anonymous public occupancy route and scoped SMS reads. */
export async function loadPublicRoomOccupancy(db: Db, listings: Listing[], expectedOwnerId?: string): Promise<PublicRoomOccupancy[]> {
  if (!listings.length) return [];
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
        .select("id,manager_user_id,property_data")
        .in("id", listingIds.slice(chunk, chunk + 100));
      if (error) throw error;
      for (const record of data ?? []) {
        if (record.manager_user_id) ownerByListing.set(String(record.id), String(record.manager_user_id));
        const submission = (record.property_data as { listingSubmission?: ManagerListingSubmissionV1 } | null)
          ?.listingSubmission;
        if (submission?.v !== 1) continue;
        for (const room of submission.rooms ?? []) {
          const bucket = placements.get(`${record.id}::${room.id}`);
          if (!bucket) continue;
          for (const range of room.manualUnavailableRanges ?? []) {
            if (String(range.id ?? "").startsWith(`${CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX}-`)) continue;
            const start = day(range.start);
            if (!start) continue;
            const end = day(range.end) || start;
            const id = String(range.id || `${start}:${end}`).trim() || `${start}:${end}`;
            bucket.set(id, { start, end, count: 1 });
          }
        }
      }
    }
    if (expectedOwnerId && listings.some((listing) => ownerByListing.get(listing.id) !== expectedOwnerId)) {
      throw new Error("Listing owner could not be verified.");
    }
    const owners = [...new Set(ownerByListing.values())];
    // Scope by PROPERTY, never by `manager_user_id`: a row's manager stamp is whoever authored it
    // (a co-manager of the workspace, a previous owner), so filtering on the owner dropped every
    // resident the owner did not personally add and showed their room as free. Same reach as the
    // calendar export feed. The four places a row can name its property are the two property columns
    // and the two `propertyId::roomId` choice values (an imported stay carries only the latter).
    const fetchApplicationPage = (idSlice: string[], offset: number) => {
      const safe = idSlice.map((id) => id.replace(/[,()"%*\\]/g, ""));
      const quoted = safe.map((id) => `"${id}"`).join(",");
      return db
        .from("manager_application_records")
        .select(
          "id,occupancy_start,manager_user_id,property_id,assigned_property_id,assigned:row_data->>assignedPropertyId,property:row_data->>propertyId,application_property:row_data->application->>propertyId,withdrawn:row_data->>withdrawnAt,manually_added:row_data->>manuallyAdded,choice:row_data->>assignedRoomChoice,preferred:row_data->application->>roomChoice1,manual_room:row_data->manualResidentDetails->>roomNumber,manual_start:row_data->manualResidentDetails->>moveInDate,manual_end:row_data->manualResidentDetails->>moveOutDate,lease_start:row_data->application->>leaseStart,lease_end:row_data->application->>leaseEnd",
        )
        .eq("row_data->>bucket", "approved")
        .or(
          [
            `property_id.in.(${quoted})`,
            `assigned_property_id.in.(${quoted})`,
            ...safe.map((id) => `row_data->>assignedRoomChoice.like.${id}::%`),
            ...safe.map((id) => `row_data->application->>roomChoice1.like.${id}::%`),
          ].join(","),
        )
        .order("id")
        .range(offset, offset + 499);
    };
    type ApplicationRow = NonNullable<Awaited<ReturnType<typeof fetchApplicationPage>>["data"]>[number];
    const fetchApplicationRows = async (): Promise<ApplicationRow[]> => {
      const all: ApplicationRow[] = [];
      const seen = new Set<string>();
      for (let chunk = 0; chunk < listingIds.length; chunk += 20) {
        for (let offset = 0; ; offset += 500) {
          const { data, error } = await fetchApplicationPage(listingIds.slice(chunk, chunk + 20), offset);
          if (error) throw error;
          for (const row of data ?? []) {
            const id = String(row.id ?? "");
            if (id && seen.has(id)) continue;
            seen.add(id);
            all.push(row);
          }
          if ((data ?? []).length < 500) break;
        }
      }
      return all;
    };
    // A manager's explicit closed dates (`room_date_block`), room-specific or whole-property.
    const fetchBlockRows = async () => {
      const all: { id: unknown; property_id: unknown; row_data: unknown }[] = [];
      for (let chunk = 0; chunk < listingIds.length; chunk += 100) {
        for (let offset = 0; ; offset += 500) {
          const { data, error } = await db
            .from("portal_schedule_records")
            .select("id,property_id,row_data")
            .in("property_id", listingIds.slice(chunk, chunk + 100))
            .eq("record_type", "room_date_block")
            .order("id")
            .range(offset, offset + 499);
          if (error) throw error;
          all.push(...(data ?? []));
          if ((data ?? []).length < 500) break;
        }
      }
      return all;
    };
    const fetchCalendarRows = async () => {
      const all: { property_id: unknown; room_id: unknown; imported_ranges: unknown }[] = [];
      for (let chunk = 0; chunk < listingIds.length; chunk += 100) {
        const { data, error } = await db
          .from("external_calendar_connections")
          .select("property_id, room_id, imported_ranges")
          .in("property_id", listingIds.slice(chunk, chunk + 100));
        if (error) throw error;
        all.push(...(data ?? []));
      }
      return all;
    };
    // The three reads are independent of one another (all key off the owner and
    // listing ids resolved above), so they run together. Results are applied in
    // the original order below, so the output is unchanged.
    const [executedByOwner, applicationRows, calendarRows, blockRows] = await Promise.all([
      executedApplicationIdsByOwner(db, owners),
      fetchApplicationRows(),
      fetchCalendarRows(),
      fetchBlockRows(),
    ]);
    // Application ids are globally unique, so a lease any teammate executed counts for the application.
    const executedIds = new Set<string>();
    for (const ids of executedByOwner.values()) for (const id of ids) executedIds.add(id);
    const listingById = new Map(listings.map((p) => [p.id, p] as const));

    for (const row of applicationRows) {
      if (row.withdrawn) continue;
      const appRow = {
        id: normalizeApplicationAxisId(String(row.id)),
        manuallyAdded: String(row.manually_added ?? "") === "true",
      };
      if (!applicationHoldsRoomPublicly(appRow, executedIds)) continue;

      const choice = String(row.choice || row.preferred || "").trim();
      const property =
        listingById.get(String(row.assigned || row.assigned_property_id || row.property || row.property_id || row.application_property)) ??
        listingById.get(choice.split("::")[0] ?? "");
      if (!property) continue;
      const canonicalChoice = canonicalRoomChoiceValue(choice);
      const candidates = property.listingSubmission?.rooms ?? [];
      const matched = candidates.filter(
        (r) =>
          `${property.id}::${r.id}` === canonicalChoice ||
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
    for (const row of calendarRows) {
      const propertyId = String(row.property_id ?? "");
      const roomId = String(row.room_id ?? "");
      const bucket = placements.get(`${propertyId}::${roomId}`);
      if (!bucket) continue;
      const imported = Array.isArray(row.imported_ranges) ? row.imported_ranges : [];
      for (const range of imported) {
        const start = day((range as { start?: unknown }).start);
        if (!start) continue;
        const end = day((range as { end?: unknown }).end) || start;
        const id = String((range as { sourceUid?: unknown; id?: unknown }).sourceUid || (range as { id?: unknown }).id || `${start}:${end}`);
        bucket.set(id, { start, end, count: 1 });
      }
    }
    for (const block of blockRows) {
      const data = block.row_data && typeof block.row_data === "object" ? (block.row_data as Record<string, unknown>) : null;
      const property = listingById.get(String(block.property_id ?? ""));
      if (!data || !property || data.bookingStatus === "cancelled") continue;
      const start = day(data.checkIn);
      const checkout = day(data.checkOut);
      if (!start || !checkout || checkout <= start) continue;
      const openEnded = data.openEnded === true || checkout === "9999-12-31";
      const end = openEnded ? null : new Date(Date.parse(`${checkout}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      const roomId = String(data.roomId ?? "").trim();
      const blocked = roomId
        ? (property.listingSubmission?.rooms ?? []).filter((room) => room.id === roomId)
        : (property.listingSubmission?.rooms ?? []);
      for (const room of blocked) {
        placements.get(`${property.id}::${room.id}`)?.set(`block:${String(block.id)}`, {
          start,
          end,
          count: roomId ? 1 : (room.occupancyCapacity ?? 1),
        });
      }
    }
    const rooms: PublicRoomOccupancy[] = [...placements].map(([roomChoice, rows]) => ({
      roomChoice,
      spans: aggregateRoomOccupancy([...rows.values()]),
    }));
    return rooms;
}
