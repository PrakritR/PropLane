import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import {
  listingSubmissionFromProperty,
  parseConnectionRow,
} from "@/lib/channel-calendar/connections.server";
import type {
  ChannelCalendarImportedRange,
  ManagerChannelBookingProperty,
  ManagerChannelBookingRange,
  ManagerChannelBookingRoom,
} from "@/lib/channel-calendar/types";
import type { MockProperty } from "@/data/types";
import { loadPropertyRecord } from "@/lib/channel-calendar/sync.server";
import { dateKeyInBookingRange } from "@/lib/channel-calendar/bookings-dates";

function propertyLabelFromRecord(
  propertyId: string,
  property: MockProperty | null,
  rowData: Record<string, unknown> | null,
): string {
  const submission = listingSubmissionFromProperty(property);
  const building =
    submission?.buildingName?.trim() ||
    property?.buildingName?.trim() ||
    String(rowData?.buildingName ?? "").trim();
  const unit =
    submission?.unitLabel?.trim() ||
    property?.unitLabel?.trim() ||
    String(rowData?.unitLabel ?? "").trim();
  if (building && unit) return `${building} · ${unit}`;
  if (building) return building;
  return propertyId;
}

function roomLabelFromSubmission(
  property: MockProperty | null,
  roomId: string,
  fallbackLabel: string | null,
): string {
  const submission = listingSubmissionFromProperty(property);
  const room = submission?.rooms.find((r) => r.id === roomId);
  return room?.name?.trim() || fallbackLabel?.trim() || roomId;
}

function normalizeRanges(imported: ChannelCalendarImportedRange[]): ManagerChannelBookingRange[] {
  return imported.map((r) => ({
    start: r.start,
    end: r.end || r.start,
    summary: r.summary?.trim() || "Booked",
  }));
}

export async function listManagerChannelCalendarBookings(
  db: SupabaseClient,
  userId: string,
  propertyIds: string[],
): Promise<ManagerChannelBookingProperty[]> {
  const uniqueIds = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const allowed: string[] = [];
  for (const propertyId of uniqueIds) {
    if (await managerHasCalendarAccessForProperty(db, userId, propertyId)) {
      allowed.push(propertyId);
    }
  }
  if (allowed.length === 0) return [];

  const { data, error } = await db
    .from("external_calendar_connections")
    .select("*")
    .in("property_id", allowed)
    .order("property_id", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const propertyCache = new Map<
    string,
    Awaited<ReturnType<typeof loadPropertyRecord>>
  >();

  const byProperty = new Map<string, ManagerChannelBookingRoom[]>();

  for (const raw of data ?? []) {
    const connection = parseConnectionRow(raw as Record<string, unknown>);
    let record = propertyCache.get(connection.property_id);
    if (record === undefined) {
      record = await loadPropertyRecord(db, connection.property_id);
      propertyCache.set(connection.property_id, record);
    }

    const room: ManagerChannelBookingRoom = {
      connectionId: connection.id,
      roomId: connection.room_id,
      roomLabel: roomLabelFromSubmission(record?.property ?? null, connection.room_id, connection.label),
      provider: connection.provider,
      label: connection.label,
      ranges: normalizeRanges(connection.imported_ranges ?? []),
      lastSyncedAt: connection.last_synced_at,
      lastError: connection.last_error,
      hasImportUrl: Boolean(connection.import_url?.trim()),
    };

    const list = byProperty.get(connection.property_id) ?? [];
    list.push(room);
    byProperty.set(connection.property_id, list);
  }

  return allowed
    .filter((propertyId) => byProperty.has(propertyId))
    .map((propertyId) => {
      const record = propertyCache.get(propertyId) ?? null;
      return {
        propertyId,
        propertyLabel: propertyLabelFromRecord(
          propertyId,
          record?.property ?? null,
          record?.rowData ?? null,
        ),
        rooms: byProperty.get(propertyId) ?? [],
      };
    });
}

export { dateKeyInBookingRange };
