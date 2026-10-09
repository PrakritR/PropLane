import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { managerCanWriteCalendarForProperty, managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import {
  buildExportCalendarUrl,
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
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { pruneTombstonedRanges } from "@/lib/channel-calendar/stay-tombstones";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import { loadChannelStayTombstoneKeys } from "@/lib/channel-calendar/stay-tombstones.server";

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
    sourceUid: r.sourceUid,
    start: r.start,
    end: r.end || r.start,
    summary: r.summary?.trim() || "Booked",
    ...(isHostBlockRange(r) ? { hostBlock: true } : {}),
  }));
}

export async function listManagerChannelCalendarBookings(
  db: SupabaseClient,
  userId: string,
  propertyIds: string[],
  browserOrigin?: string,
): Promise<ManagerChannelBookingProperty[]> {
  const requestedIds = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (requestedIds.length === 0) return [];

  // Ownership/co-manager access alone is not enough: switching the active
  // workspace must hide another of the manager's own workspaces' booking
  // data from this panel, the same as every other module. `null` (no
  // workspaces, or the load failed) never narrows.
  const workspaceScope = await activeWorkspacePropertyScope(db, userId);
  const uniqueIds = workspaceScope === null ? requestedIds : requestedIds.filter((id) => workspaceScope.includes(id));
  if (uniqueIds.length === 0) return [];

  const allowed: string[] = [];
  // The Airbnb / channel import URL is a bearer secret (anyone holding it reads the
  // reservations outside PropLane), so it only reaches managers who can edit the
  // calendar — the same bar as linking it. View-only teammates see `hasImportUrl`.
  const canSeeImportUrl = new Set<string>();
  for (const propertyId of uniqueIds) {
    if (await managerHasCalendarAccessForProperty(db, userId, propertyId)) {
      allowed.push(propertyId);
      if (await managerCanWriteCalendarForProperty(db, userId, propertyId)) canSeeImportUrl.add(propertyId);
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

  // A stay the manager removed never draws, even if a sync that was already in
  // flight stored it again (C2-AB7).
  const tombstoneKeys = await loadChannelStayTombstoneKeys(db, allowed);

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
      ranges: normalizeRanges(
        pruneTombstonedRanges(
          connection.imported_ranges ?? [],
          { propertyId: connection.property_id, roomId: connection.room_id, provider: connection.provider },
          tombstoneKeys,
        ).kept,
      ),
      lastSyncedAt: connection.last_synced_at,
      lastError: connection.last_error,
      hasImportUrl: Boolean(connection.import_url?.trim()),
      importUrl: canSeeImportUrl.has(connection.property_id) ? connection.import_url?.trim() || null : null,
      exportUrl: buildExportCalendarUrl(connection.export_token, browserOrigin),
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
