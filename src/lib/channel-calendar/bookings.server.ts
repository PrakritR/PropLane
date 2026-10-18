import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { managerCanWriteCalendarForProperties, managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
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
import { importedRangeUid, pruneTombstonedRanges } from "@/lib/channel-calendar/stay-tombstones";
import { airbnbReservationUrl, isPhoneLast4 } from "@/lib/channel-calendar/reservation-details";
import { loadChannelStayDetailRows } from "@/lib/channel-calendar/stay-details.server";
import { channelStayDetailsKey, type ChannelStayMoney } from "@/lib/channel-calendar/stay-details";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import { wallTimeOfInstant } from "@/lib/bookings/stay-stamp";
import { propertyTimeZoneForZip } from "@/lib/property-time-zone";
import { loadChannelStayTombstoneKeys } from "@/lib/channel-calendar/stay-tombstones.server";

/** The connection columns a slim read needs - everything but `imported_ranges`. */
const SLIM_CONNECTION_COLUMNS =
  "id,manager_user_id,property_id,room_id,provider,label,import_url,export_token,last_synced_at,last_error,export_last_fetched_at";

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

export function normalizeRanges(
  imported: ChannelCalendarImportedRange[],
  guestNames?: ReadonlyMap<string, string>,
  stayMoney?: ReadonlyMap<string, ChannelStayMoney>,
  /** The house's time zone, to read a stay's overridden check-in / check-out instants as wall "HH:MM". */
  timeZone?: string,
): ManagerChannelBookingRange[] {
  return imported.map((r) => {
    const hostBlock = isHostBlockRange(r);
    const reservationUrl = hostBlock ? null : airbnbReservationUrl(r.reservationCode);
    const guestName = hostBlock ? undefined : guestNames?.get(importedRangeUid(r));
    // A host block's details are stored under its UID plus its dates - Airbnb gives every block on
    // a feed the same UID, so the UID alone would read another block's note onto this one.
    const detailsKey = channelStayDetailsKey({ sourceUid: importedRangeUid(r), start: r.start, end: r.end, hostBlock, summary: r.summary });
    const allMoney = stayMoney?.get(detailsKey);
    const money = hostBlock ? undefined : allMoney;
    return {
      sourceUid: r.sourceUid,
      start: r.start,
      end: r.end || r.start,
      summary: r.summary?.trim() || "Booked",
      ...(hostBlock ? { hostBlock: true } : {}),
      ...(reservationUrl && r.reservationCode ? { reservationCode: r.reservationCode, reservationUrl } : {}),
      ...(!hostBlock && isPhoneLast4(r.phoneLast4) ? { phoneLast4: r.phoneLast4 } : {}),
      ...(guestName ? { guestName } : {}),
      ...(allMoney?.notes ? { stayNotes: allMoney.notes } : {}),
      ...(money?.guestPhone ? { guestPhone: money.guestPhone } : {}),
      ...(typeof money?.nightlyCents === "number" ? { nightlyCents: money.nightlyCents } : {}),
      ...(typeof money?.payoutCents === "number" ? { payoutCents: money.payoutCents, currency: money.currency ?? "USD" } : {}),
      ...(money?.paidAt ? { paidAt: money.paidAt } : {}),
      ...stayTimeOverride(money, timeZone),
    };
  });
}

/** A manager's check-in / check-out override: the instants, and the "HH:MM" they read as on the house's clock. */
function stayTimeOverride(money: ChannelStayMoney | undefined, timeZone: string | undefined): Partial<ManagerChannelBookingRange> {
  if (!money || (!money.checkInAt && !money.checkOutAt)) return {};
  const zone = timeZone ?? propertyTimeZoneForZip("");
  const checkInTime = wallTimeOfInstant(money.checkInAt, zone);
  const checkOutTime = wallTimeOfInstant(money.checkOutAt, zone);
  return {
    ...(money.checkInAt ? { checkInAt: money.checkInAt } : {}),
    ...(money.checkOutAt ? { checkOutAt: money.checkOutAt } : {}),
    ...(checkInTime ? { checkInTime } : {}),
    ...(checkOutTime ? { checkOutTime } : {}),
  };
}

/**
 * `slim` is the Connect modal's and the Integrations row's read: the same rooms and links but never
 * the stored `imported_ranges` (the heaviest column, one JSON array per connection), the removed-stay
 * tombstones or the guest-name rows. Those only draw the Bookings calendar, which uses the full read.
 */
export async function listManagerChannelCalendarBookings(
  db: SupabaseClient,
  userId: string,
  propertyIds: string[],
  browserOrigin?: string,
  opts: { slim?: boolean } = {},
): Promise<ManagerChannelBookingProperty[]> {
  const slim = opts.slim === true;
  const requestedIds = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (requestedIds.length === 0) return [];

  // Ownership/co-manager access alone is not enough: switching the active
  // workspace must hide another of the manager's own workspaces' booking
  // data from this panel, the same as every other module. `null` (no
  // workspaces, or the load failed) never narrows.
  const workspaceScope = await activeWorkspacePropertyScope(db, userId);
  const uniqueIds = workspaceScope === null ? requestedIds : requestedIds.filter((id) => workspaceScope.includes(id));
  if (uniqueIds.length === 0) return [];

  // One access check per house, all at once: awaiting them one by one made this read grow with the
  // portfolio (a 28-room workspace spent most of the Connect popup's 12 seconds right here).
  const accessible = await Promise.all(
    uniqueIds.map(async (propertyId) => (await managerHasCalendarAccessForProperty(db, userId, propertyId)) ? propertyId : null),
  );
  const allowed = accessible.filter((propertyId): propertyId is string => propertyId !== null);
  if (allowed.length === 0) return [];

  // The Airbnb / channel import URL is a bearer secret (anyone holding it reads the
  // reservations outside PropLane), so it only reaches managers who can edit the
  // calendar — the same bar as linking it. View-only teammates see `hasImportUrl`.
  // One decision for every house, in two round trips rather than two per house:
  // this list backs the calendar page's own snapshot read.
  // The writable decision, the connection rows and (in a full read) the tombstones do not depend on
  // each other.
  const [canSeeImportUrl, connectionsRead, tombstoneKeys] = await Promise.all([
    managerCanWriteCalendarForProperties(db, userId, allowed),
    db
      .from("external_calendar_connections")
      .select(slim ? SLIM_CONNECTION_COLUMNS : "*")
      .in("property_id", allowed)
      .order("property_id", { ascending: true })
      .order("created_at", { ascending: true }),
    // A stay the manager removed never draws, even if a sync that was already in
    // flight stored it again (C2-AB7).
    slim ? Promise.resolve(new Set<string>()) : loadChannelStayTombstoneKeys(db, allowed),
  ]);
  const { data, error } = connectionsRead;
  if (error) throw new Error(error.message);

  const connectionRows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const recordIds = [...new Set(connectionRows.map((row) => String(row.property_id ?? "")).filter(Boolean))];
  // Manager-entered guest names (one query for every connection in scope) and every house's record
  // (once each, all at once rather than one awaited read per house inside the loop below).
  const [stayRows, propertyEntries] = await Promise.all([
    slim
      ? Promise.resolve(new Map() as Awaited<ReturnType<typeof loadChannelStayDetailRows>>)
      : loadChannelStayDetailRows(db, connectionRows.map((row) => String(row.id ?? ""))),
    Promise.all(
      recordIds.map(async (id) => [id, await loadPropertyRecord(db, id)] as [string, Awaited<ReturnType<typeof loadPropertyRecord>>]),
    ),
  ]);
  const propertyCache = new Map(propertyEntries);
  const guestNames = new Map<string, Map<string, string>>();
  for (const [connectionId, byUid] of stayRows) {
    const names = new Map<string, string>();
    for (const [uid, row] of byUid) if (row.guestName) names.set(uid, row.guestName);
    guestNames.set(connectionId, names);
  }

  const byProperty = new Map<string, ManagerChannelBookingRoom[]>();

  for (const raw of connectionRows) {
    const connection = parseConnectionRow(slim ? { ...raw, imported_ranges: [] } : raw);
    const record = propertyCache.get(connection.property_id) ?? null;

    const room: ManagerChannelBookingRoom = {
      connectionId: connection.id,
      roomId: connection.room_id,
      roomLabel: roomLabelFromSubmission(record?.property ?? null, connection.room_id, connection.label),
      provider: connection.provider,
      label: connection.label,
      ranges: slim ? [] : normalizeRanges(
        pruneTombstonedRanges(
          connection.imported_ranges ?? [],
          { propertyId: connection.property_id, roomId: connection.room_id, provider: connection.provider },
          tombstoneKeys,
        ).kept,
        guestNames.get(connection.id),
        stayRows.get(connection.id),
        propertyTimeZoneForZip(String(listingSubmissionFromProperty(record?.property ?? null)?.zip ?? record?.property?.zip ?? "")),
      ),
      lastSyncedAt: connection.last_synced_at,
      lastError: connection.last_error,
      exportLastFetchedAt: connection.export_last_fetched_at,
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
