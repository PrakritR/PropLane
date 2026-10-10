import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { collectLinkedPropertyPermissionsForUser, fetchLeasesForManagerUser } from "@/lib/auth/manager-lease-scope";
import { hasCoManagerPermissionLevelForProperty } from "@/lib/co-manager-permissions";
import {
  airbnbBookingEntries,
  applicationHoldEntries,
  importedChannelStayEntries,
  isImportedChannelBlock,
  leaseBookingEntriesForProperties,
  openEndedBookingHorizonKey,
  roomBlockEntries,
  withoutResidentFinancials,
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
import { loadOccupancyAuthors, occupancyAuthorTrusted } from "@/lib/occupancy/row-authorship.server";
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
  /** Resident-backed stays only — what the resident pays per month, when it is on file. */
  monthlyRent?: number;
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

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function holdRowFromApplication(row: {
  id: unknown;
  property_id?: unknown;
  assigned_property_id?: unknown;
  row_data?: unknown;
}): ApplicationHoldRow {
  const data = asRecord(row.row_data);
  const application = asRecord(data.application);
  const manual = asRecord(data.manualResidentDetails);
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
    signedMonthlyRent: positiveNumber(data.signedMonthlyRent),
    manualResidentDetails: {
      moveInDate: str(manual.moveInDate) || undefined,
      moveOutDate: str(manual.moveOutDate) || undefined,
      phone: str(manual.phone) || undefined,
      monthlyRent: positiveNumber(manual.monthlyRent),
      securityDeposit: typeof manual.securityDeposit === "number" && Number.isFinite(manual.securityDeposit) ? manual.securityDeposit : undefined,
      leaseTerm: str(manual.leaseTerm) || undefined,
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
    openEnded: data.openEnded === true,
    bookingStatus: data.bookingStatus === "confirmed" ? "confirmed" : "hold",
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

const APPROVED_HOLD_ROW_PAGE = 500;
const APPROVED_HOLD_ROW_MAX_PAGES = 40;
const APPROVED_HOLD_ID_CHUNK = 50;
const APPROVED_HOLD_SCOPE_CONCURRENCY = 6;
const ROOM_BLOCK_ROW_PAGE = 500;
const ROOM_BLOCK_ROW_MAX_PAGES = 40;
const ROOM_BLOCK_ID_CHUNK = 100;

type ApprovedHoldRow = { id: unknown; manager_user_id: unknown; property_id: unknown; assigned_property_id: unknown; row_data: unknown };

/**
 * Where an approved row can name one of these properties. Scope is by PROPERTY, never by
 * `manager_user_id`: the workspace is shared, so a resident another co-manager added still holds a
 * room in these houses (same reach as the calendar export feed). Each source is its own filter
 * rather than one `or(...)` expression, so a property id is never interpolated into filter grammar
 * and no id is ever too exotic to narrow on.
 */
type ApprovedHoldScope =
  | { kind: "column"; column: "property_id" | "assigned_property_id"; ids: string[] }
  | { kind: "roomChoice"; propertyId: string };

/** A property id is matched literally: `%`, `_` and `\` would otherwise widen the room-choice match. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function approvedHoldScopes(propertyIds: string[]): ApprovedHoldScope[] {
  const scopes: ApprovedHoldScope[] = [];
  for (let at = 0; at < propertyIds.length; at += APPROVED_HOLD_ID_CHUNK) {
    const ids = propertyIds.slice(at, at + APPROVED_HOLD_ID_CHUNK);
    scopes.push({ kind: "column", column: "property_id", ids });
    scopes.push({ kind: "column", column: "assigned_property_id", ids });
  }
  for (const propertyId of propertyIds) scopes.push({ kind: "roomChoice", propertyId });
  return scopes;
}

async function readApprovedHoldScope(db: SupabaseClient, scope: ApprovedHoldScope): Promise<ApprovedHoldRow[]> {
  const rows: ApprovedHoldRow[] = [];
  for (let page = 0; page < APPROVED_HOLD_ROW_MAX_PAGES; page += 1) {
    const base = db
      .from("manager_application_records")
      .select("id, manager_user_id, property_id, assigned_property_id, row_data")
      .eq("row_data->>bucket", "approved");
    const scoped =
      scope.kind === "column"
        ? base.in(scope.column, scope.ids)
        : base.like("row_data->>assignedRoomChoice", `${escapeLikePattern(scope.propertyId)}::%`);
    // One row past the page, so "is there more?" is answered by the same read: a scope whose row
    // count lands exactly on a page boundary must not be mistaken for a truncated one.
    const { data, error } = await scoped
      .order("id", { ascending: true })
      .range(page * APPROVED_HOLD_ROW_PAGE, page * APPROVED_HOLD_ROW_PAGE + APPROVED_HOLD_ROW_PAGE);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as unknown as ApprovedHoldRow[];
    const hasMore = batch.length > APPROVED_HOLD_ROW_PAGE;
    for (const row of hasMore ? batch.slice(0, APPROVED_HOLD_ROW_PAGE) : batch) rows.push(row);
    if (!hasMore) return rows;
  }
  // Rows beyond the bound are occupancy this snapshot never read. Drawing the calendar anyway
  // would show an occupied room as free, so refuse the snapshot rather than truncate it.
  throw new Error("Approved-application read for this occupancy snapshot exceeded its page bound.");
}

/**
 * Every scope is an independent read of the same table, so they run together rather than one after
 * the other: a portfolio of 50 houses asks for one room-choice scope per house, and serialized that
 * is ~52 round trips the Bookings calendar and the export feed both wait on. Concurrency is capped
 * so a large portfolio cannot open an unbounded number of connections at once.
 */
async function readApprovedHoldRows(db: SupabaseClient, propertyIds: string[]): Promise<ApprovedHoldRow[]> {
  const scopes = approvedHoldScopes(propertyIds);
  const batches: ApprovedHoldRow[][] = [];
  for (let at = 0; at < scopes.length; at += APPROVED_HOLD_SCOPE_CONCURRENCY) {
    batches.push(
      ...(await Promise.all(
        scopes.slice(at, at + APPROVED_HOLD_SCOPE_CONCURRENCY).map((scope) => readApprovedHoldScope(db, scope)),
      )),
    );
  }
  const rows: ApprovedHoldRow[] = [];
  const seen = new Set<string>();
  for (const batch of batches) {
    for (const row of batch) {
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      rows.push(row);
    }
  }
  return rows;
}

export async function occupancyHoldEntries(
  db: SupabaseClient,
  propertyIds: string[],
  leaseRows: Array<LeaseBookingRow & { residentEmail?: string }>,
  meta: Awaited<ReturnType<typeof occupancyPropertyMeta>>,
) {
  if (propertyIds.length === 0) return [];
  const [data, authors] = await Promise.all([readApprovedHoldRows(db, propertyIds), loadOccupancyAuthors(db, propertyIds)]);
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
  // A row holds a house's room only when its author is the owner or a teammate linked to that house.
  const holds = (data ?? []).flatMap((row) => {
    const hold = holdRowFromApplication(row);
    const propertyId = (hold.assignedPropertyId || hold.propertyId || "").trim();
    return scoped.has(propertyId) && occupancyAuthorTrusted(authors, propertyId, row.manager_user_id) ? [hold] : [];
  });
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

type RoomDateBlockRow = { id: unknown; property_id: unknown; row_data: unknown };

/**
 * Every `room_date_block` row of these houses, paged and ordered by primary key.
 *
 * PostgREST leaves row order unspecified without an `order`, so a bare `limit` returned an
 * arbitrary slice past the cap and the closed dates it dropped drew as free on the Bookings
 * calendar and in the export feed. Refuse the snapshot past the bound rather than truncate it,
 * exactly as the approved-hold read does.
 */
async function readRoomDateBlockRows(db: SupabaseClient, propertyIds: string[]): Promise<RoomDateBlockRow[]> {
  const rows: RoomDateBlockRow[] = [];
  const seen = new Set<string>();
  for (let at = 0; at < propertyIds.length; at += ROOM_BLOCK_ID_CHUNK) {
    const ids = propertyIds.slice(at, at + ROOM_BLOCK_ID_CHUNK);
    let exhausted = false;
    for (let page = 0; page < ROOM_BLOCK_ROW_MAX_PAGES; page += 1) {
      // One row past the page answers "is there more?" from the same read.
      const { data, error } = await db
        .from("portal_schedule_records")
        .select("id, property_id, row_data")
        .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
        .in("property_id", ids)
        .order("id", { ascending: true })
        .range(page * ROOM_BLOCK_ROW_PAGE, page * ROOM_BLOCK_ROW_PAGE + ROOM_BLOCK_ROW_PAGE);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as unknown as RoomDateBlockRow[];
      const hasMore = batch.length > ROOM_BLOCK_ROW_PAGE;
      for (const row of hasMore ? batch.slice(0, ROOM_BLOCK_ROW_PAGE) : batch) {
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
    if (!exhausted) throw new Error("Room-block read for this occupancy snapshot exceeded its page bound.");
  }
  return rows;
}

async function occupancyBlockEntries(
  db: SupabaseClient,
  propertyIds: string[],
  meta: Awaited<ReturnType<typeof occupancyPropertyMeta>>,
) {
  if (propertyIds.length === 0) return { imported: [], typed: [] };
  const data = await readRoomDateBlockRows(db, propertyIds);
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

/**
 * Houses whose residents' money and phone numbers this viewer may read: the ones they own, and the
 * ones a teammate link grants them Residents view on. Calendar access alone shows who is where and
 * when, never what they pay.
 */
async function residentFinancialPropertyIds(db: SupabaseClient, userId: string, propertyIds: string[]): Promise<Set<string>> {
  const allowed = new Set<string>();
  if (propertyIds.length === 0) return allowed;
  const [owned, linked] = await Promise.all([
    db.from("manager_property_records").select("id").eq("manager_user_id", userId).in("id", propertyIds),
    collectLinkedPropertyPermissionsForUser(db as Parameters<typeof collectLinkedPropertyPermissionsForUser>[0], userId),
  ]);
  for (const row of (owned.data ?? []) as Array<{ id?: unknown }>) {
    const id = String(row.id ?? "").trim();
    if (id) allowed.add(id);
  }
  for (const id of propertyIds) {
    if (!allowed.has(id) && hasCoManagerPermissionLevelForProperty(linked.get(id), id, "residents", "read")) allowed.add(id);
  }
  return allowed;
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
  const [holdEntries, blockEntries, financialHouses] = await Promise.all([
    occupancyHoldEntries(db, propertyIds, leaseRows, meta),
    occupancyBlockEntries(db, propertyIds, meta),
    residentFinancialPropertyIds(db, userId, propertyIds),
  ]);
  const entries = combineOccupancyEntries(
    airbnbBookingEntries(bookings),
    blockEntries.imported,
    leaseEntries,
    holdEntries,
    blockEntries.typed,
  ).map((entry) => (financialHouses.has(entry.propertyId) ? entry : withoutResidentFinancials(entry)));
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
    ...(typeof entry.monthlyRent === "number" && Number.isFinite(entry.monthlyRent)
      ? { monthlyRent: entry.monthlyRent }
      : {}),
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
