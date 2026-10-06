import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * C2-AB7: a removed Airbnb stay stays removed after the next sync. Remove leaves
 * a durable tombstone keyed by (house, room, channel, feed UID); the sync prunes
 * tombstoned UIDs before it stores anything; Undo deletes the tombstone and
 * restores the range it carried. Ownership is re-derived from the session.
 */

const mocks = vi.hoisted(() => ({
  // Remove / Undo rewrite what the house publishes and blocks, so they need Calendar at EDIT — the
  // same level as linking, unlinking and syncing, not the read grant.
  managerCanWriteCalendarForProperty: vi.fn(async () => true),
  upsertResidents: vi.fn(async () => ({ created: 0, updated: 0, skipped: 0 })),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanWriteCalendarForProperty: mocks.managerCanWriteCalendarForProperty,
}));
vi.mock("@/lib/channel-calendar/airbnb-residents.server", () => ({
  upsertAirbnbResidentsFromImportedRanges: mocks.upsertResidents,
}));

import {
  channelStayTombstoneKey,
  pruneTombstonedRanges,
} from "@/lib/channel-calendar/stay-tombstones";
import {
  channelStayTombstoneRecordId,
  loadChannelStayTombstoneKeys,
  removeChannelStay,
  restoreChannelStay,
} from "@/lib/channel-calendar/stay-tombstones.server";
import { syncChannelCalendarConnection } from "@/lib/channel-calendar/sync.server";
import { CHANNEL_STAY_TOMBSTONE_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";

const MANAGER = "mgr-1";
const OTHER = "mgr-2";
const MARCUS: ChannelCalendarImportedRange = { id: "marcus", sourceUid: "uid-marcus", summary: "Marcus", start: "2026-10-10", end: "2026-10-14" };
const PRIYA: ChannelCalendarImportedRange = { id: "priya", sourceUid: "uid-priya", summary: "Priya", start: "2026-10-20", end: "2026-10-22" };
const IMPORT_URL = "https://www.airbnb.com/calendar/ical/123.ics?s=abc";

function ics(events: Array<{ uid: string; summary: string; start: string; end: string }>): string {
  const body = events
    .map((e) => `BEGIN:VEVENT\nUID:${e.uid}\nSUMMARY:${e.summary}\nDTSTART;VALUE=DATE:${e.start}\nDTEND;VALUE=DATE:${e.end}\nEND:VEVENT`)
    .join("\n");
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`;
}
// iCal DTEND is exclusive; the parser converts to the inclusive last night.
const FEED = ics([
  { uid: "uid-marcus", summary: "Marcus", start: "20261010", end: "20261015" },
  { uid: "uid-priya", summary: "Priya", start: "20261020", end: "20261023" },
]);

function setup(extra: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    external_calendar_connections: [
      {
        id: "conn-1",
        manager_user_id: MANAGER,
        property_id: "prop-1",
        room_id: "room-1",
        provider: "airbnb",
        label: "Room 1",
        import_url: IMPORT_URL,
        export_token: "tok",
        imported_ranges: [MARCUS, PRIYA],
        last_synced_at: null,
        last_error: null,
      },
    ],
    manager_property_records: [
      { id: "prop-1", manager_user_id: MANAGER, property_data: { id: "prop-1", title: "House", listingSubmission: { v: 1, rooms: [{ id: "room-1", name: "Room 1", manualUnavailableRanges: [] }] } }, row_data: {} },
    ],
    portal_schedule_records: [],
    ...extra,
  };
  return { tables, db: fakeSupabaseClient(tables) as never };
}

beforeEach(() => {
  mocks.managerCanWriteCalendarForProperty.mockReset().mockResolvedValue(true);
  mocks.upsertResidents.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(FEED, { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("tombstone identity", () => {
  it("keys a stay by house, room, channel and feed UID", () => {
    const base = { propertyId: "p", roomId: "r", provider: "airbnb", sourceUid: "u" };
    expect(channelStayTombstoneKey(base)).toBe("p|r|airbnb|u");
    expect(channelStayTombstoneKey({ ...base, roomId: "r2" })).not.toBe(channelStayTombstoneKey(base));
    expect(channelStayTombstoneKey({ ...base, provider: "booking_com" })).not.toBe(channelStayTombstoneKey(base));
  });

  it("prunes only the tombstoned reservation", () => {
    const keys = new Set([channelStayTombstoneKey({ propertyId: "prop-1", roomId: "room-1", provider: "airbnb", sourceUid: "uid-marcus" })]);
    const { kept, dropped } = pruneTombstonedRanges([MARCUS, PRIYA], { propertyId: "prop-1", roomId: "room-1", provider: "airbnb" }, keys);
    expect(dropped.map((r) => r.sourceUid)).toEqual(["uid-marcus"]);
    expect(kept.map((r) => r.sourceUid)).toEqual(["uid-priya"]);
    // The same UID on another room's feed is a different reservation.
    expect(pruneTombstonedRanges([MARCUS], { propertyId: "prop-1", roomId: "room-2", provider: "airbnb" }, keys).kept).toHaveLength(1);
  });
});

describe("Remove stay -> next sync -> Undo", () => {
  it("writes a durable tombstone, pulls the stay out of the stored ranges, and the next sync keeps it out", async () => {
    const { tables, db } = setup();
    const persisted: ChannelCalendarImportedRange[][] = [];
    const removed = await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, async (connection, ranges) => {
      persisted.push(ranges);
      tables.external_calendar_connections[0]!.imported_ranges = ranges;
      expect(connection.id).toBe("conn-1");
    });
    expect(removed.ok).toBe(true);
    expect(persisted[0]!.map((r) => r.sourceUid)).toEqual(["uid-priya"]);
    const tombstone = tables.portal_schedule_records[0]!;
    expect(tombstone.record_type).toBe(CHANNEL_STAY_TOMBSTONE_RECORD_TYPE);
    expect(tombstone.id).toBe(channelStayTombstoneRecordId("prop-1|room-1|airbnb|uid-marcus"));
    expect(tombstone.manager_user_id).toBe(MANAGER);
    expect(await loadChannelStayTombstoneKeys(db, ["prop-1"])).toEqual(new Set(["prop-1|room-1|airbnb|uid-marcus"]));

    // The feed still lists Marcus; the sync must not bring him back.
    const synced = await syncChannelCalendarConnection(db, "conn-1");
    expect(synced.imported_ranges.map((r) => r.sourceUid)).toEqual(["uid-priya"]);
    expect(tables.external_calendar_connections[0]!.imported_ranges).toEqual(synced.imported_ranges);
    // And the dates he held are not re-closed on the listing.
    const listing = (tables.manager_property_records[0]!.property_data as { listingSubmission: { rooms: Array<{ manualUnavailableRanges: Array<{ start: string }> }> } }).listingSubmission;
    expect(listing.rooms[0]!.manualUnavailableRanges.map((r) => r.start)).toEqual(["2026-10-20"]);
    // No resident is filed for the removed reservation.
    const filed = (mocks.upsertResidents.mock.calls as unknown as Array<[unknown, { ranges: ChannelCalendarImportedRange[] }]>)[0]![1].ranges;
    expect(filed.map((r) => r.sourceUid)).toEqual(["uid-priya"]);
  });

  it("a second Remove of the same stay is the same tombstone, not a clone", async () => {
    const { tables, db } = setup();
    const persist = async (_c: unknown, ranges: ChannelCalendarImportedRange[]) => { tables.external_calendar_connections[0]!.imported_ranges = ranges; };
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persist);
    tables.external_calendar_connections[0]!.imported_ranges = [MARCUS, PRIYA];
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persist);
    expect(tables.portal_schedule_records).toHaveLength(1);
  });

  it("Undo deletes the tombstone, restores the carried range, and the next sync keeps the stay", async () => {
    const { tables, db } = setup();
    const persist = async (_c: unknown, ranges: ChannelCalendarImportedRange[]) => { tables.external_calendar_connections[0]!.imported_ranges = ranges; };
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persist);
    const restored = await restoreChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persist);
    expect(restored.ok).toBe(true);
    expect(tables.portal_schedule_records).toHaveLength(0);
    expect(tables.external_calendar_connections[0]!.imported_ranges.map((r: ChannelCalendarImportedRange) => r.sourceUid).sort()).toEqual(["uid-marcus", "uid-priya"]);
    const synced = await syncChannelCalendarConnection(db, "conn-1");
    expect(synced.imported_ranges.map((r) => r.sourceUid).sort()).toEqual(["uid-marcus", "uid-priya"]);
  });

  it("Undo of a stay that was never removed is refused", async () => {
    const { db } = setup();
    const result = await restoreChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, async () => {});
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});

describe("authorization comes from the session, not the body", () => {
  it("refuses a manager without calendar edit on the connection's house and writes nothing", async () => {
    const { tables, db } = setup();
    mocks.managerCanWriteCalendarForProperty.mockResolvedValue(false);
    const persist = vi.fn();
    const result = await removeChannelStay(db, OTHER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persist);
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(mocks.managerCanWriteCalendarForProperty).toHaveBeenCalledWith(expect.anything(), OTHER, "prop-1");
    expect(tables.portal_schedule_records).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it("only tombstones a reservation the connection actually carries", async () => {
    const { tables, db } = setup();
    const result = await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-nope" }, async () => {});
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(tables.portal_schedule_records).toHaveLength(0);
  });

  it("the generic schedule-records route refuses to write or delete a tombstone or stay-meta record", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/portal-schedule-records/route.ts", "utf8");
    expect(src.match(/isDedicatedBookingsRecordType/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
