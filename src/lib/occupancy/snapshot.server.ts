import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchLeasesForManagerUser } from "@/lib/auth/manager-lease-scope";
import {
  airbnbBookingEntries,
  applicationHoldEntries,
  importedChannelStayEntries,
  isImportedChannelBlock,
  leaseBookingEntriesForProperties,
  openEndedBookingHorizonKey,
  roomBlockEntries,
  type ApplicationHoldRow,
  type LeaseBookingRow,
  type RoomDateBlock,
} from "@/lib/channel-calendar/property-bookings";
import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";
import { loadPropertyRecord } from "@/lib/channel-calendar/sync.server";
import { listingSubmissionFromProperty } from "@/lib/channel-calendar/connections.server";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { leaseIsFullyExecuted } from "@/lib/lease-pipeline-storage";
import {
  combineOccupancyEntries,
  dayStayDisplayName,
  exportBlockedRanges,
  occupancyForDay,
  occupancyStayKind,
  type OccupancyCapacities,
  type OccupancyDayCell,
} from "@/lib/occupancy/snapshot";

export type OccupancySnapshotHouseCell = OccupancyDayCell & { propertyId: string };

export type OccupancySnapshotDay = OccupancyDayCell & {
  dayKey: string;
  houses: OccupancySnapshotHouseCell[];
};

export type OccupancySnapshotStay = {
  id: string;
  propertyId: string;
  roomId: string;
  roomLabel: string;
  start: string;
  end: string;
  kind: ReturnType<typeof occupancyStayKind>;
  name: string;
};

function eachDayKey(from: string, to: string): string[] {
  const keys: string[] = [];
  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return keys;
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    keys.push(cursor.toISOString().slice(0, 10));
  }
  return keys;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function leaseBookingRowFromScope(record: {
  id: string;
  property_id?: string | null;
  row_data?: unknown;
}): LeaseBookingRow {
  const data = asRecord(record.row_data);
  const application = asRecord(data.application);
  return {
    id: record.id,
    propertyId: String(record.property_id ?? data.propertyId ?? "").trim(),
    roomChoice: typeof data.roomChoice === "string" ? data.roomChoice : null,
    residentName: str(data.residentName) || undefined,
    stageLabel: str(data.stageLabel) || undefined,
    status: str(data.status) || undefined,
    leaseKind: str(data.leaseKind) || undefined,
    bundleGroupKey: typeof data.bundleGroupKey === "string" ? data.bundleGroupKey : null,
    voidedAt: typeof data.voidedAt === "string" ? data.voidedAt : null,
    fullySignedAt: typeof data.fullySignedAt === "string" ? data.fullySignedAt : null,
    externallySignedLease: data.externallySignedLease === true,
    managerSignature:
      data.managerSignature && typeof data.managerSignature === "object"
        ? (data.managerSignature as LeaseBookingRow["managerSignature"])
        : null,
    residentSignature:
      data.residentSignature && typeof data.residentSignature === "object"
        ? (data.residentSignature as LeaseBookingRow["residentSignature"])
        : null,
    signatureName: typeof data.signatureName === "string" ? data.signatureName : null,
    signedAtIso: typeof data.signedAtIso === "string" ? data.signedAtIso : null,
    application: {
      leaseStart: str(application.leaseStart) || undefined,
      leaseEnd: str(application.leaseEnd) || undefined,
    },
    residentEmail: str(data.residentEmail) || undefined,
  } as LeaseBookingRow & { residentEmail?: string };
}

function holdRowFromApplication(row: {
  id: unknown;
  property_id?: unknown;
  assigned_property_id?: unknown;
  row_data?: unknown;
}): ApplicationHoldRow {
  const data = asRecord(row.row_data);
  const application = asRecord(data.application);
  return {
    id: String(row.id ?? ""),
    bucket: str(data.bucket) || "approved",
    name: str(data.name) || undefined,
    email: str(data.email) || undefined,
    propertyId: String(row.property_id ?? data.propertyId ?? ""),
    assignedPropertyId: String(row.assigned_property_id ?? data.assignedPropertyId ?? ""),
    assignedRoomChoice: str(data.assignedRoomChoice) || undefined,
    application: {
      leaseStart: str(application.leaseStart) || undefined,
      leaseEnd: str(application.leaseEnd) || undefined,
      roomChoice1: str(application.roomChoice1) || undefined,
    },
  };
}

function roomDateBlockFromRecord(row: { id?: unknown; property_id?: unknown; row_data?: unknown }): RoomDateBlock | null {
  const data = asRecord(row.row_data);
  const id = str(row.id) || str(data.id);
  const propertyId = str(row.property_id) || str(data.propertyId);
  const checkIn = str(data.checkIn);
  const checkOut = str(data.checkOut);
  if (!id || !propertyId || !checkIn || !checkOut) return null;
  return {
    id,
    propertyId,
    roomId: str(data.roomId),
    checkIn,
    checkOut,
    reason: str(data.reason),
    ...(str(data.residentName) ? { residentName: str(data.residentName) } : {}),
    ...(str(data.residentEmail) ? { residentEmail: str(data.residentEmail) } : {}),
    ...(str(data.residentPhone) ? { residentPhone: str(data.residentPhone) } : {}),
    ...(data.isBookingResidency === true ? { isBookingResidency: true } : {}),
    createdAt: str(data.createdAt),
  };
}

export async function occupancyCapacitiesForProperties(
  db: SupabaseClient,
  propertyIds: string[],
): Promise<OccupancyCapacities> {
  const beds = new Map<string, number>();
  const rooms = new Map<string, number>();
  for (const propertyId of propertyIds) {
    const record = await loadPropertyRecord(db, propertyId);
    const submission = listingSubmissionFromProperty(record?.property ?? null);
    const listingRooms = submission?.rooms ?? [];
    if (listingRooms.length === 0) {
      beds.set(propertyId, 1);
      continue;
    }
    let total = 0;
    for (const room of listingRooms) {
      const cap = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
      rooms.set(`${propertyId}:${room.id}`, cap);
      total += cap;
    }
    beds.set(propertyId, Math.max(1, total));
  }
  return {
    bedsTotal: (propertyId) => beds.get(propertyId) ?? 1,
    roomCapacity: (propertyId, roomId) => rooms.get(`${propertyId}:${roomId}`) ?? 1,
  };
}

async function occupancyPropertyMeta(
  db: SupabaseClient,
  propertyIds: string[],
): Promise<{
  properties: { id: string; label: string; entireHomeListing: boolean }[];
  roomLabelForId: (propertyId: string, roomId: string) => string;
}> {
  const properties: { id: string; label: string; entireHomeListing: boolean }[] = [];
  const labels = new Map<string, string>();
  for (const propertyId of propertyIds) {
    const record = await loadPropertyRecord(db, propertyId);
    const submission = listingSubmissionFromProperty(record?.property ?? null);
    const rooms = submission?.rooms ?? [];
    rooms.forEach((room, index) => {
      labels.set(`${propertyId}:${room.id}`, room.name?.trim() || `Room ${index + 1}`);
    });
    const building = submission?.buildingName?.trim() || record?.property?.buildingName?.trim() || propertyId;
    properties.push({
      id: propertyId,
      label: building,
      entireHomeListing: submission ? isEntireHomeListing(submission) : rooms.length === 0,
    });
  }
  return {
    properties,
    roomLabelForId: (propertyId, roomId) => labels.get(`${propertyId}:${roomId}`) ?? "Room",
  };
}

async function occupancyHoldEntries(
  db: SupabaseClient,
  userId: string,
  propertyIds: string[],
  leaseRows: Array<LeaseBookingRow & { residentEmail?: string }>,
  meta: Awaited<ReturnType<typeof occupancyPropertyMeta>>,
) {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, property_id, assigned_property_id, row_data")
    .eq("manager_user_id", userId)
    .eq("row_data->>bucket", "approved")
    .limit(500);
  if (error) throw new Error(error.message);
  const scoped = new Set(propertyIds);
  const leasedIds = new Set<string>();
  const leasedPeople = new Set<string>();
  for (const row of leaseRows) {
    if (!leaseIsFullyExecuted(row as Parameters<typeof leaseIsFullyExecuted>[0])) continue;
    const axisId = normalizeApplicationAxisId(row.id ?? "");
    if (axisId) leasedIds.add(axisId);
    const email = row.residentEmail?.trim().toLowerCase();
    if (email) leasedPeople.add(`${email}|${(row.propertyId ?? "").trim()}`);
  }
  const holds = (data ?? [])
    .map(holdRowFromApplication)
    .filter((row) => scoped.has((row.assignedPropertyId || row.propertyId || "").trim()));
  return applicationHoldEntries(holds, {
    properties: meta.properties,
    roomLabelForId: meta.roomLabelForId,
    isLeased: (row) => {
      if (leasedIds.has(normalizeApplicationAxisId(row.id))) return true;
      const email = row.email?.trim().toLowerCase();
      const propertyId = (row.assignedPropertyId ?? row.propertyId ?? "").trim();
      return Boolean(email) && leasedPeople.has(`${email}|${propertyId}`);
    },
    openEndedHorizonKey: openEndedBookingHorizonKey(),
  });
}

async function occupancyBlockEntries(
  db: SupabaseClient,
  userId: string,
  propertyIds: string[],
  meta: Awaited<ReturnType<typeof occupancyPropertyMeta>>,
) {
  if (propertyIds.length === 0) return { imported: [], typed: [] };
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, property_id, row_data")
    .eq("manager_user_id", userId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
    .in("property_id", propertyIds)
    .limit(1000);
  if (error) throw new Error(error.message);
  const blocks = (data ?? [])
    .map(roomDateBlockFromRecord)
    .filter((block): block is RoomDateBlock => Boolean(block));
  const labels = new Map(meta.properties.map((property) => [property.id, property.label]));
  const opts = {
    propertyLabelForId: (propertyId: string) => labels.get(propertyId) ?? propertyId,
    roomLabelForId: meta.roomLabelForId,
  };
  return {
    imported: importedChannelStayEntries(blocks.filter(isImportedChannelBlock), opts),
    typed: roomBlockEntries(
      blocks.filter((block) => !isImportedChannelBlock(block)),
      opts,
    ),
  };
}

export async function occupancySnapshotForManager(
  db: SupabaseClient,
  userId: string,
  input: { propertyIds: string[]; from: string; to: string; browserOrigin?: string },
) {
  const propertyIds = [...new Set(input.propertyIds.map((id) => id.trim()).filter(Boolean))];
  const [bookings, capacities, meta] = await Promise.all([
    listManagerChannelCalendarBookings(db, userId, propertyIds, input.browserOrigin),
    occupancyCapacitiesForProperties(db, propertyIds),
    occupancyPropertyMeta(db, propertyIds),
  ]);
  const leaseRecords = await fetchLeasesForManagerUser(db as Parameters<typeof fetchLeasesForManagerUser>[0], userId);
  const scoped = new Set(propertyIds);
  const leaseRows = leaseRecords.map(leaseBookingRowFromScope).filter((row) => scoped.has((row.propertyId ?? "").trim()));
  const leaseEntries = leaseBookingEntriesForProperties(leaseRows, {
    properties: meta.properties,
    roomLabelForId: meta.roomLabelForId,
    openEndedHorizonKey: openEndedBookingHorizonKey(),
  });
  const [holdEntries, blockEntries] = await Promise.all([
    occupancyHoldEntries(db, userId, propertyIds, leaseRows, meta),
    occupancyBlockEntries(db, userId, propertyIds, meta),
  ]);
  const entries = combineOccupancyEntries(
    airbnbBookingEntries(bookings),
    blockEntries.imported,
    leaseEntries,
    holdEntries,
    blockEntries.typed,
  );
  const days: OccupancySnapshotDay[] = eachDayKey(input.from, input.to).map((dayKey) => ({
    dayKey,
    ...occupancyForDay(entries, dayKey, propertyIds, capacities),
    houses: propertyIds.map((propertyId) => ({
      propertyId,
      ...occupancyForDay(entries, dayKey, [propertyId], capacities),
    })),
  }));
  const stays: OccupancySnapshotStay[] = entries.map((entry) => ({
    id: `${entry.propertyId}:${entry.roomId}:${entry.start}:${entry.summary}`,
    propertyId: entry.propertyId,
    roomId: entry.roomId,
    roomLabel: entry.roomLabel,
    start: entry.start,
    end: entry.end,
    kind: occupancyStayKind(entry),
    name: dayStayDisplayName(entry),
  }));
  return {
    days,
    stays,
    version: new Date().toISOString(),
  };
}

export function mergeExportRanges(input: {
  leases?: readonly { start: string; end: string }[];
  holds?: readonly { start: string; end: string }[];
  typedBlocks?: readonly { start: string; end: string }[];
}) {
  return exportBlockedRanges(input);
}
