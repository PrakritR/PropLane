import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));

const MINE = "mgr-1";
const OTHER = "mgr-2";

const state = vi.hoisted(() => ({ userId: "mgr-1" as string | null, db: null as unknown }));
// Calendar access: each manager reaches only the house they own.
const owners = vi.hoisted(() => new Map<string, string>([["prop-mine", "mgr-1"], ["prop-theirs", "mgr-2"]]));
const mocks = vi.hoisted(() => ({
  canWrite: vi.fn(async (_db: unknown, userId: string, propertyId: string) => owners.get(propertyId) === userId),
  canRead: vi.fn(async (_db: unknown, userId: string, propertyId: string) => owners.get(propertyId) === userId),
  canWriteMany: vi.fn(async (_db: unknown, userId: string, ids: readonly string[]) => new Set(ids.filter((id) => owners.get(id) === userId))),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanWriteCalendarForProperty: mocks.canWrite,
  managerHasCalendarAccessForProperty: mocks.canRead,
  managerCanWriteCalendarForProperties: mocks.canWriteMany,
}));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: async () => null }));
vi.mock("@/lib/channel-calendar/require-manager.server", () => ({
  requireBookingsManager: async () => (state.userId ? { db: state.db, userId: state.userId } : null),
}));

import { GET, PUT } from "@/app/api/portal/channel-calendar/stay-details/route";
import { loadChannelStayGuestNames } from "@/lib/channel-calendar/stay-details.server";
import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";
import { airbnbBookingEntries } from "@/lib/channel-calendar/property-bookings";

const RANGE = { id: "uid-1", sourceUid: "uid-1", summary: "Reserved", start: "2026-10-10", end: "2026-10-12", reservationCode: "HMABCDEFGH", phoneLast4: "1234" };
const BLOCK = { id: "uid-2", sourceUid: "uid-2", summary: "Airbnb (Not available)", start: "2026-10-20", end: "2026-10-21", hostBlock: true };

function connection(id: string, propertyId: string, managerId: string, ranges: unknown[]): Row {
  return {
    id, manager_user_id: managerId, property_id: propertyId, room_id: "room-1", provider: "airbnb", label: "Room 1",
    import_url: "https://www.airbnb.com/calendar/ical/1.ics?s=x", export_token: `tok-${id}`, imported_ranges: ranges,
    last_synced_at: null, last_error: null, export_last_fetched_at: null,
  };
}

let tables: Record<string, Row[]>;

beforeEach(() => {
  tables = {
    external_calendar_connections: [
      connection("conn-mine", "prop-mine", MINE, [RANGE, BLOCK]),
      connection("conn-theirs", "prop-theirs", OTHER, [RANGE]),
    ],
    channel_stay_details: [],
    manager_property_records: [],
  };
  state.db = fakeSupabaseClient(tables);
  state.userId = MINE;
  mocks.canWrite.mockClear();
  mocks.canRead.mockClear();
});

const put = (body: unknown) =>
  PUT(new Request("http://localhost/api/portal/channel-calendar/stay-details", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

describe("stay-details route", () => {
  it("is refused without a manager session", async () => {
    state.userId = null;
    expect((await put({ connectionId: "conn-mine", sourceUid: "uid-1", guestName: "Maria" })).status).toBe(401);
    expect((await GET(new Request("http://localhost/x?connectionId=conn-mine&sourceUid=uid-1"))).status).toBe(401);
    expect(tables.channel_stay_details).toHaveLength(0);
  });

  it("saves and reads a name on the manager's own connection", async () => {
    const res = await put({ connectionId: "conn-mine", sourceUid: "uid-1", guestName: "  Maria   Lopez ", notes: "Late arrival" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ guestName: "Maria Lopez", notes: "Late arrival" });
    expect(tables.channel_stay_details[0]).toMatchObject({ connection_id: "conn-mine", source_uid: "uid-1", guest_name: "Maria Lopez", updated_by: MINE });
    const got = await GET(new Request("http://localhost/x?connectionId=conn-mine&sourceUid=uid-1"));
    expect(await got.json()).toEqual({ guestName: "Maria Lopez", notes: "Late arrival" });
    // Saving again updates the same row; an empty name and note clear it.
    await put({ connectionId: "conn-mine", sourceUid: "uid-1", guestName: "Maria L." });
    expect(tables.channel_stay_details).toHaveLength(1);
    await put({ connectionId: "conn-mine", sourceUid: "uid-1", guestName: "" });
    expect(tables.channel_stay_details).toHaveLength(0);
  });

  it("refuses another manager's connection and writes nothing", async () => {
    const res = await put({ connectionId: "conn-theirs", sourceUid: "uid-1", guestName: "Intruder" });
    expect(res.status).toBe(403);
    expect(tables.channel_stay_details).toHaveLength(0);
    expect((await GET(new Request("http://localhost/x?connectionId=conn-theirs&sourceUid=uid-1"))).status).toBe(403);
  });

  it("re-derives the house from the connection and ignores a propertyId in the body", async () => {
    const res = await put({ connectionId: "conn-theirs", propertyId: "prop-mine", sourceUid: "uid-1", guestName: "Intruder" });
    expect(res.status).toBe(403);
    expect(mocks.canWrite).toHaveBeenCalledWith(expect.anything(), MINE, "prop-theirs");
    expect(mocks.canWrite).not.toHaveBeenCalledWith(expect.anything(), MINE, "prop-mine");
    expect(tables.channel_stay_details).toHaveLength(0);
  });

  it("404s a stay the connection does not carry, and a missing connection", async () => {
    expect((await put({ connectionId: "conn-mine", sourceUid: "ghost", guestName: "X" })).status).toBe(404);
    expect((await put({ connectionId: "nope", sourceUid: "uid-1", guestName: "X" })).status).toBe(404);
    expect((await put({ connectionId: "", sourceUid: "uid-1", guestName: "X" })).status).toBe(400);
  });

  it("caps the name at 120 characters and strips control characters", async () => {
    const res = await put({ connectionId: "conn-mine", sourceUid: "uid-1", guestName: `A\u0000${"b".repeat(300)}` });
    const saved = (await res.json()) as { guestName: string };
    expect(saved.guestName.length).toBe(120);
    expect(saved.guestName).not.toContain("\u0000");
  });
});

describe("bookings merge", () => {
  it("merges typed names in with one query across every connection, plus code, rebuilt URL and phone", async () => {
    tables.channel_stay_details.push({ connection_id: "conn-mine", source_uid: "uid-1", guest_name: "Maria Lopez" });
    const from = vi.spyOn(state.db as { from: (t: string) => unknown }, "from");
    const properties = await listManagerChannelCalendarBookings(state.db as never, MINE, ["prop-mine"]);
    expect(from.mock.calls.filter(([table]) => table === "channel_stay_details")).toHaveLength(1);
    const [reserved, block] = properties[0]!.rooms[0]!.ranges;
    expect(reserved).toMatchObject({
      guestName: "Maria Lopez",
      reservationCode: "HMABCDEFGH",
      reservationUrl: "https://www.airbnb.com/hosting/reservations/details/HMABCDEFGH",
      phoneLast4: "1234",
    });
    expect(block).toMatchObject({ hostBlock: true });
    expect(block).not.toHaveProperty("guestName");
    expect(block).not.toHaveProperty("reservationUrl");
    const entries = airbnbBookingEntries(properties);
    expect(entries[0]).toMatchObject({ guestName: "Maria Lopez", reservationCode: "HMABCDEFGH", phoneLast4: "1234" });
  });

  it("never rebuilds a URL from anything but a valid code, and does not leak another connection's names", async () => {
    tables.external_calendar_connections[0]!.imported_ranges = [{ ...RANGE, reservationCode: "https://evil.test/x" }];
    tables.channel_stay_details.push({ connection_id: "conn-theirs", source_uid: "uid-1", guest_name: "Theirs" });
    const properties = await listManagerChannelCalendarBookings(state.db as never, MINE, ["prop-mine"]);
    const [range] = properties[0]!.rooms[0]!.ranges;
    expect(range).not.toHaveProperty("reservationUrl");
    expect(range).not.toHaveProperty("guestName");
  });

  it("loadChannelStayGuestNames groups by connection and skips blanks", async () => {
    tables.channel_stay_details.push(
      { connection_id: "a", source_uid: "u1", guest_name: "One" },
      { connection_id: "a", source_uid: "u2", guest_name: "  " },
      { connection_id: "b", source_uid: "u1", guest_name: "Two" },
    );
    const names = await loadChannelStayGuestNames(state.db as never, ["a", "b", "a"]);
    expect([...names.get("a")!.entries()]).toEqual([["u1", "One"]]);
    expect(names.get("b")!.get("u1")).toBe("Two");
    expect((await loadChannelStayGuestNames(state.db as never, [])).size).toBe(0);
  });
});
