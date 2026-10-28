import { beforeEach, describe, expect, it, vi } from "vitest";

type StoredRecord = {
  id: string;
  manager_user_id: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  row_data: Record<string, unknown>;
};

const state = vi.hoisted(() => ({ records: [] as unknown[], blocks: [] as unknown[], siblingError: false, connectionUpdates: [] as unknown[] }));

function pathValue(record: Record<string, unknown>, column: string): unknown {
  if (!column.startsWith("row_data")) return record[column];
  const [, ...path] = column.split(/->>|->/);
  let cursor: unknown = record.row_data;
  for (const key of path) cursor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined;
  return cursor == null ? null : String(cursor);
}

// A filter-honouring stand-in for PostgREST: eq / like are applied to the real stored row shape,
// so a row the query would not match never reaches the route.
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const chain = {
        select: () => chain,
        update: (payload: unknown) => (state.connectionUpdates.push({ table, payload }), chain),
        in: () => chain,
        eq: (column: string, value: unknown) => (filters.push((row) => pathValue(row, column) === value), chain),
        like: (column: string, pattern: string) => {
          const prefix = pattern.replace(/%$/, "");
          filters.push((row) => String(pathValue(row, column) ?? "").startsWith(prefix));
          return chain;
        },
        order: () => chain,
        range: () => chain,
        then: (resolve: (value: unknown) => void) => {
          if (table === "manager_application_records") {
            const rows = (state.records as Record<string, unknown>[]).filter((row) => filters.every((f) => f(row)));
            resolve({
              error: null,
              data: rows.map((row) => ({
                id: row.id,
                manager_user_id: row.manager_user_id,
                assigned_property_id: row.assigned_property_id,
                property_id: row.property_id,
                choice: pathValue(row, "row_data->>assignedRoomChoice"),
                preferred: pathValue(row, "row_data->application->>roomChoice1"),
                lease_start: pathValue(row, "row_data->application->>leaseStart"),
                lease_end: pathValue(row, "row_data->application->>leaseEnd"),
                manual_start: pathValue(row, "row_data->manualResidentDetails->>moveInDate"),
                manual_end: pathValue(row, "row_data->manualResidentDetails->>moveOutDate"),
                manually_added: pathValue(row, "row_data->>manuallyAdded"),
                bucket: pathValue(row, "row_data->>bucket"),
                ical_connection: pathValue(row, "row_data->>icalConnectionId"),
              })),
            });
          } else if (table === "external_calendar_connections" && state.siblingError) {
            resolve({ error: { message: "connection read failed" }, data: null });
          } else if (table === "manager_property_records") {
            resolve({ error: null, data: [{ id: "prop-1", manager_user_id: "owner-user" }] });
          } else if (table === "account_link_invites") {
            resolve({
              error: null,
              data: [{ inviter_user_id: "owner-user", invitee_user_id: "acting-co-manager", assigned_property_ids: ["prop-1"], team_role: "leasing" }],
            });
          } else if (table === "portal_schedule_records") {
            resolve({ error: null, data: (state.blocks as Record<string, unknown>[]).filter((row) => filters.every((f) => f(row))) });
          } else {
            resolve({ error: null, data: [] });
          }
        },
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/channel-calendar/sync.server", () => ({
  loadConnectionByExportToken: async () => ({
    id: "conn-1",
    property_id: "prop-1",
    room_id: "room-1789775850636-3",
    provider: "airbnb",
    manager_user_id: "owner-user",
  }),
  loadPropertyRecord: async () => ({ property: null }),
}));

import { GET } from "@/app/api/calendar/export/[token]/route";

const request = () =>
  GET(new Request("https://example.com/api/calendar/export/token.ics"), { params: Promise.resolve({ token: "token.ics" }) });

/** The row shape production returned for a resident added through Residents > Add resident. */
function manualResident(id: string, roomId: string, managerUserId: string | null, moveIn: string, moveOut: string): StoredRecord {
  return {
    id,
    manager_user_id: managerUserId,
    property_id: "prop-1",
    assigned_property_id: "prop-1",
    row_data: {
      bucket: "approved",
      stage: "Active",
      manuallyAdded: true,
      managerUserId,
      propertyId: "prop-1",
      assignedPropertyId: "prop-1",
      assignedRoomChoice: `prop-1::${roomId}`,
      application: { roomChoice1: `prop-1::${roomId}`, leaseStart: moveIn, leaseEnd: moveOut },
      manualResidentDetails: { moveInDate: moveIn, moveOutDate: moveOut },
    },
  };
}

beforeEach(() => {
  state.records = [];
  state.blocks = [];
  state.siblingError = false;
  state.connectionUpdates = [];
});

describe("export feed holds for manually added residents", () => {
  it("blocks the room for a resident the property owner added themselves", async () => {
    state.records = [manualResident("app-1", "room-1789775850636-3", "owner-user", "2026-10-09", "2027-10-08")];
    const body = await (await request()).text();
    expect(body).toContain("DTSTART;VALUE=DATE:20261009");
  });

  it("blocks the room for a resident a co-managed workspace teammate added (row stamped with the acting user)", async () => {
    state.records = [manualResident("app-2", "room-1789775850636-3", "acting-co-manager", "2026-10-09", "2027-10-08")];
    const body = await (await request()).text();
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("DTSTART;VALUE=DATE:20261009");
  });

  it("blocks the room for a resident whose manager_user_id column is empty", async () => {
    state.records = [manualResident("app-3", "room-1789775850636-3", null, "2026-10-09", "2027-10-08")];
    expect(await (await request()).text()).toContain("DTSTART;VALUE=DATE:20261009");
  });

  it("matches only the room it is for, including ids with and without a numeric suffix", async () => {
    state.records = [
      manualResident("app-4", "room-1789775996828", "acting-co-manager", "2026-11-01", "2026-12-01"),
      manualResident("app-5", "room-1789775850636-3", "acting-co-manager", "2026-10-09", "2027-10-08"),
    ];
    const body = await (await request()).text();
    expect(body).toContain("DTSTART;VALUE=DATE:20261009");
    expect(body).not.toContain("20261101");
  });

  it("ignores an approved row a stranger filed naming this room (cross-tenant plant)", async () => {
    state.records = [manualResident("app-plant", "room-1789775850636-3", "stranger-manager", "2026-10-09", "2027-10-08")];
    expect(await (await request()).text()).not.toContain("BEGIN:VEVENT");
  });

  it("ignores residents of another property and non-approved rows", async () => {
    const otherProperty = manualResident("app-6", "room-1789775850636-3", "owner-user", "2027-01-01", "2027-02-01");
    otherProperty.property_id = "prop-2";
    otherProperty.assigned_property_id = "prop-2";
    otherProperty.row_data.assignedRoomChoice = "prop-2::room-1789775850636-3";
    (otherProperty.row_data.application as Record<string, unknown>).roomChoice1 = "prop-2::room-1789775850636-3";
    const pending = manualResident("app-7", "room-1789775850636-3", "owner-user", "2027-03-01", "2027-04-01");
    pending.row_data.bucket = "pending";
    state.records = [otherProperty, pending];
    expect(await (await request()).text()).not.toContain("BEGIN:VEVENT");
  });
});

/** A `room_date_block` row as the schedule-records store keeps it. */
function roomBlock(id: string, roomId: string, checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) {
  return { id, property_id: "prop-1", record_type: "room_date_block", row_data: { roomId, checkIn, checkOut, bookingStatus: "confirmed", ...extra } };
}

describe("export feed honesty (plan channels-sync-1027, BUG 2)", () => {
  it("an approved application that names no room blocks no room, instead of every room of the house", async () => {
    const noRoom = manualResident("app-no-room", "x", "owner-user", "2026-10-09", "2027-10-08");
    noRoom.row_data.assignedRoomChoice = "";
    (noRoom.row_data.application as Record<string, unknown>).roomChoice1 = "";
    state.records = [noRoom];
    expect(await (await request()).text()).not.toContain("BEGIN:VEVENT");
  });

  it("still blocks the room the application names (a room choice with a room is unchanged)", async () => {
    state.records = [manualResident("app-room", "room-1789775850636-3", "owner-user", "2026-10-09", "2026-10-12")];
    expect(await (await request()).text()).toContain("DTSTART;VALUE=DATE:20261009");
  });

  it("does not send a stay Airbnb brought in (the Airbnb import marker) back to Airbnb", async () => {
    state.blocks = [roomBlock("blk-airbnb", "room-1789775850636-3", "2026-11-01", "2026-11-04", { reason: "Airbnb" })];
    expect(await (await request()).text()).not.toContain("BEGIN:VEVENT");
  });

  it("does not echo a PropLane stay linked to its Airbnb reservation either", async () => {
    state.blocks = [
      roomBlock("blk-linked", "room-1789775850636-3", "2026-11-01", "2026-11-04", {
        residentName: "Guest",
        stayDetails: { channelLink: { provider: "airbnb", reservationCode: "HMABCDEFGH" } },
      }),
    ];
    expect(await (await request()).text()).not.toContain("BEGIN:VEVENT");
  });

  it("exports a direct stay, and a stay another channel brought in (Booking.com) still closes the room on Airbnb", async () => {
    state.blocks = [
      roomBlock("blk-direct", "room-1789775850636-3", "2026-10-27", "2026-10-30", { residentName: "Direct guest", reason: "Direct" }),
      roomBlock("blk-booking", "room-1789775850636-3", "2026-12-01", "2026-12-03", { reason: "Booking" }),
    ];
    const body = await (await request()).text();
    expect(body).toContain("DTSTART;VALUE=DATE:20261027");
    expect(body).toContain("DTSTART;VALUE=DATE:20261201");
  });
});

describe("a feed that cannot be built says so (plan channels-sync-1027)", () => {
  it("fails the fetch and stamps the connection instead of publishing imported nights as free", async () => {
    state.siblingError = true;
    const res = await request();
    expect(res.status).toBe(500);
    const stamped = (state.connectionUpdates as Array<{ table: string; payload: { last_error?: string } }>).find((u) => u.table === "external_calendar_connections");
    expect(stamped?.payload.last_error).toMatch(/^Export feed failed: connection read failed/);
  });

  it("a feed that builds writes no error", async () => {
    expect((await request()).status).toBe(200);
    expect(state.connectionUpdates).toEqual([]);
  });
});
