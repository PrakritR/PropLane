import { describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const tables = vi.hoisted(() => ({ data: {} as Record<string, Row[]> }));

function columnValue(row: Row, column: string): string {
  if (column.startsWith("row_data->application->>")) {
    const app = (row.row_data as Row | undefined)?.application as Row | undefined;
    return String(app?.[column.slice("row_data->application->>".length)] ?? "");
  }
  if (column.startsWith("row_data->>")) return String((row.row_data as Row | undefined)?.[column.slice(11)] ?? "");
  return row[column] === null || row[column] === undefined ? "" : String(row[column]);
}

/** The `col.eq.v` / `col.like.v*` clauses the export route's property narrowing generates. */
function orMatcher(expr: string): (row: Row) => boolean {
  const clauses: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const char of expr) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      clauses.push(buffer);
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer) clauses.push(buffer);
  const matchers = clauses.map((clause) => {
    const like = clause.match(/^(.*)\.like\.(.*)$/);
    if (like) {
      const [, column, pattern] = like;
      const prefix = pattern!.replace(/\*$/, "");
      return (row: Row) => columnValue(row, column!).startsWith(prefix);
    }
    const eq = clause.match(/^(.*)\.eq\.(.*)$/);
    if (eq) {
      const [, column, value] = eq;
      return (row: Row) => columnValue(row, column!) === value;
    }
    throw new Error(`calendar-export-feed: unhandled or() clause: ${clause}`);
  });
  return (row: Row) => matchers.some((m) => m(row));
}

function builder(rows: Row[]) {
  let current = rows;
  const api = {
    select: () => api,
    eq: (column: string, value: unknown) => {
      current = current.filter((row) => {
        if (column.startsWith("row_data->>")) return String((row.row_data as Row | undefined)?.[column.slice(11)] ?? "") === String(value);
        return row[column] === value;
      });
      return api;
    },
    in: (column: string, values: unknown[]) => {
      current = current.filter((row) => values.includes(row[column]));
      return api;
    },
    or: (expr: string) => {
      current = current.filter(orMatcher(expr));
      return api;
    },
    like: (column: string, pattern: string) => {
      const prefix = pattern.replace(/[%*]$/, "");
      current = current.filter((row) => columnValue(row, column).startsWith(prefix));
      return api;
    },
    order: () => api,
    range: (from: number, to: number) => {
      current = current.slice(from, to + 1);
      return api;
    },
    limit: () => api,
    maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) => resolve({ data: current, error: null }),
  };
  return api;
}

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => builder(tables.data[table] ?? []) }) }));
vi.mock("@/lib/channel-calendar/sync.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/channel-calendar/sync.server")>("@/lib/channel-calendar/sync.server").catch(() => ({}));
  return {
    ...actual,
    loadPropertyRecord: async () => ({ managerUserId: "m1", property: null, rowData: null }),
    loadConnectionByExportToken: async (_db: unknown, token: string) => {
      const row = (tables.data.external_calendar_connections ?? []).find((r) => r.export_token === token);
      if (!row) return null;
      const { parseConnectionRow } = await import("@/lib/channel-calendar/connections.server");
      return parseConnectionRow(row);
    },
  };
});

import { GET } from "@/app/api/calendar/export/[token]/route";
import { importedRangesForFeed } from "@/lib/channel-calendar/export-feed";

const conn = (id: string, provider: string, token: string, ranges: { start: string; end: string }[], roomId = "r1") => ({
  id, manager_user_id: "m1", property_id: "p1", room_id: roomId, provider, label: null, import_url: null, export_token: token,
  imported_ranges: ranges.map((r, i) => ({ id: `${id}-${i}`, sourceUid: `${id}-${i}`, summary: "Reserved", ...r })), last_synced_at: null, last_error: null,
});
const placement = (id: string, connectionId: string | null, start: string, end: string, extra: Row = {}) => ({
  id, manager_user_id: "m1", assigned_property_id: "p1", property_id: "p1", choice: "p1::r1", preferred: null, lease_start: start, lease_end: end,
  manual_start: null, manual_end: null, manually_added: connectionId ? "true" : "false", bucket: "approved", ical_connection: connectionId,
  row_data: { bucket: "approved" }, ...extra,
});

const AIRBNB = { start: "2027-01-10", end: "2027-01-12" };
const BOOKING = { start: "2027-02-01", end: "2027-02-03" };
const VRBO = { start: "2027-07-01", end: "2027-07-03" };
const LEASE = { start: "2027-03-01", end: "2027-03-31" };

function seed() {
  tables.data = {
    manager_property_records: [{ id: "p1", manager_user_id: "m1" }],
    external_calendar_connections: [
      conn("c-air", "airbnb", "tok-air", [AIRBNB]),
      conn("c-bdc", "booking_com", "tok-bdc", [BOOKING]),
      conn("c-vrbo", "vrbo", "tok-vrbo", [VRBO]),
    ],
    manager_application_records: [
      placement("lease", null, LEASE.start, LEASE.end),
      placement("air-stay", "c-air", AIRBNB.start, AIRBNB.end),
      placement("bdc-stay", "c-bdc", BOOKING.start, BOOKING.end),
      placement("vrbo-stay", "c-vrbo", VRBO.start, VRBO.end),
    ],
    portal_schedule_records: [
      { manager_user_id: "m1", property_id: "p1", record_type: "room_date_block", row_data: { roomId: "r1", bookingStatus: "cancelled", checkIn: "2027-04-10", checkOut: "2027-04-14" } },
      { manager_user_id: "m1", property_id: "p1", record_type: "room_date_block", row_data: { roomId: "r1", checkIn: "2027-06-01", checkOut: "2027-06-05" } },
    ],
  };
}

async function feed(token: string, query = "") {
  const res = await GET(new Request(`https://x.test/api/calendar/export/${token}.ics${query}`), { params: Promise.resolve({ token: `${token}.ics` }) });
  expect(res.status).toBe(200);
  return res.text();
}
const has = (ics: string, range: { start: string }) => ics.includes(range.start.replaceAll("-", ""));

describe("calendar export feed", () => {
  it("the Airbnb feed carries Booking.com bookings and leases, not Airbnb's own", async () => {
    seed();
    const ics = await feed("tok-air");
    expect(has(ics, BOOKING)).toBe(true);
    expect(has(ics, AIRBNB)).toBe(false);
    expect(has(ics, LEASE)).toBe(true);
    expect(ics.includes("20270601")).toBe(true);
  });

  it("with three channels each feed carries the other two and never its own", async () => {
    seed();
    const air = await feed("tok-air");
    expect([has(air, AIRBNB), has(air, BOOKING), has(air, VRBO)]).toEqual([false, true, true]);
    const bdc = await feed("tok-bdc");
    expect([has(bdc, AIRBNB), has(bdc, BOOKING), has(bdc, VRBO)]).toEqual([true, false, true]);
    const vrbo = await feed("tok-vrbo");
    expect([has(vrbo, AIRBNB), has(vrbo, BOOKING), has(vrbo, VRBO)]).toEqual([true, true, false]);
    expect(has(vrbo, LEASE)).toBe(true);
  });

  it("the Booking.com feed is the reverse", async () => {
    seed();
    const ics = await feed("tok-bdc");
    expect(has(ics, AIRBNB)).toBe(true);
    expect(has(ics, BOOKING)).toBe(false);
    expect(has(ics, LEASE)).toBe(true);
  });

  it("an 'other' link carries every channel, and a cancelled block is in none of them", async () => {
    seed();
    const other = await feed("tok-air", "?channels=all");
    expect(has(other, AIRBNB) && has(other, BOOKING) && has(other, VRBO) && has(other, LEASE)).toBe(true);
    for (const ics of [other, await feed("tok-air"), await feed("tok-bdc"), await feed("tok-vrbo")]) expect(ics.includes("20270410")).toBe(false);
  });

  it("a token shared by two connections (older links) carries every channel", async () => {
    seed();
    tables.data.external_calendar_connections![1]!.export_token = "tok-air";
    const ics = await feed("tok-air");
    expect(has(ics, AIRBNB) && has(ics, BOOKING)).toBe(true);
  });
});

describe("importedRangesForFeed", () => {
  const connections = [
    { id: "a", roomId: "r1", provider: "airbnb" as const, importedRanges: [{ id: "1", sourceUid: "1", summary: "", ...AIRBNB }] },
    { id: "b", roomId: "p1", provider: "booking_com" as const, importedRanges: [{ id: "2", sourceUid: "2", summary: "", ...BOOKING }] },
    { id: "c", roomId: "r2", provider: "booking_com" as const, importedRanges: [{ id: "3", sourceUid: "3", summary: "", start: "2027-05-01", end: "2027-05-02" }] },
  ];
  it("a whole-home booking blocks the room, and a room's feed ignores other rooms", () => {
    const out = importedRangesForFeed({ propertyId: "p1", roomId: "r1", destination: "airbnb", connections, placements: [] });
    expect(out).toEqual([BOOKING]);
  });
  it("a Vrbo destination takes Airbnb and Booking.com ranges but not Vrbo's own", () => {
    const withVrbo = [...connections, { id: "v", roomId: "r1", provider: "vrbo" as const, importedRanges: [{ id: "4", sourceUid: "4", summary: "", ...VRBO }] }];
    expect(importedRangesForFeed({ propertyId: "p1", roomId: "r1", destination: "vrbo", connections: withVrbo, placements: [] })).toEqual([AIRBNB, BOOKING]);
    expect(importedRangesForFeed({ propertyId: "p1", roomId: "r1", destination: "airbnb", connections: withVrbo, placements: [] })).toEqual([BOOKING, VRBO]);
  });
  it("a whole-home feed takes every room's other-channel bookings, deduplicated against placements", () => {
    const out = importedRangesForFeed({ propertyId: "p1", roomId: "p1", destination: "airbnb", connections, placements: [{ connectionId: "b", ...BOOKING }] });
    expect(out).toHaveLength(2);
  });
});
