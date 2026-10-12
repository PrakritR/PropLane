import "server-only";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { occupiedBedSpans, type RoomBedSpan } from "@/lib/room-occupancy-rule";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import { isIcalAvailabilityBlock } from "@/lib/occupancy/snapshot";
import { leaseIsFullyExecuted, normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { canonicalRoomChoiceValue } from "@/lib/rental-application/room-choice-value";
import { CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX } from "@/lib/channel-calendar/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { loadOccupancyAuthors, occupancyAuthorTrusted, type OccupancyAuthors } from "@/lib/occupancy/row-authorship.server";

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

type ExecutedLease = {
  /** Every application id the lease names (its own axis id and each joint member's), normalized. */
  applicationIds: string[];
  leaseId: string;
  propertyId: string;
  roomChoice: string;
  start: string | null;
  end: string | null;
};

/**
 * Every fully executed lease for these listings.
 *
 * Scoped by OWNER **and** by PROPERTY, because a lease carries the stamp of
 * whoever generated it: a co-manager holding the grant executes it under their
 * own `manager_user_id`, so an owner-only read missed that lease and the room's
 * occupied nights published as free. A lease filed under a house by an author who does not
 * speak for it proves nothing about that house.
 */
async function executedLeases(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  owners: string[],
  listingIds: string[],
  authors: OccupancyAuthors,
): Promise<ExecutedLease[]> {
  const found = new Map<string, ExecutedLease>();
  const listed = new Set(listingIds);
  const pages = async (column: "manager_user_id" | "property_id", values: string[]) => {
    for (let chunk = 0; chunk < values.length; chunk += 100) {
      const slice = values.slice(chunk, chunk + 100);
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db
          .from("portal_lease_pipeline_records")
          .select("id, row_data, manager_user_id, property_id")
          .in(column, slice)
          .order("id")
          .range(offset, offset + 499);
        if (error) throw error;
        for (const row of data ?? []) {
          const propertyId = String(row.property_id ?? "").trim();
          if (column === "property_id" && !occupancyAuthorTrusted(authors, propertyId, row.manager_user_id)) continue;
          if (!row.row_data || typeof row.row_data !== "object") continue;
          const lease = normalizeLeasePipelineRow(row.row_data as LeasePipelineRow);
          if (!leaseIsFullyExecuted(lease)) continue;
          const applicationIds = new Set<string>();
          if (lease.axisId?.trim()) applicationIds.add(normalizeApplicationAxisId(lease.axisId.trim()));
          for (const member of lease.jointLeaseMembers ?? []) {
            const memberId = member.applicationId?.trim();
            if (memberId) applicationIds.add(normalizeApplicationAxisId(memberId));
          }
          const leaseId = String(row.id ?? lease.id ?? "").trim() || [...applicationIds].join("|");
          if (found.has(leaseId)) continue;
          const dataRow = row.row_data as { roomChoice?: unknown; application?: { leaseStart?: unknown; leaseEnd?: unknown } };
          found.set(leaseId, {
            applicationIds: [...applicationIds],
            leaseId,
            // Only a lease filed under a listed house, by someone who speaks for it, can hold one of its rooms.
            propertyId: listed.has(propertyId) && occupancyAuthorTrusted(authors, propertyId, row.manager_user_id) ? propertyId : "",
            roomChoice: typeof dataRow.roomChoice === "string" ? dataRow.roomChoice.trim() : "",
            start: day(dataRow.application?.leaseStart),
            end: day(dataRow.application?.leaseEnd),
          });
        }
        if ((data ?? []).length < 500) break;
      }
    }
  };
  await pages("manager_user_id", owners);
  await pages("property_id", listingIds);
  return [...found.values()];
}

/** One source for the anonymous public occupancy route and scoped SMS reads. */
export async function loadPublicRoomOccupancy(db: Db, listings: Listing[], expectedOwnerId?: string): Promise<PublicRoomOccupancy[]> {
  if (!listings.length) return [];
    const placements = new Map<string, Map<string, RoomBedSpan>>();
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
            // No end date means the manager has not said when the room reopens: open-ended, exactly
            // as the manager snapshot and the room row read it — never a single day.
            const end = day(range.end);
            const id = String(range.id || `${start}:${end ?? ""}`).trim() || `${start}:${end ?? ""}`;
            // The listing's own blocked dates. A host block a channel wrote here is an echo candidate.
            bucket.set(id, { start, end, count: 1, echoable: isHostBlockRange(range) });
          }
        }
      }
    }
    if (expectedOwnerId && listings.some((listing) => ownerByListing.get(listing.id) !== expectedOwnerId)) {
      throw new Error("Listing owner could not be verified.");
    }
    const owners = [...new Set(ownerByListing.values())];
    // A row counts for a house only when its author is the owner or a teammate linked to that house.
    const authors = await loadOccupancyAuthors(db, listingIds);
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
    // The four reads are independent of one another (all key off the owner and
    // listing ids resolved above), so they run together. Results are applied in
    // the original order below, so the output is unchanged.
    const [leases, applicationRows, calendarRows, blockRows] = await Promise.all([
      executedLeases(db, owners, listingIds, authors),
      fetchApplicationRows(),
      fetchCalendarRows(),
      fetchBlockRows(),
    ]);
    const listingById = new Map(listings.map((p) => [p.id, p] as const));

    // Every approved, non-withdrawn application with dates holds its room: hand-added, still
    // waiting on a signature, or signed. Pending applications reserve nothing (they are not read).
    const countedApplicationIds = new Set<string>();
    const roomsForChoice = (property: Listing, choice: string, roomName: string) => {
      const canonicalChoice = canonicalRoomChoiceValue(choice);
      const candidates = property.listingSubmission?.rooms ?? [];
      const matched = candidates.filter(
        (r) =>
          `${property.id}::${r.id}` === canonicalChoice ||
          r.id === choice ||
          (!String(choice).includes("::") && r.name.trim().toLowerCase() === String(roomName || choice).trim().toLowerCase()),
      );
      return choice === property.id ? candidates : matched.length === 1 ? matched : [];
    };
    for (const row of applicationRows) {
      if (row.withdrawn) continue;

      const choice = String(row.choice || row.preferred || "").trim();
      const property =
        listingById.get(String(row.assigned || row.assigned_property_id || row.property || row.property_id || row.application_property)) ??
        listingById.get(choice.split("::")[0] ?? "");
      if (!property) continue;
      if (!occupancyAuthorTrusted(authors, property.id, row.manager_user_id)) continue;
      const rooms = roomsForChoice(property, choice, String(row.manual_room || ""));
      if (!rooms.length) continue;

      const start = day(row.manual_start) || day(row.lease_start);
      if (!start) continue;
      const occupancyStart = row.occupancy_start && row.occupancy_start < start ? row.occupancy_start : start;
      const end = day(row.manual_end) || day(row.lease_end);
      if (end && end < occupancyStart) continue;
      countedApplicationIds.add(normalizeApplicationAxisId(String(row.id)));
      for (const room of rooms) {
        placements.get(`${property.id}::${room.id}`)?.set(String(row.id).toUpperCase(), {
          start: occupancyStart,
          end,
          count: choice === property.id ? (room.occupancyCapacity ?? 1) : 1,
        });
      }
    }
    // A fully executed lease whose application row never counted (no approved row on file, or one
    // filed under another house) still holds its room, on the lease's own dates.
    for (const lease of leases) {
      if (!lease.propertyId || !lease.start) continue;
      if (lease.applicationIds.some((id) => countedApplicationIds.has(id))) continue;
      const property = listingById.get(lease.propertyId);
      if (!property) continue;
      const rooms = roomsForChoice(property, lease.roomChoice, "");
      if (!rooms.length) continue;
      if (lease.end && lease.end < lease.start) continue;
      for (const room of rooms) {
        placements.get(`${property.id}::${room.id}`)?.set(`lease:${lease.leaseId}`, {
          start: lease.start,
          end: lease.end,
          count: lease.roomChoice === property.id ? (room.occupancyCapacity ?? 1) : 1,
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
        const channel = range as { hostBlock?: boolean; summary?: string };
        // A channel closure that sits on a day another occupant already holds the room is PropLane's own
        // export echoing back, not a second occupant (same rule as the manager snapshot).
        bucket.set(id, {
          start,
          end,
          count: 1,
          echoable: isHostBlockRange(channel) || isIcalAvailabilityBlock(channel.summary),
        });
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
      spans: occupiedBedSpans([...rows.values()]),
    }));
    return rooms;
}
