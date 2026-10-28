import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";
import { buildAttentionItems, feedStateFor, type ChannelHealth, type ChannelHealthHouse, type FeedState, type HealthConnection, type HealthStay, type UnassignedApproval } from "@/lib/channel-calendar/channel-health";
import { listingRentedWhole } from "@/lib/channel-calendar/export-occupancy";
import { listingSubmissionFromProperty } from "@/lib/channel-calendar/connections.server";
import { loadPropertyRecord } from "@/lib/channel-calendar/sync.server";
import { buildVacancyPost, type VacancyRoom } from "@/lib/channel-calendar/vacancy-post";
import { resolveListingTextNumber } from "@/lib/listing-text-number.server";
import { pacificTodayKey } from "@/lib/public-room-live-label";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { findPublicRoomOccupancy } from "@/lib/public-listing-available-count";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { publicRoomStatus } from "@/lib/room-availability";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";

const FEED_SEVERITY: FeedState[] = ["error", "stale", "never", "waiting", "fetched", "unmonitored"];

function worstFeed(states: readonly FeedState[]): FeedState {
  return FEED_SEVERITY.find((state) => states.includes(state)) ?? "unmonitored";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The house's `room_date_block` rows as the health reader needs them. */
async function loadStays(db: SupabaseClient, propertyIds: readonly string[], roomLabels: ReadonlyMap<string, string>, houseLabels: ReadonlyMap<string, string>): Promise<HealthStay[]> {
  if (propertyIds.length === 0) return [];
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, property_id, row_data")
    .in("property_id", [...propertyIds])
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE);
  if (error) throw new Error(error.message);
  const out: HealthStay[] = [];
  for (const row of (data ?? []) as Array<{ id?: unknown; property_id?: unknown; row_data?: unknown }>) {
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

async function loadVacancy(
  db: SupabaseClient,
  propertyId: string,
  today: string,
): Promise<{ rooms: number; vacancy: VacancyRoom[] | null; label: string | null; roomLabels: Array<[string, string]>; rentedWhole: boolean; ownerUserId: string | null; workspaceId: string | null }> {
  const record = await loadPropertyRecord(db, propertyId);
  const submission = listingSubmissionFromProperty(record?.property ?? null);
  const rooms = submission?.rooms ?? [];
  const roomLabels: Array<[string, string]> = rooms.map((room) => [`${propertyId}::${room.id}`, room.name?.trim() || room.id]);
  const { data: workspace } = await db.from("manager_property_records").select("workspace_id").eq("id", propertyId).maybeSingle();
  const base = { rooms: rooms.length, rentedWhole: listingRentedWhole(submission), label: record?.property?.buildingName?.trim() || record?.property?.title?.trim() || null, roomLabels, ownerUserId: record?.managerUserId ?? null, workspaceId: workspace?.workspace_id ? String(workspace.workspace_id) : null };
  if (!submission || rooms.length === 0) return { ...base, vacancy: [] };
  try {
    const occupancy = await loadPublicRoomOccupancy(db, [{ id: propertyId, listingSubmission: submission }]);
    return {
      ...base,
      vacancy: rooms.map((room) => ({
        roomId: room.id,
        name: room.name?.trim() || room.id,
        rentLabel: room.monthlyRent > 0 ? `${formatRoomPriceAmount(room.monthlyRent)}/mo` : "",
        status: publicRoomStatus(room, findPublicRoomOccupancy(occupancy, propertyId, room.id)?.spans ?? [], today),
      })),
    };
  } catch {
    return { ...base, vacancy: null };
  }
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
    const { data, error } = await db.from("manager_application_records").select(select).eq("row_data->>bucket", "approved").eq(column, propertyId).limit(500);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      if (text(row.ical_connection) || text(row.withdrawn) || text(row.choice) || text(row.preferred)) continue;
      const start = text(row.manual_start) || text(row.lease_start);
      const end = text(row.manual_end) || text(row.lease_end);
      if (!start || (end && end < today)) continue;
      found.set(text(row.id), { id: text(row.id), propertyId, houseLabel, name: text(row.name) });
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
  const details = await Promise.all(properties.map((property) => loadVacancy(db, property.propertyId, today)));
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
