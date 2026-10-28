import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MockProperty } from "@/data/types";

import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";
import { buildAttentionItems, feedStateFor, type ChannelHealth, type ChannelHealthHouse, type FeedState, type HealthConnection, type HealthStay, type UnassignedApproval } from "@/lib/channel-calendar/channel-health";
import { listingRentedWhole } from "@/lib/channel-calendar/export-occupancy";
import { listingSubmissionFromProperty } from "@/lib/channel-calendar/connections.server";
import { buildVacancyPost, type VacancyRoom } from "@/lib/channel-calendar/vacancy-post";
import { resolveListingTextNumber } from "@/lib/listing-text-number.server";
import { pacificTodayKey } from "@/lib/public-room-live-label";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { findPublicRoomOccupancyExact } from "@/lib/public-listing-available-count";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { publicRoomStatus } from "@/lib/room-availability";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";

const FEED_SEVERITY: FeedState[] = ["error", "stale", "never", "waiting", "fetched", "unmonitored"];

/** Rows per page. Every read here pages to the end rather than trusting PostgREST's max-rows cut. */
const PAGE = 500;

function worstFeed(states: readonly FeedState[]): FeedState {
  return FEED_SEVERITY.find((state) => states.includes(state)) ?? "unmonitored";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The house's `room_date_block` rows as the health reader needs them. */
async function loadStays(db: SupabaseClient, propertyIds: readonly string[], roomLabels: ReadonlyMap<string, string>, houseLabels: ReadonlyMap<string, string>): Promise<HealthStay[]> {
  if (propertyIds.length === 0) return [];
  // Paged, like every other reader in this area: an unbounded select is silently cut at PostgREST's max-rows and the
  // attention list would then drop closures and missing-echo checks with no signal at all.
  const rows: Array<{ id?: unknown; property_id?: unknown; row_data?: unknown }> = [];
  const ids = [...propertyIds];
  for (let chunk = 0; chunk < ids.length; chunk += 100) {
    const slice = ids.slice(chunk, chunk + 100);
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db
        .from("portal_schedule_records")
        .select("id, property_id, row_data")
        .in("property_id", slice)
        .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
        .order("id")
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Array<{ id?: unknown; property_id?: unknown; row_data?: unknown }>));
      if ((data ?? []).length < PAGE) break;
    }
  }
  const out: HealthStay[] = [];
  for (const row of rows) {
    const d = row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data) ? (row.row_data as Record<string, unknown>) : null;
    const propertyId = text(row.property_id);
    const checkIn = text(d?.checkIn);
    const checkOut = text(d?.checkOut);
    if (!d || !propertyId || !checkIn || !checkOut) continue;
    const roomId = text(d.roomId);
    out.push({
      id: text(row.id),
      propertyId,
      roomId,
      roomLabel: roomId ? roomLabels.get(`${propertyId}::${roomId}`) ?? roomId : "",
      houseLabel: houseLabels.get(propertyId),
      name: text(d.residentName),
      reason: text(d.reason),
      checkIn,
      checkOut,
      openEnded: d.openEnded === true,
      cancelled: d.bookingStatus === "cancelled",
      closed: d.blockKind === "closed",
      createdAt: text(d.createdAt) || null,
    });
  }
  return out;
}

type HouseDetail = {
  rooms: number;
  vacancy: VacancyRoom[] | null;
  label: string | null;
  roomLabels: Array<[string, string]>;
  rentedWhole: boolean;
  ownerUserId: string | null;
  workspaceId: string | null;
};

/**
 * Every house's record in one read. `loadPropertyRecord` is per-id and `loadPublicRoomOccupancy` already takes a
 * list, so asking per house turned a 12-house workspace into ~80 queries for the one card.
 */
async function loadHouseRecords(
  db: SupabaseClient,
  propertyIds: readonly string[],
): Promise<Map<string, { property: MockProperty | null; managerUserId: string | null; workspaceId: string | null }>> {
  const out = new Map<string, { property: MockProperty | null; managerUserId: string | null; workspaceId: string | null }>();
  const ids = [...propertyIds];
  for (let chunk = 0; chunk < ids.length; chunk += 100) {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, manager_user_id, property_data, workspace_id")
      .in("id", ids.slice(chunk, chunk + 100));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      out.set(text(row.id), {
        property: (row.property_data ?? null) as MockProperty | null,
        managerUserId: row.manager_user_id ? String(row.manager_user_id) : null,
        workspaceId: row.workspace_id ? String(row.workspace_id) : null,
      });
    }
  }
  return out;
}

/** Each house's rooms, labels and live vacancy. ONE occupancy read covers every house; a failed one leaves `vacancy` null. */
async function loadVacancies(
  db: SupabaseClient,
  propertyIds: readonly string[],
  today: string,
): Promise<Map<string, HouseDetail>> {
  const records = await loadHouseRecords(db, propertyIds);
  const details = new Map<string, HouseDetail>();
  const listings: Array<{ id: string; listingSubmission: NonNullable<ReturnType<typeof listingSubmissionFromProperty>> }> = [];
  for (const propertyId of propertyIds) {
    const record = records.get(propertyId) ?? null;
    const submission = listingSubmissionFromProperty(record?.property ?? null);
    const rooms = submission?.rooms ?? [];
    details.set(propertyId, {
      rooms: rooms.length,
      vacancy: [],
      label: record?.property?.buildingName?.trim() || record?.property?.title?.trim() || null,
      roomLabels: rooms.map((room) => [`${propertyId}::${room.id}`, room.name?.trim() || room.id]),
      rentedWhole: listingRentedWhole(submission),
      ownerUserId: record?.managerUserId ?? null,
      workspaceId: record?.workspaceId ?? null,
    });
    if (submission && rooms.length > 0) listings.push({ id: propertyId, listingSubmission: submission });
  }
  if (listings.length === 0) return details;
  let occupancy: Awaited<ReturnType<typeof loadPublicRoomOccupancy>> | null = null;
  try {
    occupancy = await loadPublicRoomOccupancy(db, listings);
  } catch {
    // One read serves every house, so a failure is every house's: say nothing rather than publish a guess.
    for (const listing of listings) details.get(listing.id)!.vacancy = null;
    return details;
  }
  for (const listing of listings) {
    const detail = details.get(listing.id)!;
    detail.vacancy = listing.listingSubmission.rooms.map((room) => ({
      roomId: room.id,
      name: room.name?.trim() || room.id,
      rentLabel: room.monthlyRent > 0 ? `${formatRoomPriceAmount(room.monthlyRent)}/mo` : "",
      // Exact key: the one occupancy read covers every house in the workspace, so a suffix match would lend this
      // room another house's spans.
      status: publicRoomStatus(room, findPublicRoomOccupancyExact(occupancy, listing.id, room.id)?.spans ?? [], today),
    }));
  }
  return details;
}

/**
 * Approved residents of a house let by the room whose application names no room. The export cannot hold a room for them,
 * so they are surfaced for the manager to assign. Channel placeholders (`icalConnectionId`) and withdrawn or finished
 * stays are not residents to place.
 */
async function loadUnassignedApprovals(db: SupabaseClient, propertyId: string, houseLabel: string, today: string): Promise<UnassignedApproval[]> {
  const select =
    "id,name:row_data->>name,choice:row_data->>assignedRoomChoice,preferred:row_data->application->>roomChoice1,lease_start:row_data->application->>leaseStart,lease_end:row_data->application->>leaseEnd,manual_start:row_data->manualResidentDetails->>moveInDate,manual_end:row_data->manualResidentDetails->>moveOutDate,ical_connection:row_data->>icalConnectionId,withdrawn:row_data->>withdrawnAt";
  const found = new Map<string, UnassignedApproval>();
  for (const column of ["property_id", "assigned_property_id"] as const) {
    // Paged to the end: a bare `.limit(500)` drops the rest of a large house's approvals and which ones it drops
    // is nondeterministic, so a resident waiting on a room would silently never be surfaced.
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db
        .from("manager_application_records")
        .select(select)
        .eq("row_data->>bucket", "approved")
        .eq(column, propertyId)
        .order("id")
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
        if (text(row.ical_connection) || text(row.withdrawn) || text(row.choice) || text(row.preferred)) continue;
        const start = text(row.manual_start) || text(row.lease_start);
        const end = text(row.manual_end) || text(row.lease_end);
        if (!start || (end && end < today)) continue;
        found.set(text(row.id), { id: text(row.id), propertyId, houseLabel, name: text(row.name) });
      }
      if ((data ?? []).length < PAGE) break;
    }
  }
  return [...found.values()];
}

/** One read for the Integrations › Bookings Channels card: house x channel state, what each posting should say, and what needs a look. */
export async function loadChannelHealth(
  db: SupabaseClient,
  userId: string,
  propertyIds: string[],
  origin?: string,
  now: Date = new Date(),
): Promise<ChannelHealth> {
  const today = pacificTodayKey(now);
  const properties = await listManagerChannelCalendarBookings(db, userId, propertyIds, origin);
  const detailByProperty = await loadVacancies(db, properties.map((property) => property.propertyId), today);
  const details = properties.map((property) => detailByProperty.get(property.propertyId)!);
  const roomLabels = new Map(details.flatMap((detail) => detail.roomLabels));
  const houseLabels = new Map(properties.map((property, index) => [property.propertyId, details[index]!.label || property.propertyLabel] as const));
  const connections: HealthConnection[] = properties.flatMap((property) =>
    property.rooms.map((room) => ({
      id: room.connectionId,
      propertyId: property.propertyId,
      roomId: room.roomId,
      roomLabel: room.roomLabel,
      houseLabel: houseLabels.get(property.propertyId),
      provider: room.provider,
      label: room.label,
      lastSyncedAt: room.lastSyncedAt,
      lastError: room.lastError,
      exportLastFetchedAt: room.exportLastFetchedAt ?? null,
      ranges: room.ranges,
    })),
  );
  const unassigned = (
    await Promise.all(
      properties.map(async (property, index) => {
        const detail = details[index]!;
        if (detail.rentedWhole) return [];
        return loadUnassignedApprovals(db, property.propertyId, detail.label || property.propertyLabel, today).catch(() => []);
      }),
    )
  ).flat();
  const stays = await loadStays(db, properties.map((property) => property.propertyId), roomLabels, houseLabels);
  const houses: ChannelHealthHouse[] = await Promise.all(
    properties.map(async (property, index) => {
      const detail = details[index]!;
      const number = detail.ownerUserId
        ? await resolveListingTextNumber(db, { ownerUserId: detail.ownerUserId, workspaceId: detail.workspaceId }).catch(() => null)
        : null;
      const label = detail.label || property.propertyLabel;
      const byChannel = new Map<string, HealthConnection[]>();
      for (const connection of connections.filter((c) => c.propertyId === property.propertyId)) {
        const key = connection.provider === "ical" ? `ical:${(connection.label ?? "").toLowerCase()}` : connection.provider;
        byChannel.set(key, [...(byChannel.get(key) ?? []), connection]);
      }
      return {
        propertyId: property.propertyId,
        label,
        rooms: detail.rooms,
        vacancy: detail.vacancy,
        post: detail.vacancy ? buildVacancyPost({ houseLabel: label, rooms: detail.vacancy, workNumber: number }) : null,
        channels: [...byChannel.values()].map((group) => ({
          provider: group[0]!.provider,
          label: group[0]!.label,
          linked: group.length,
          total: detail.rooms,
          feed: worstFeed(group.map((connection) => feedStateFor(connection, now))),
        })),
      };
    }),
  );
  return { houses, items: buildAttentionItems({ connections, stays, now, today, unassigned }) };
}
