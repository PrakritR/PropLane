import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * A removed channel stay is restorable. A manager's own Sync now / Sync all now (`force`) brings back a
 * removed RESERVATION the channel still lists; the cron never does. A host's own "Not available" block stays
 * removed until it is restored from the Removed stays list. A feed that fails or parses empty clears nothing,
 * and a tombstone whose stay left the feed and ended is cleaned up so the table does not grow.
 */

const mocks = vi.hoisted(() => ({
  managerCanWriteCalendarForProperty: vi.fn(async () => true),
  managerCanWriteCalendarForProperties: vi.fn(async (_db: unknown, _user: string, ids: readonly string[]) => new Set(ids)),
  requireBookingsManager: vi.fn(),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanWriteCalendarForProperty: mocks.managerCanWriteCalendarForProperty,
  managerCanWriteCalendarForProperties: mocks.managerCanWriteCalendarForProperties,
}));
vi.mock("@/lib/channel-calendar/airbnb-residents.server", () => ({
  upsertAirbnbResidentsFromImportedRanges: vi.fn(async () => ({ created: 0, updated: 0, skipped: 0 })),
  releaseAirbnbResidentsAbsentFromFeed: async () => undefined,
}));
vi.mock("@/lib/channel-calendar/require-manager.server", () => ({ requireBookingsManager: mocks.requireBookingsManager }));
vi.mock("@/lib/channel-calendar/bookings.server", () => ({ listRemovedChannelStaysWithLabels: vi.fn(async () => []) }));

import { channelImportRangeId, parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { channelStayName } from "@/lib/channel-calendar/booking-guest-label";
import {
  listRemovedChannelStays,
  loadChannelStayTombstoneKeys,
  removeChannelStay,
  resolveTombstoneRestoreInput,
  restoreChannelStay,
} from "@/lib/channel-calendar/stay-tombstones.server";
import {
  icalEventsToImportedRanges,
  syncAllChannelCalendarImports,
  syncChannelCalendarConnection,
  syncChannelCalendarConnectionIds,
} from "@/lib/channel-calendar/sync.server";
import { parseIcsCalendar } from "@/lib/ical/parse";
import { CHANNEL_STAY_TOMBSTONE_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";

const MANAGER = "mgr-1";
const OTHER = "mgr-2";
const IMPORT_URL = "https://www.airbnb.com/calendar/ical/123.ics?s=abc";
// Past-dated on purpose: a tombstone for a stay that ended is what the orphan cleanup may drop.
const MARCUS: ChannelCalendarImportedRange = { id: "marcus", sourceUid: "uid-marcus", summary: "Marcus", start: "2026-10-10", end: "2026-10-14" };
const PRIYA: ChannelCalendarImportedRange = { id: "priya", sourceUid: "uid-priya", summary: "Priya", start: "2026-10-20", end: "2026-10-22" };
const FUTURE: ChannelCalendarImportedRange = { id: "future", sourceUid: "uid-future", summary: "Later", start: "2099-01-10", end: "2099-01-14" };
const BLOCK: ChannelCalendarImportedRange = { id: "blk", sourceUid: "shared@airbnb.com", summary: "Airbnb (Not available)", hostBlock: true, start: "2026-10-11", end: "2026-10-11" };

type Ev = { uid: string; summary: string; start: string; end: string; description?: string };
function ics(events: Ev[]): string {
  const body = events
    .map((e) => `BEGIN:VEVENT\nUID:${e.uid}\nSUMMARY:${e.summary}\nDTSTART;VALUE=DATE:${e.start}\nDTEND;VALUE=DATE:${e.end}${e.description ? `\nDESCRIPTION:${e.description}` : ""}\nEND:VEVENT`)
    .join("\n");
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`;
}
// iCal DTEND is exclusive; the parser converts to the inclusive last night.
const MARCUS_EV: Ev = { uid: "uid-marcus", summary: "Marcus", start: "20261010", end: "20261015" };
const PRIYA_EV: Ev = { uid: "uid-priya", summary: "Priya", start: "20261020", end: "20261023" };
const BLOCK_EV: Ev = { uid: "shared@airbnb.com", summary: "Airbnb (Not available)", start: "20261011", end: "20261012" };
const feedOf = (...events: Ev[]) => ics(events);

function feedIs(text: string, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(text, { status })));
}

function setup(ranges: ChannelCalendarImportedRange[] = [MARCUS, PRIYA]) {
  const tables: Record<string, Row[]> = {
    external_calendar_connections: [
      { id: "conn-1", manager_user_id: MANAGER, property_id: "prop-1", room_id: "room-1", provider: "airbnb", label: "Room 1", import_url: IMPORT_URL, export_token: "tok", imported_ranges: ranges, last_synced_at: null, last_error: null },
    ],
    manager_property_records: [
      { id: "prop-1", manager_user_id: MANAGER, property_data: { id: "prop-1", title: "House", listingSubmission: { v: 1, rooms: [{ id: "room-1", name: "Room 1", manualUnavailableRanges: [] }] } }, row_data: {} },
    ],
    portal_schedule_records: [],
  };
  return { tables, db: fakeSupabaseClient(tables) as never };
}

const persistTo = (tables: Record<string, Row[]>) => async (_c: unknown, ranges: ChannelCalendarImportedRange[]) => {
  tables.external_calendar_connections[0]!.imported_ranges = ranges;
};
const uidsOf = (tables: Record<string, Row[]>) =>
  (tables.external_calendar_connections[0]!.imported_ranges as ChannelCalendarImportedRange[]).map((r) => r.sourceUid).sort();
const listingRanges = (tables: Record<string, Row[]>) =>
  (tables.manager_property_records[0]!.property_data as { listingSubmission: { rooms: Array<{ manualUnavailableRanges: Array<{ id: string }> }> } }).listingSubmission.rooms[0]!.manualUnavailableRanges;

beforeEach(() => {
  mocks.managerCanWriteCalendarForProperty.mockReset().mockResolvedValue(true);
  mocks.managerCanWriteCalendarForProperties.mockReset().mockImplementation(async (_db, _user, ids) => new Set(ids));
  mocks.requireBookingsManager.mockReset();
  feedIs(feedOf(MARCUS_EV, PRIYA_EV));
});
afterEach(() => vi.unstubAllGlobals());

describe("(a) a forced sync brings back a removed reservation the channel still lists", () => {
  it("restores the range, clears the tombstone, and leaves exactly one range for that UID", async () => {
    const { tables, db } = setup();
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persistTo(tables));
    expect(uidsOf(tables)).toEqual(["uid-priya"]);
    expect(tables.portal_schedule_records).toHaveLength(1);

    const synced = await syncChannelCalendarConnection(db, "conn-1", { force: true });
    expect(synced.imported_ranges.map((r) => r.sourceUid).sort()).toEqual(["uid-marcus", "uid-priya"]);
    expect(tables.portal_schedule_records).toHaveLength(0);
    expect(await loadChannelStayTombstoneKeys(db, ["prop-1"])).toEqual(new Set());

    // Idempotent: a second forced sync overwrites the connection's ranges, so no UID is ever doubled, and the
    // listing's block id is the stable one for (connection, uid).
    await syncChannelCalendarConnection(db, "conn-1", { force: true });
    expect(uidsOf(tables)).toEqual(["uid-marcus", "uid-priya"]);
    const blocks = listingRanges(tables).filter((r) => r.id === channelImportRangeId("conn-1", "uid-marcus"));
    expect(blocks).toHaveLength(1);
    expect(listingRanges(tables)).toHaveLength(2);
  });
});

describe("(b) the channel dropped the event: it stays removed", () => {
  it("a forced sync without the event stores nothing for it and cleans a tombstone whose stay ended", async () => {
    const { tables, db } = setup();
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persistTo(tables));
    feedIs(feedOf(PRIYA_EV));
    const synced = await syncChannelCalendarConnection(db, "conn-1", { force: true });
    expect(synced.imported_ranges.map((r) => r.sourceUid)).toEqual(["uid-priya"]);
    expect(tables.portal_schedule_records).toHaveLength(0);
  });

  it("the cron cleans the same ended orphan, and keeps a tombstone for a stay that has not ended", async () => {
    const { tables, db } = setup([MARCUS, PRIYA, FUTURE]);
    const persist = persistTo(tables);
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persist);
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-future" }, persist);
    expect(tables.portal_schedule_records).toHaveLength(2);
    feedIs(feedOf(PRIYA_EV));
    await syncChannelCalendarConnection(db, "conn-1");
    expect(await loadChannelStayTombstoneKeys(db, ["prop-1"])).toEqual(new Set(["prop-1|room-1|airbnb|uid-future"]));
  });
});

describe("(c) a host block stays removed through a forced sync and restores from the list", () => {
  it("survives a forced sync, then Restore (by dates) puts it back and deletes the tombstone", async () => {
    const { tables, db } = setup([MARCUS, BLOCK]);
    feedIs(feedOf(MARCUS_EV, BLOCK_EV));
    const persist = persistTo(tables);
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: BLOCK.sourceUid, start: BLOCK.start, end: BLOCK.end }, persist);
    expect(uidsOf(tables)).toEqual(["uid-marcus"]);

    const synced = await syncChannelCalendarConnection(db, "conn-1", { force: true });
    expect(synced.imported_ranges.map((r) => r.sourceUid)).toEqual(["uid-marcus"]);
    expect(tables.portal_schedule_records).toHaveLength(1);

    const restored = await restoreChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: BLOCK.sourceUid, start: BLOCK.start, end: BLOCK.end }, persist);
    expect(restored.ok).toBe(true);
    expect(tables.portal_schedule_records).toHaveLength(0);
    expect(uidsOf(tables)).toEqual(["shared@airbnb.com", "uid-marcus"]);
    const after = await syncChannelCalendarConnection(db, "conn-1");
    expect(after.imported_ranges.map((r) => r.sourceUid).sort()).toEqual(["shared@airbnb.com", "uid-marcus"]);
  });

  it("Restore from the list resolves a tombstone id to the connection, UID and dates", async () => {
    const { tables, db } = setup([BLOCK]);
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: BLOCK.sourceUid, start: BLOCK.start, end: BLOCK.end }, persistTo(tables));
    const id = String(tables.portal_schedule_records[0]!.id);
    expect(await resolveTombstoneRestoreInput(db, id)).toEqual({ connectionId: "conn-1", sourceUid: "shared@airbnb.com", start: "2026-10-11", end: "2026-10-11" });
    expect(await resolveTombstoneRestoreInput(db, "nope")).toBeNull();
  });
});

describe("(d) the cron never forces", () => {
  it("a plain sync keeps honoring the tombstone while the event is still in the feed", async () => {
    const { tables, db } = setup();
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persistTo(tables));
    const synced = await syncChannelCalendarConnection(db, "conn-1");
    expect(synced.imported_ranges.map((r) => r.sourceUid)).toEqual(["uid-priya"]);
    expect(tables.portal_schedule_records).toHaveLength(1);
  });

  it("the pool forces only when asked: the cron's sync-all passes force false, a manual Sync all passes true", async () => {
    const calls: Array<{ id: string; force?: boolean }> = [];
    const syncOne = async (_db: unknown, id: string, options?: { force?: boolean }) => { calls.push({ id, force: options?.force }); };
    await syncChannelCalendarConnectionIds({} as never, ["a"], { syncOne });
    await syncChannelCalendarConnectionIds({} as never, ["b"], { syncOne, force: true });
    expect(calls).toEqual([{ id: "a", force: false }, { id: "b", force: true }]);
    const { db } = setup();
    const seen: Array<boolean | undefined> = [];
    await syncAllChannelCalendarImports(db, { syncOne: async (_d, _id, options) => void seen.push(options?.force) });
    expect(seen).toEqual([false]);
  });
});

describe("(e) a failed or empty feed clears no tombstone", () => {
  it("a feed that fails to load throws and leaves every tombstone", async () => {
    const { tables, db } = setup();
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persistTo(tables));
    feedIs("", 500);
    await expect(syncChannelCalendarConnection(db, "conn-1", { force: true })).rejects.toThrow();
    expect(tables.portal_schedule_records).toHaveLength(1);
  });

  it("a feed that parses empty clears nothing, even forced and even for an ended orphan", async () => {
    const { tables, db } = setup();
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persistTo(tables));
    feedIs(feedOf());
    await syncChannelCalendarConnection(db, "conn-1", { force: true });
    expect(tables.portal_schedule_records).toHaveLength(1);
  });
});

describe("(f) restore needs Calendar edit on that house", () => {
  it("restoreChannelStay refuses a caller without it and keeps the tombstone", async () => {
    const { tables, db } = setup();
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persistTo(tables));
    mocks.managerCanWriteCalendarForProperty.mockResolvedValue(false);
    const result = await restoreChannelStay(db, OTHER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, async () => {});
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(mocks.managerCanWriteCalendarForProperty).toHaveBeenCalledWith(expect.anything(), OTHER, "prop-1");
    expect(tables.portal_schedule_records).toHaveLength(1);
  });

  it("the route refuses a restore by tombstone id for a caller without it (403) and changes nothing", async () => {
    const { tables, db } = setup();
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persistTo(tables));
    const id = String(tables.portal_schedule_records[0]!.id);
    mocks.requireBookingsManager.mockResolvedValue({ db, userId: OTHER });
    mocks.managerCanWriteCalendarForProperty.mockResolvedValue(false);
    const { POST } = await import("@/app/api/portal/channel-calendar/stay-tombstones/route");
    const res = await POST(new Request("http://x/api/portal/channel-calendar/stay-tombstones", { method: "POST", body: JSON.stringify({ action: "restore", tombstoneId: id }) }));
    expect(res.status).toBe(403);
    expect(tables.portal_schedule_records).toHaveLength(1);
    expect(uidsOf(tables)).toEqual(["uid-priya"]);
  });

  it("the route restores by tombstone id for an editor and re-syncs so the stay reappears", async () => {
    const { tables, db } = setup();
    await removeChannelStay(db, MANAGER, { connectionId: "conn-1", sourceUid: "uid-marcus" }, persistTo(tables));
    const id = String(tables.portal_schedule_records[0]!.id);
    mocks.requireBookingsManager.mockResolvedValue({ db, userId: MANAGER });
    const { POST } = await import("@/app/api/portal/channel-calendar/stay-tombstones/route");
    const res = await POST(new Request("http://x/api/portal/channel-calendar/stay-tombstones", { method: "POST", body: JSON.stringify({ action: "restore", tombstoneId: id }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, synced: true });
    expect(tables.portal_schedule_records).toHaveLength(0);
    expect(uidsOf(tables)).toEqual(["uid-marcus", "uid-priya"]);
  });

  it("the list holds only the houses the caller may edit the calendar of", async () => {
    const mk = (id: string, propertyId: string): Row => ({
      id, property_id: propertyId, record_type: CHANNEL_STAY_TOMBSTONE_RECORD_TYPE,
      row_data: { propertyId, roomId: "room-1", provider: "airbnb", sourceUid: id, range: { id, sourceUid: id, start: "2026-10-11", end: "2026-10-12", summary: "x" }, removedAt: "2026-10-30T00:00:00Z", removedBy: MANAGER },
    });
    const tables: Record<string, Row[]> = { portal_schedule_records: [mk("t1", "prop-1"), mk("t2", "prop-2")] };
    const db = fakeSupabaseClient(tables) as never;
    mocks.managerCanWriteCalendarForProperties.mockImplementation(async () => new Set(["prop-1"]));
    const listed = await listRemovedChannelStays(db, OTHER, ["prop-1", "prop-2"]);
    expect(listed.map((t) => t.id)).toEqual(["t1"]);
    expect(listed[0]).toMatchObject({ propertyId: "prop-1", sourceUid: "t1", removedBy: MANAGER, range: { start: "2026-10-11" } });
  });
});

describe("channel identity and the feed description", () => {
  it("a Booking.com privacy-stripped stay reads as a channel booking, never as a closure", () => {
    expect(channelStayName({ source: "booking_com", summary: "CLOSED - Not available" })).toBe("Booking.com guest");
    expect(channelStayName({ source: "vrbo", summary: "CLOSED - Not available" })).toBe("Vrbo guest");
    expect(channelStayName({ source: "booking_com", summary: "Airbnb (Not available)" })).toBe("Closed on Booking.com");
  });

  it("stores the DESCRIPTION trimmed to 500 chars on a reservation, never on a host block, and it survives a read", () => {
    const long = "x".repeat(900);
    const ranges = icalEventsToImportedRanges(
      parseIcsCalendar(ics([{ ...MARCUS_EV, description: `  ${long}  ` }, { ...BLOCK_EV, description: "Block note" }])),
    );
    const marcus = ranges.find((r) => r.sourceUid === "uid-marcus")!;
    expect(marcus.description).toHaveLength(500);
    expect(ranges.find((r) => r.sourceUid === "shared@airbnb.com")!.description).toBeUndefined();
    const row = parseConnectionRow({ id: "c", manager_user_id: "m", property_id: "p", room_id: "r", provider: "booking_com", export_token: "t", imported_ranges: [marcus] });
    expect(row.imported_ranges[0]!.description).toHaveLength(500);
  });
});
