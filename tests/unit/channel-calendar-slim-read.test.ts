import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));

const mocks = vi.hoisted(() => ({
  loadWorkspaces: vi.fn(async () => [] as unknown[]),
  access: vi.fn(),
  writable: vi.fn(),
  loadProperty: vi.fn(),
  inFlight: { access: 0, maxAccess: 0, record: 0, maxRecord: 0 },
}));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: mocks.access,
  managerCanWriteCalendarForProperties: mocks.writable,
}));
vi.mock("@/lib/channel-calendar/sync.server", () => ({ loadPropertyRecord: mocks.loadProperty }));

import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";

const HOUSES = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
const connection = (propertyId: string): Row => ({
  id: `c-${propertyId}`,
  manager_user_id: "mgr",
  property_id: propertyId,
  room_id: "r1",
  provider: "airbnb",
  label: null,
  import_url: "https://www.airbnb.com/calendar/ical/1.ics?s=x",
  export_token: `tok-${propertyId}`,
  imported_ranges: [{ id: "u", sourceUid: "u", summary: "Reserved", start: "2026-10-20", end: "2026-10-22" }],
  last_synced_at: null,
  last_error: null,
  export_last_fetched_at: null,
});

/** Records the peak number of calls running at once. */
function tracked<T>(counter: "access" | "record", value: T, ms = 15) {
  return async () => {
    const c = mocks.inFlight;
    c[counter] += 1;
    c[counter === "access" ? "maxAccess" : "maxRecord"] = Math.max(c[counter === "access" ? "maxAccess" : "maxRecord"], c[counter]);
    await new Promise((r) => setTimeout(r, ms));
    c[counter] -= 1;
    return value;
  };
}

beforeEach(() => {
  Object.assign(mocks.inFlight, { access: 0, maxAccess: 0, record: 0, maxRecord: 0 });
  mocks.access.mockReset().mockImplementation(tracked("access", true));
  mocks.writable.mockReset().mockImplementation(async (_db: unknown, _u: string, ids: readonly string[]) => new Set(ids));
  mocks.loadProperty.mockReset().mockImplementation(tracked("record", { managerUserId: "mgr", property: null, rowData: null }));
});

describe("Connect popup read (the 'That took too long' cause)", () => {
  it("checks access and loads each house's record in parallel, not one awaited call per house", async () => {
    const db = fakeSupabaseClient({ external_calendar_connections: HOUSES.map(connection) });
    const result = await listManagerChannelCalendarBookings(db as never, "mgr", HOUSES);
    expect(result).toHaveLength(HOUSES.length);
    expect(mocks.access).toHaveBeenCalledTimes(HOUSES.length);
    expect(mocks.loadProperty).toHaveBeenCalledTimes(HOUSES.length);
    expect(mocks.inFlight.maxAccess).toBe(HOUSES.length);
    expect(mocks.inFlight.maxRecord).toBe(HOUSES.length);
  });

  it("finishes in roughly two serial waits for 12 houses instead of 24", async () => {
    mocks.access.mockImplementation(tracked("access", true, 40));
    mocks.loadProperty.mockImplementation(tracked("record", { managerUserId: "mgr", property: null, rowData: null }, 40));
    const db = fakeSupabaseClient({ external_calendar_connections: HOUSES.map(connection) });
    const started = Date.now();
    await listManagerChannelCalendarBookings(db as never, "mgr", HOUSES, undefined, { slim: true });
    // Serial would be 12 x 40ms x 2 = 960ms; parallel is ~80ms. The margin is wide on purpose.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("a slim read keeps rooms, links and the saved import URL but never ships the stored stays", async () => {
    const db = fakeSupabaseClient({ external_calendar_connections: [connection("p1")] });
    const [property] = await listManagerChannelCalendarBookings(db as never, "mgr", ["p1"], undefined, { slim: true });
    const room = property!.rooms[0]!;
    expect(room.ranges).toEqual([]);
    expect(room).toMatchObject({ connectionId: "c-p1", roomId: "r1", provider: "airbnb", hasImportUrl: true, importUrl: "https://www.airbnb.com/calendar/ical/1.ics?s=x" });
    expect(room.exportUrl).toContain("/api/calendar/export/tok-p1.ics");
  });

  it("the full read (the Bookings calendar) still carries the ranges", async () => {
    const db = fakeSupabaseClient({ external_calendar_connections: [connection("p1")] });
    const [property] = await listManagerChannelCalendarBookings(db as never, "mgr", ["p1"]);
    expect(property!.rooms[0]!.ranges).toHaveLength(1);
  });

  it("a slim read still hides the import URL from a view-only teammate", async () => {
    mocks.writable.mockResolvedValue(new Set<string>());
    const db = fakeSupabaseClient({ external_calendar_connections: [connection("p1")] });
    const [property] = await listManagerChannelCalendarBookings(db as never, "mgr", ["p1"], undefined, { slim: true });
    expect(property!.rooms[0]).toMatchObject({ hasImportUrl: true, importUrl: null });
  });
});
