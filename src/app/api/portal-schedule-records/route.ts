import { afterResponse } from "@/lib/after-response.server";
import { loadPropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import { resolveRowStayTimes, stampStayRow } from "@/lib/bookings/stay-stamp";
import { DEFAULT_PROPERTY_STAY_TIMES, staysOverlap, type PropertyStayTimes } from "@/lib/bookings/stay-times";
import { isImportedChannelBlock } from "@/lib/channel-calendar/property-bookings";
import { normalizeChannelLink, stayMayAutoLink, type ChannelLink } from "@/lib/channel-calendar/channel-link";
import { monthDay } from "@/lib/channel-calendar/channel-overlap";
import { CHANNEL_OVERLAP_UNVERIFIED, checkStayAgainstChannels } from "@/lib/channel-calendar/channel-overlap.server";
import { roomBlockNameShapeUnchanged, roomDateBlockNameError } from "@/lib/channel-calendar/room-block-name-rule";
import { emitNativeBookingEvent, type NativeBookingEvent } from "@/lib/channel-booking-events.server";
import { createJsonRecordRoute } from "@/lib/portal-record-api";
import {
  isManagerScopedScheduleRecordType,
  managerScheduleRecordIdOwnedByUser,
  vendorScheduleRecordTypes,
  ROOM_DATE_BLOCK_RECORD_TYPE,
  CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
  isDedicatedBookingsRecordType,
  roomDateBlockRecordIdPrefix,
} from "@/lib/portal-schedule-record-scope";
import { carryGuestStayFields } from "@/lib/short-stay/guest-stays";
import { syncManagerAvailabilityToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { summarizeAvailabilityChange } from "@/lib/availability-change-summary";
import { resolvePropertyOwnerUserId } from "@/lib/property-owner.server";
import { emitAvailabilityChangedEvent } from "@/lib/tour-events.server";
import { replaceManagerPlannedScheduleSlice } from "@/lib/planned-schedule-persistence.server";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import {
  PARTNER_INQUIRIES_RECORD_ID,
  PLANNED_EVENTS_RECORD_ID,
  projectScheduleRecordsForViewer,
} from "@/lib/schedule-record-projection.server";
import {
  handleTestWorkspaceScheduleGet,
  handleTestWorkspaceSchedulePost,
} from "@/lib/test-workspaces/schedule-route.server";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { managerCanWriteCalendarForProperty } from "@/lib/auth/manager-lease-scope";

export const runtime = "nodejs";

/**
 * WS3: painted tour availability lands on the manager's Google Calendar as
 * free ("Open for tours") blocks; WS5: the change is announced to the team
 * that shares the property. Both record types are manager-scoped (see
 * `isManagerScopedScheduleRecordType`), so `record.manager_user_id` is always
 * the authenticated manager by the time `afterWrite` runs.
 */
const AVAILABILITY_RECORD_TYPES = new Set(["manager_availability", "manager_property_availability"]);

type RoomDateBlockRow = { id?: unknown; row_data?: unknown };

function isRoomDateBlockRecordType(recordType: string): boolean {
  return recordType === ROOM_DATE_BLOCK_RECORD_TYPE || recordType === CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE;
}

function roomDateBlockField(row: RoomDateBlockRow, key: string): string {
  const rowData = row.row_data;
  if (!rowData || typeof rowData !== "object") return "";
  const value = (rowData as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function roomDateBlockData(record: unknown): Record<string, unknown> {
  const rowData = record && typeof record === "object" ? (record as { row_data?: unknown }).row_data : null;
  return rowData && typeof rowData === "object" && !Array.isArray(rowData) ? (rowData as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A booking (a NAMED, live block that is not an Airbnb/Booking import) is the only thing an owner is
 * told about; a room the manager closed, and a channel import (announced by the calendar sync), are not.
 */
function isAnnouncedBooking(record: unknown): boolean {
  const data = roomDateBlockData(record);
  const status = text(data.bookingStatus);
  return Boolean(text(data.residentName)) && text(data.blockKind) !== "closed" && !isImportedChannelBlock({ reason: text(data.reason) }) && status !== "cancelled";
}

/** True when a save leaves the stored row's name, kind and reason untouched - a restore, or an edit of something else. */
function sameRoomBlockNameShape(existing: Record<string, unknown> | null, record: Record<string, unknown>): boolean {
  if (!existing) return false;
  return roomBlockNameShapeUnchanged(roomDateBlockData(existing), roomDateBlockData(record));
}

async function announceNativeBooking(db: Parameters<typeof emitNativeBookingEvent>[0], event: NativeBookingEvent, record: Record<string, unknown>): Promise<void> {
  const data = roomDateBlockData(record);
  const managerUserId = text(record.manager_user_id);
  const propertyId = text(record.property_id) || text(data.propertyId);
  if (!managerUserId || !propertyId) return;
  await emitNativeBookingEvent(db, {
    event,
    blockId: text(record.id),
    managerUserId,
    propertyId,
    roomId: text(data.roomId),
    guestName: text(data.residentName),
    checkIn: text(data.checkIn),
    checkOut: text(data.checkOut),
    openEnded: data.openEnded === true,
  });
}

/**
 * The server-side half of the "Room 9 is booked … by …" refusal
 * (PLAN-0920-1058, area 1e; docs/agents/shared-room-capacity.md's 409
 * contract for a different table). The client already screens against every
 * booking source it can see (`bookingConflictsFor`); this is the authoritative
 * re-check against every OTHER manager-made hold on the same room, and then
 * against what the room's Airbnb / Booking.com calendars hold
 * (`checkStayAgainstChannels`: the reservation this stay is linked to is the
 * stay itself, PropLane's own echoed export is not a closure). This
 * read-check-write is not database serialization; concurrent writes still need
 * the room-capacity transaction before the last-bed guarantee can be claimed.
 */
async function roomDateBlockOverlapConflict(args: {
  db: Parameters<typeof syncManagerAvailabilityToGoogleCalendar>[0];
  managerUserId: string;
  recordId: string;
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  /** This save's resolved wall times and the property's defaults, so the other stays' times read the same way. */
  checkInTime: string;
  checkOutTime: string;
  propertyTimes: PropertyStayTimes;
  /** What the channel check needs of this save (omitted = native holds only). */
  channel?: {
    link?: ChannelLink;
    storedLink?: ChannelLink;
    derive: boolean;
    reason: string;
    openEnded: boolean;
  };
}): Promise<{ conflict: string | null; channelLink?: ChannelLink | null }> {
  const { db, managerUserId, recordId, propertyId, roomId, checkIn, checkOut, checkInTime, checkOutTime, propertyTimes } = args;
  if (!propertyId || !checkIn || !checkOut) return { conflict: null };
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE);
  if (error || !data) return { conflict: CHANNEL_OVERLAP_UNVERIFIED };
  for (const row of data as RoomDateBlockRow[]) {
    if (String(row.id ?? "") === recordId) continue;
    const otherRoomId = roomDateBlockField(row, "roomId");
    // Whole-home ("") collides with every room; otherwise only the same room does.
    if (roomId && otherRoomId && roomId !== otherRoomId) continue;
    const otherCheckIn = roomDateBlockField(row, "checkIn");
    const otherCheckOut = roomDateBlockField(row, "checkOut");
    if (!otherCheckIn || !otherCheckOut) continue;
    // Check-out is EXCLUSIVE (block Sep 10 -> Sep 12 frees the 12th), and the stays carry exact
    // times: an 11:00 check-out and a 3:00 pm check-in on one day do not collide, a 2:00 pm late
    // checkout against a noon early check-in does.
    const otherData = row.row_data && typeof row.row_data === "object" ? (row.row_data as Record<string, unknown>) : {};
    const otherTimes = resolveRowStayTimes(otherData, null, propertyTimes);
    const overlaps = staysOverlap(
      { id: recordId, checkIn, checkOut, checkInTime, checkOutTime },
      { id: String(row.id ?? ""), checkIn: otherCheckIn, checkOut: otherCheckOut, ...otherTimes },
    );
    if (!overlaps) continue;
    const otherRoomLabel = roomDateBlockField(row, "roomId") ? "That room" : "This room";
    const who = roomDateBlockField(row, "residentName") || roomDateBlockField(row, "reason") || "another hold";
    return { conflict: `${otherRoomLabel} is booked ${monthDay(otherCheckIn)} – ${monthDay(otherCheckOut)} by ${who}` };
  }
  if (!args.channel) return { conflict: null };
  const checked = await checkStayAgainstChannels(db, {
    propertyId,
    roomId,
    checkIn,
    checkOut,
    openEnded: args.channel.openEnded,
    reason: args.channel.reason,
    link: args.channel.link,
    storedLink: args.channel.storedLink,
    derive: args.channel.derive,
    ownId: recordId,
    blockRows: data as RoomDateBlockRow[],
  });
  return { conflict: checked.conflict, channelLink: checked.link ?? null };
}

/**
 * The team notice goes to the PROPERTY OWNER's team when the record is about
 * one house (a co-manager's availability on the owner's house is the owner's
 * team's news), else to the writer's own team. Idempotent on what changed,
 * so a retried save never re-posts.
 */
async function announceAvailabilityChange(input: {
  db: Parameters<typeof emitAvailabilityChangedEvent>[0];
  managerUserId: string;
  recordId: string;
  propertyId: string | null;
  rowData: unknown;
  previousRowData: unknown;
}): Promise<void> {
  const change = summarizeAvailabilityChange(input.previousRowData, input.rowData);
  if (!change) return;
  const owner = (await resolvePropertyOwnerUserId(input.db, input.propertyId)) ?? input.managerUserId;
  await emitAvailabilityChangedEvent(input.db, {
    managerUserId: owner,
    changedByUserId: input.managerUserId,
    summary: change.summary,
    entityId: input.recordId,
    propertyId: input.propertyId,
    changeKey: change.changeKey,
  });
}

type PlannedEventValue = Record<string, unknown>;

function plannedEventsFromRow(row: Record<string, unknown> | null | undefined): PlannedEventValue[] {
  const rowData = row?.row_data;
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return [];
  const payload = (rowData as Record<string, unknown>).payload;
  return Array.isArray(payload)
    ? payload.filter(
        (item): item is PlannedEventValue =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}

function plannedEventId(event: PlannedEventValue): string {
  return typeof event.id === "string" ? event.id.trim() : String(event.id ?? "").trim();
}

function plannedEventOwner(event: PlannedEventValue): string {
  return typeof event.managerUserId === "string" ? event.managerUserId.trim() : "";
}

function isTourPlannedEvent(event: PlannedEventValue): boolean {
  return typeof event.kind === "string" && event.kind.trim() === "tour";
}

/** Property ids that are safe to put inside a PostgREST filter list; anything else is simply not matched. */
function filterSafeIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.trim()).filter((id) => /^[A-Za-z0-9_.:-]+$/.test(id));
}

/**
 * Service STAFF of the open workspace run its bookings, including the ones the workspace owner typed by hand
 * (stamped to the OWNER, so the owner column alone hides them). The scope is the workspace's own houses and
 * room-block rows only, derived server-side from membership (`loadServiceStaffScope`).
 */
function serviceScopeIds(user: { serviceScope?: { propertyIds: string[] } | null }): string[] {
  return filterSafeIds(user.serviceScope?.propertyIds ?? []);
}

function staffMayRunBlocksOn(user: { serviceScope?: { propertyIds: string[] } | null }, propertyId: string): boolean {
  return Boolean(propertyId) && Boolean(user.serviceScope?.propertyIds.includes(propertyId));
}

/** The viewer may write room blocks on this house: a Calendar grant, or service staff of the workspace that holds it. */
async function mayWriteBlocksOn(
  db: Parameters<typeof managerCanWriteCalendarForProperty>[0],
  user: { id: string; serviceScope?: { propertyIds: string[] } | null },
  propertyId: string,
): Promise<boolean> {
  if (staffMayRunBlocksOn(user, propertyId)) return true;
  return Boolean(propertyId) && (await managerCanWriteCalendarForProperty(db, user.id, propertyId));
}

function scheduleRecordScope(
  query: unknown,
  user: { id: string; role: string; serviceScope?: { propertyIds: string[] } | null },
): unknown {
  const q = query as { or: (filters: string) => unknown };
  if (user.role === "admin") return query;
  const staffIds = serviceScopeIds(user);
  const staffBranch =
    staffIds.length > 0
      ? `,and(property_id.in.(${staffIds.join(",")}),record_type.in.(${ROOM_DATE_BLOCK_RECORD_TYPE},${CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE}))`
      : "";
  if (user.role === "vendor") {
    return q.or(
      `manager_user_id.eq.${user.id},id.eq.axis_vendor_avail_slots_v2_${user.id},id.eq.axis_vendor_flex_prefs_${user.id}`,
    );
  }
  // A room block the caller wrote is stamped to the house's OWNER, so the owner column alone would
  // hide a co-manager's own block from the Remove they just created it with. Their blocks carry
  // their id in the record id and an insert cannot claim anyone else's prefix.
  return q.or(
    `manager_user_id.eq.${user.id},id.like.axis_mgr_avail_slots_v2_${user.id}%,id.like.axis_calendar_share_avail_${user.id}_prop_%,id.like.${roomDateBlockRecordIdPrefix(user.id)}%,id.eq.axis_manager_tasks_v1_${user.id},id.eq.axis_admin_partner_inquiries_v1,id.eq.axis_admin_planned_events_v1${staffBranch}`,
  );
}

function scheduleUserHasRole(user: { role: string; roles?: string[] }, role: string): boolean {
  return user.role === role || user.roles?.includes(role) === true;
}

const route = createJsonRecordRoute({
  table: "portal_schedule_records",
  resolveServiceScope: true,
  // An admin in their own manager portal reads and writes like any manager; the all-owners schedule
  // read is admin oversight (`?oversight=admin`, sent by admin pages).
  explicitAdminOversight: true,
  // portal_schedule_records actually has these columns (see
  // 20260428201000_portal_backend_records.sql) — keep selecting them for
  // the existing-row check and delete targets, matching what this table's
  // schema supports (unlike portal_bug_feedback_records, which does not).
  existingRowSelect: "id, manager_user_id, property_id, record_type, row_data",
  deleteRowSelect: "id, manager_user_id, property_id, record_type, row_data",
  readRecords: async ({ db, user }) => {
    const select = "id, manager_user_id, property_id, record_type, row_data, updated_at";
    // Shared JSON containers are fetched by exact id so an ordinary-row limit
    // can never hide the baseline or pending-inquiry singleton. Ordinary rows
    // are scoped first and only then bounded for predictable egress.
    const singletonQuery = db
      .from("portal_schedule_records")
      .select(select)
      .in("id", [PLANNED_EVENTS_RECORD_ID, PARTNER_INQUIRIES_RECORD_ID]);
    let ordinaryQuery = db
      .from("portal_schedule_records")
      .select(select)
      .neq("id", PLANNED_EVENTS_RECORD_ID)
      .neq("id", PARTNER_INQUIRIES_RECORD_ID)
      .order("updated_at", { ascending: false })
      .limit(500);
    ordinaryQuery = scheduleRecordScope(ordinaryQuery, user) as typeof ordinaryQuery;
    const reads = [singletonQuery, ordinaryQuery];
    // The viewer's active workspace, server-resolved from their own selection
    // cookie. `null` = not narrowing (no workspace / a resolution failure —
    // never widens); a non-null array (possibly empty) is the exact set of
    // houses to show. Admin/vendor turns are unaffected — workspace selection
    // is a per-manager-viewer concept, not something an admin's cross-tenant
    // read or a vendor's own scope was ever narrowed by.
    const isManagerViewer = !scheduleUserHasRole(user, "admin") && !scheduleUserHasRole(user, "vendor");
    const workspaceScope = isManagerViewer ? await activeWorkspacePropertyScope(db, user.id) : null;
    if (isManagerViewer && scheduleUserHasRole(user, "manager")) {
      const [calendar, applications] = await Promise.all([
        linkedOwnerScopeForModule(db, user.id, "calendar", "read"),
        linkedOwnerScopeForModule(db, user.id, "applications", "edit"),
      ]);
      let linkedPropertyIds = [...new Set([...calendar.propertyIds, ...applications.propertyIds])];
      // Real SQL narrowing (not post-fetch): intersect the co-manager grant
      // with the active workspace scope before it ever becomes an `.in(...)`.
      if (workspaceScope !== null) {
        const allowed = new Set(workspaceScope);
        linkedPropertyIds = linkedPropertyIds.filter((id) => allowed.has(id));
      }
      if (linkedPropertyIds.length > 0) {
        const linkedColumnQuery =
          db
            .from("portal_schedule_records")
            .select(select)
            .neq("id", PLANNED_EVENTS_RECORD_ID)
            .neq("id", PARTNER_INQUIRIES_RECORD_ID)
            .in("property_id", linkedPropertyIds)
            .order("updated_at", { ascending: false })
            .limit(500);
        // Legacy standalone inquiry rows may carry propertyId only inside
        // row_data. Scope that JSON path before its own limit too; projection
        // still performs the authoritative ownership/grant check.
        const linkedLegacyQuery = db
          .from("portal_schedule_records")
          .select(select)
          .neq("id", PLANNED_EVENTS_RECORD_ID)
          .neq("id", PARTNER_INQUIRIES_RECORD_ID)
          .in("row_data->>propertyId", linkedPropertyIds)
          .order("updated_at", { ascending: false })
          .limit(500);
        reads.push(
          linkedColumnQuery,
          linkedLegacyQuery,
        );
      }
    }
    // Service staff: every room block of the open workspace's houses, whoever wrote it. Its own bounded
    // read, so a busy workspace's newest rows cannot be crowded out by the viewer's own.
    const staffIds = isManagerViewer ? serviceScopeIds(user) : [];
    if (staffIds.length > 0) {
      reads.push(
        db
          .from("portal_schedule_records")
          .select(select)
          .in("property_id", staffIds)
          .in("record_type", [ROOM_DATE_BLOCK_RECORD_TYPE, CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE])
          .order("updated_at", { ascending: false })
          .limit(500),
      );
    }
    const results = await Promise.all(reads);
    const records = new Map<string, Record<string, unknown>>();
    for (const result of results) {
      for (const record of (result.data ?? []) as Record<string, unknown>[]) {
        const id = String(record.id ?? "").trim();
        if (id && !records.has(id)) records.set(id, record);
      }
    }
    let values = [...records.values()];
    // Workspace narrowing on the "own rows" branch happens HERE, post-fetch,
    // rather than as one more SQL predicate folded into `scheduleRecordScope`'s
    // `.or(...)`: that OR already spans several account-level utility/cache
    // rows sharing this one table — the manager-tasks singleton
    // (`axis_manager_tasks_v1_*`, scoped separately in-process by
    // manager-tasks.server.ts, since its own house lives inside a JSON array,
    // not this row's `property_id`), the per-property availability-cache
    // blobs (`axis_mgr_avail_slots_v2_*`, `axis_calendar_share_avail_*`), and
    // (already carved out above) the admin-shared PLANNED_EVENTS/
    // PARTNER_INQUIRIES singletons. Every one of those rows carries
    // `property_id: null`, so filtering ONLY rows that actually name a
    // property (the real tours/bookings/calendar/availability rows) narrows
    // exactly the surface this scoping is about while leaving every
    // account-level row exempt, matching this file's account-level-row rule.
    if (workspaceScope !== null) {
      const allowed = new Set(workspaceScope);
      values = values.filter((record) => {
        const propertyId = String(record.property_id ?? "").trim();
        if (!propertyId) return true;
        return allowed.has(propertyId);
      });
    }
    return {
      data: values,
      error: results.find((result) => result.error)?.error ?? null,
    };
  },
  projectRead: async ({ db, user, records }) => {
    const projected = await projectScheduleRecordsForViewer(db, user, records);
    // Service staff also see the open workspace's room blocks (the projection above keeps only rows the
    // viewer wrote or may see through a grant). Only room-block rows of the workspace's own houses, only staff.
    const staffHouses = new Set(serviceScopeIds(user));
    if (staffHouses.size === 0) return projected;
    const seen = new Set(projected.map((record) => String(record.id ?? "")));
    const extra = records.filter(
      (record) =>
        !seen.has(String(record.id ?? "")) &&
        isRoomDateBlockRecordType(String(record.record_type ?? "")) &&
        staffHouses.has(String(record.property_id ?? "").trim()),
    );
    return [...projected, ...extra];
  },
  scope: scheduleRecordScope,
  buildUpsert: (row, user) => {
    const recordType = String(row.recordType ?? row.record_type ?? "event");
    return {
      id: row.id,
      // Only an admin may attribute a row to another owner (or leave it null for
      // shared singletons, which are scoped by fixed id, not owner). EVERY
      // non-admin write is pinned to the caller — otherwise a client could set
      // manager_user_id to a victim manager and plant rows on their calendar for
      // any record type outside the manager-scoped allowlist (e.g. "event").
      manager_user_id:
        user.role === "admin" ? (row.managerUserId ?? row.manager_user_id ?? null) : user.id,
      property_id: row.propertyId ?? row.property_id ?? null,
      record_type: recordType,
      starts_at: row.startsAt ?? row.starts_at ?? row.startIso ?? null,
      ends_at: row.endsAt ?? row.ends_at ?? row.endIso ?? null,
      row_data: row,
      updated_at: new Date().toISOString(),
    };
  },
  assignOwnership: (record, user) => {
    if (user.role === "admin") return record;
    if (user.role === "vendor") return { ...record, manager_user_id: user.id };
    const recordType = String(record.record_type ?? "");
    const managerScoped = isManagerScopedScheduleRecordType(recordType);
    // Only stamp ownership on manager-scoped types; shared singleton records
    // (partner inquiries, planned events) keep their existing owner handling.
    return managerScoped ? { ...record, manager_user_id: user.id } : record;
  },
  // A room block stays stamped to the house owner for its whole life: the capacity trigger only
  // accepts the owner's stamp, and a co-manager's Remove (saved as a cancelled block) must not
  // move the row onto them. `buildUpsert` pins every non-admin write to the caller, so the stored
  // owner is restored here for an UPDATE; an INSERT is stamped in `atomicWrite` instead.
  reconcileExisting: (record, user, existing) => {
    if (!existing) return record;
    if (!isRoomDateBlockRecordType(String(record.record_type ?? ""))) return record;
    // The guest's login, their head-count, the request's source and the hold's 24-hour deadline are
    // server-owned: the booking editor sends back only the fields it draws, and a save must not strip
    // them (the capacity trigger weighs a stay by `stayDetails.guests`, and the expiry cron and the
    // Approve/Decline answer both read `stayDetails`). A platform admin edits a guest stay through the
    // same editor, so the carry runs before the owner-restore below is skipped for them.
    const carried = carryGuestStayFields(existing.row_data, record.row_data);
    const next = carried ? { ...record, row_data: carried } : record;
    if (user.role === "admin") return next;
    const storedOwner = String(existing.manager_user_id ?? "").trim();
    return storedOwner ? { ...next, manager_user_id: storedOwner } : next;
  },
  atomicWrite: async ({ db, user, record, existing, expectedPayload, expectedPayloadKnown }) => {
    // Every manager write of a stay stamps its exact times and real instants (docs/agents/bookings.md
    // § Exact times): the save's own times, else the stored row's, else the property's defaults. The
    // paid early / late add-ons are carried from the stored row, never taken from the body.
    let stayTimes: { checkInTime: string; checkOutTime: string } = { checkInTime: "15:00", checkOutTime: "11:00" };
    let propertyStayTimes: PropertyStayTimes | null = null;
    if (isRoomDateBlockRecordType(String(record.record_type ?? ""))) {
      // The guest's login is server-owned: `createShortStayRows` stamps it from a session or a proven
      // phone, and the stay charge, the guest's Stays and the arrival-guide / checkout texts are all
      // keyed on it. A save from this route never sets or moves it - the body's value is dropped and
      // the stored one kept - so a manager cannot aim a charge or a door code at another account.
      const { residentUserId: _bodyGuest, ...bodyRowData } = roomDateBlockData(record);
      const storedGuest = existing ? roomDateBlockData(existing).residentUserId : undefined;
      record.row_data = typeof storedGuest === "string" && storedGuest ? { ...bodyRowData, residentUserId: storedGuest } : bodyRowData;
      const clock = await loadPropertyStayClock(db, String(record.property_id ?? "").trim() || null);
      const stamped = stampStayRow(roomDateBlockData(record), existing ? roomDateBlockData(existing) : null, clock);
      record.row_data = stamped.rowData;
      if (stamped.startsAt && stamped.endsAt) {
        record.starts_at = stamped.startsAt;
        record.ends_at = stamped.endsAt;
      }
      stayTimes = { checkInTime: String(stamped.rowData.checkInTime), checkOutTime: String(stamped.rowData.checkOutTime) };
      propertyStayTimes = clock.times;
    }
    if (isRoomDateBlockRecordType(String(record.record_type ?? "")) && existing) {
      // Changing or removing a block needs the same Calendar edit access that creating it did,
      // re-checked now: a revoked grant must not keep a block of someone else's house writable.
      const storedOwner = String(existing.manager_user_id ?? "").trim();
      const blockPropertyId = String(existing.property_id ?? record.property_id ?? "").trim();
      if (storedOwner && storedOwner !== user.id && !scheduleUserHasRole(user, "admin")) {
        const allowed = await mayWriteBlocksOn(db, user, blockPropertyId);
        if (!allowed) {
          return { handled: true, error: "You need Calendar edit access on this property to change its room blocks.", status: 403 };
        }
      }
    }
    if (String(record.record_type ?? "") === CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE) {
      // Eligibility comes from the persisted stay, never the replacement body's dates.
      const priorType = String(existing?.record_type ?? "");
      if (!existing || (priorType !== ROOM_DATE_BLOCK_RECORD_TYPE && priorType !== CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE)) {
        return { handled: true, error: "Only an existing manager booking can be cancelled.", status: 409 };
      }
      const start = roomDateBlockField(existing, "checkIn");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      // A started block can still be removed until its last night (check-out is exclusive); the
      // export feed then drops it and the channel reopens the rest. Same rule as `canCancelBooking`.
      const end = roomDateBlockField(existing, "checkOut");
      if (priorType !== CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE && (!start || (end && end <= today) || isImportedChannelBlock({ reason: roomDateBlockField(existing, "reason") }))) {
        return { handled: true, error: "Only current or upcoming manager bookings can be removed.", status: 409 };
      }
      return { handled: false };
    }
    if (String(record.record_type ?? "") === ROOM_DATE_BLOCK_RECORD_TYPE) {
      // A room block belongs to the house: the capacity trigger only accepts one stamped with the
      // property OWNER. A co-manager holding Calendar at edit on that house writes it under the
      // owner (their own id kept as createdByUserId); anyone else is refused here, never stamped.
      const blockPropertyId = String(record.property_id ?? "").trim();
      if (!existing && blockPropertyId) {
        const owner = await resolvePropertyOwnerUserId(db, blockPropertyId);
        if (owner && String(record.manager_user_id ?? "") !== owner) {
          // An admin's write arrives unstamped (assignOwnership leaves admin rows alone).
          const allowed =
            owner === user.id ||
            scheduleUserHasRole(user, "admin") ||
            (await mayWriteBlocksOn(db, user, blockPropertyId));
          if (!allowed) {
            return { handled: true, error: "You need Calendar edit access on this property to block its rooms.", status: 403 };
          }
          const rowData = record.row_data && typeof record.row_data === "object" ? (record.row_data as Record<string, unknown>) : {};
          // Mutates the record the shared handler upserts next (see portal-record-api atomicWrite).
          record.manager_user_id = owner;
          record.row_data = { ...rowData, createdByUserId: user.id };
        }
      }
      // Every booking has a name; a room with no guest is "Closed" with a reason. Arbitrated only once
      // the writer is known to be allowed here at all, so a revoked grant is a 403 and never a naming
      // 400 that would also say whether the stored row's shape differs from what was sent. A cancelled
      // block is never refused - and neither is a save that leaves the stored row's name, kind and
      // reason exactly as they already are: putting back what was just cancelled (Undo), and editing
      // the dates of a row written before this rule existed, must always work. New content is what the
      // rule arbitrates.
      if (!sameRoomBlockNameShape(existing, record)) {
        const data = roomDateBlockData(record);
        const nameError = roomDateBlockNameError({ bookingStatus: data.bookingStatus, residentName: data.residentName, blockKind: data.blockKind, reason: data.reason });
        if (nameError) return { handled: true, error: nameError, status: 400 };
      }
      const savedData = roomDateBlockData(record);
      const savedDetails = savedData.stayDetails && typeof savedData.stayDetails === "object" && !Array.isArray(savedData.stayDetails) ? (savedData.stayDetails as Record<string, unknown>) : {};
      const storedDetails = existing ? roomDateBlockData(existing).stayDetails : null;
      const storedLink = storedDetails && typeof storedDetails === "object" ? normalizeChannelLink((storedDetails as Record<string, unknown>).channelLink) : undefined;
      // A channel import mirrors the channel's own stay, so it is never checked against the channel it came from.
      const checkChannels = savedData.bookingStatus !== "cancelled" && !isImportedChannelBlock({ reason: text(savedData.reason) });
      const overlap = await roomDateBlockOverlapConflict({
        db,
        managerUserId: String(record.manager_user_id ?? user.id),
        recordId: String(record.id ?? ""),
        propertyId: String(record.property_id ?? ""),
        roomId: roomDateBlockField(record as RoomDateBlockRow, "roomId"),
        checkIn: roomDateBlockField(record as RoomDateBlockRow, "checkIn"),
        checkOut: roomDateBlockField(record as RoomDateBlockRow, "checkOut"),
        ...stayTimes,
        propertyTimes: propertyStayTimes ?? DEFAULT_PROPERTY_STAY_TIMES,
        ...(checkChannels
          ? {
              channel: {
                link: normalizeChannelLink(savedDetails.channelLink),
                storedLink,
                derive: stayMayAutoLink({
                  residentName: text(savedData.residentName),
                  blockKind: text(savedData.blockKind),
                  cancelled: savedData.bookingStatus === "cancelled",
                  reason: text(savedData.reason),
                }),
                reason: text(savedData.reason),
                openEnded: savedData.openEnded === true,
              },
            }
          : {}),
      });
      if (overlap.conflict) return { handled: true, error: overlap.conflict, status: 409 };
      if (checkChannels && overlap.channelLink !== undefined) {
        // The link is stored as the server verified it (a typed link no reservation answers to is dropped; an
        // auto-link is written on this save, the manager's own, never as a background change).
        const { channelLink: _typed, ...detailsWithoutLink } = savedDetails;
        void _typed;
        const nextDetails = overlap.channelLink ? { ...detailsWithoutLink, channelLink: overlap.channelLink } : detailsWithoutLink;
        record.row_data = { ...savedData, ...(Object.keys(nextDetails).length > 0 || savedData.stayDetails ? { stayDetails: nextDetails } : {}) };
      }
      return { handled: false };
    }
    if (String(record.id) !== PLANNED_EVENTS_RECORD_ID) {
      return { handled: false };
    }
    const rowData = record.row_data;
    const payload = rowData && typeof rowData === "object" && !Array.isArray(rowData)
      ? (rowData as { payload?: unknown }).payload
      : [];
    const existingEvents = plannedEventsFromRow(existing);
    const existingById = new Map(
      existingEvents
        .map((event) => [plannedEventId(event), event] as const)
        .filter(([id]) => Boolean(id)),
    );

    const events = (Array.isArray(payload) ? payload : [])
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
      .filter((item) => {
        const id = plannedEventId(item);
        const stored = id ? existingById.get(id) : undefined;
        // Tours are lifecycle-owned by their dedicated cancel/reschedule routes,
        // even for admins. A generic snapshot can never delete or rewrite one.
        if (isTourPlannedEvent(item) || (stored && isTourPlannedEvent(stored))) return false;
        if (user.role === "admin") return true;
        if (stored && plannedEventOwner(stored) !== user.id) return false;
        const claimedOwner = plannedEventOwner(item);
        return !claimedOwner || claimedOwner === user.id;
      })
      .map((item) => user.role === "admin" ? item : ({ ...item, managerUserId: user.id }));

    const expectedPayloadValue = expectedPayloadKnown && Array.isArray(expectedPayload)
      ? expectedPayload
      : null;
    const expectedEvents = expectedPayloadValue
      ? expectedPayloadValue
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item && typeof item === "object" && !Array.isArray(item)),
          )
          .filter((item) => !isTourPlannedEvent(item))
          .filter((item) => user.role === "admin" || plannedEventOwner(item) === user.id)
      : null;
    const result = await replaceManagerPlannedScheduleSlice(db, {
      managerUserId: user.id,
      actorIsAdmin: user.role === "admin",
      events,
      expectedEvents,
    });
    // A manager's shared snapshot cannot safely fall back to an ordinary
    // upsert: an old database would otherwise reopen the exact lost-booking
    // race this transaction boundary is meant to close.
    if (!result.available) {
      return { handled: true, error: "Calendar write is unavailable. Refresh and try again.", status: 503 };
    }
    if (!result.ok) return { handled: true, error: result.reason, status: 409 };
    return { handled: true };
  },
  authorizeUpsert: async ({ db, user, records }) => {
    if (records.some((record) => isDedicatedBookingsRecordType(String(record.record_type ?? "")))) {
      return {
        ok: false,
        error: "Stay details and removed channel stays are changed through their dedicated Bookings routes.",
        status: 403,
      };
    }
    if (records.some((record) => String(record.id ?? "").trim() === PARTNER_INQUIRIES_RECORD_ID)) {
      return {
        ok: false,
        error: "Inquiry records must be changed through their dedicated lifecycle routes.",
        status: 403,
      };
    }
    // A create/update must land IN the active workspace: a manager-scoped,
    // property-tagged record (a tour, a calendar event, an availability block)
    // naming a house outside it is refused before it is ever written, never
    // silently saved against another workspace's house. Account-level rows
    // (no property_id — availability caches, the manager-tasks singleton) are
    // exempt for the same reason the read side leaves them exempt above.
    if (!scheduleUserHasRole(user, "admin") && !scheduleUserHasRole(user, "vendor")) {
      const workspaceScope = await activeWorkspacePropertyScope(db, user.id);
      if (workspaceScope !== null) {
        const allowed = new Set(workspaceScope);
        for (const record of records) {
          const id = String(record.id ?? "").trim();
          // Account-level rows (no property_id — availability caches, the
          // manager-tasks singleton) are exempt for the same reason the read
          // side leaves them exempt above; PLANNED_EVENTS is the one shared
          // singleton actually reachable through this ordinary upsert path.
          if (id === PLANNED_EVENTS_RECORD_ID) continue;
          const propertyId = String(record.property_id ?? "").trim();
          if (!propertyId) continue;
          if (!allowed.has(propertyId)) {
            return {
              ok: false,
              error: `Property ${propertyId} is not in the active workspace.`,
              status: 403,
            };
          }
        }
      }
    }
    return { ok: true };
  },
  authorizeDelete: async ({ db, user, records }) => {
    if (records.some((record) => isDedicatedBookingsRecordType(String(record.record_type ?? "")))) {
      return {
        ok: false,
        error: "Stay details and removed channel stays are changed through their dedicated Bookings routes.",
        status: 403,
      };
    }
    if (records.some((record) => {
      const id = String(record.id ?? "").trim();
      return id === PLANNED_EVENTS_RECORD_ID || id === PARTNER_INQUIRIES_RECORD_ID;
    })) {
      return {
        ok: false,
        error: "Shared calendar and inquiry records must be changed through their dedicated lifecycle routes.",
      };
    }
    // Removing a block of someone else's house needs the Calendar edit access that created it,
    // re-checked here — the same rule the update path applies in `atomicWrite`.
    if (!scheduleUserHasRole(user, "admin")) {
      for (const record of records) {
        if (!isRoomDateBlockRecordType(String(record.record_type ?? ""))) continue;
        const storedOwner = String(record.manager_user_id ?? "").trim();
        if (!storedOwner || storedOwner === user.id) continue;
        const propertyId = String(record.property_id ?? "").trim();
        if (!propertyId || !(await mayWriteBlocksOn(db, user, propertyId))) {
          return { ok: false, error: "You need Calendar edit access on this property to remove its room blocks.", status: 403 };
        }
      }
    }
    // An update or delete must refuse a row outside the active workspace, same
    // as a create — see the matching check in `authorizeUpsert`.
    if (!scheduleUserHasRole(user, "admin") && !scheduleUserHasRole(user, "vendor")) {
      const workspaceScope = await activeWorkspacePropertyScope(db, user.id);
      if (workspaceScope !== null) {
        const allowed = new Set(workspaceScope);
        for (const record of records) {
          const propertyId = String(record.property_id ?? "").trim();
          if (!propertyId) continue;
          if (!allowed.has(propertyId)) {
            return { ok: false, error: "Record not found.", status: 404 };
          }
        }
      }
    }
    return { ok: true };
  },
  assertInsertAllowed: (record, user) => {
    if (user.role === "admin") return null;
    const recordType = String(record.record_type ?? "");
    if (user.role === "vendor") {
      if (!vendorScheduleRecordTypes().includes(recordType as "vendor_availability" | "vendor_flexible_preferences")) {
        return "Vendors can only update their own availability records.";
      }
      const id = String(record.id ?? "");
      if (!managerScheduleRecordIdOwnedByUser(id, user.id, recordType)) {
        return "Record id must belong to the authenticated vendor.";
      }
      return null;
    }
    if (!isManagerScopedScheduleRecordType(recordType)) return null;
    const id = String(record.id ?? "");
    if (!managerScheduleRecordIdOwnedByUser(id, user.id, recordType)) {
      return "Record id must belong to the authenticated manager.";
    }
    return null;
  },
  afterDelete: async ({ records, db }) => {
    // Deleting a live booking is a cancellation as far as its owner is concerned. Best-effort, idempotent
    // on the block id - and off the response's critical path, exactly like `afterWrite`: the client must
    // not wait on two reads, the delivery fan-out and an outbound email to learn the row is gone.
    afterResponse(async () => {
      for (const target of records) {
        if (!isRoomDateBlockRecordType(String(target.record_type ?? "")) || !isAnnouncedBooking(target)) continue;
        if (String(target.record_type ?? "") === CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE) continue;
        await announceNativeBooking(db, "booking_cancelled", target).catch((e) => console.warn("[bookings] cancel notice failed", e));
      }
    }, "bookings");
  },
  afterWrite: async ({ record, existing, db }) => {
    const recordType = String(record.record_type ?? "");
    if (isRoomDateBlockRecordType(recordType)) {
      const wasLive = Boolean(existing) && String(existing?.record_type ?? "") === ROOM_DATE_BLOCK_RECORD_TYPE && text(roomDateBlockData(existing).bookingStatus) !== "cancelled";
      const cancelledNow = recordType === CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE || text(roomDateBlockData(record).bookingStatus) === "cancelled";
      // A booking the owner has not heard of yet: a fresh row, and equally a closed room or an unnamed
      // block that has just been given a guest's name. Idempotent on `native:<blockId>:booking_created`,
      // so a row that was already announced announces nothing a second time.
      const wasAnnounced = Boolean(existing) && isAnnouncedBooking(existing);
      const task = async () => {
        if (!wasAnnounced && !cancelledNow && isAnnouncedBooking(record)) await announceNativeBooking(db, "booking_created", record);
        // The cancelled row still carries the guest's name; announce it once, from the live booking it replaced.
        else if (cancelledNow && wasLive) {
          const asLive = { ...record, row_data: { ...roomDateBlockData(record), bookingStatus: "confirmed" } };
          if (isAnnouncedBooking(asLive)) await announceNativeBooking(db, "booking_cancelled", record);
        }
      };
      afterResponse(task, "bookings");
      return;
    }
    if (!AVAILABILITY_RECORD_TYPES.has(recordType)) return;
    const managerUserId = String(record.manager_user_id ?? "").trim();
    const recordId = String(record.id ?? "").trim();
    if (!managerUserId || !recordId) return;
    const propertyId = String(record.property_id ?? "").trim() || null;
    const previousRowData = existing?.row_data ?? null;
    const task = () =>
      Promise.all([
        syncManagerAvailabilityToGoogleCalendar(db, managerUserId, {
          recordId,
          rowData: record.row_data,
          previousRowData,
        }).catch((e) => console.warn("[google-calendar] availability push failed", e)),
        announceAvailabilityChange({
          db,
          managerUserId,
          recordId,
          propertyId,
          rowData: record.row_data,
          previousRowData,
        }).catch((e) => console.warn("[team-comms] availability change notice failed", e)),
      ]);
    afterResponse(task, "availability");
  },
});

export function GET(req?: Request) {
  return handleTestWorkspaceScheduleGet(() => route.GET(req));
}

export function POST(req: Request) {
  return handleTestWorkspaceSchedulePost(req, (request) => route.POST(request));
}
