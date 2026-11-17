import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ records: [] as Record<string, unknown>[] }));

function pathValue(record: Record<string, unknown>, column: string): unknown {
  if (!column.startsWith("row_data")) return record[column];
  const [, ...path] = column.split(/->>|->/);
  let cursor: unknown = record.row_data;
  for (const key of path) cursor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined;
  return cursor == null ? null : String(cursor);
}

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const chain = {
        select: () => chain,
        update: () => chain,
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
            const rows = state.records.filter((row) => filters.every((f) => f(row)));
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
                lease_term: pathValue(row, "row_data->application->>leaseTerm"),
                manual_term: pathValue(row, "row_data->manualResidentDetails->>leaseTerm"),
                manually_added: pathValue(row, "row_data->>manuallyAdded"),
                bucket: pathValue(row, "row_data->>bucket"),
                ical_connection: pathValue(row, "row_data->>icalConnectionId"),
              })),
            });
          } else if (table === "manager_property_records") {
            resolve({ error: null, data: [{ id: "prop-1", manager_user_id: "owner-user" }] });
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
  loadConnectionByExportToken: async () => ({ id: "conn-1", property_id: "prop-1", room_id: "room-1", provider: "airbnb", manager_user_id: "owner-user" }),
  loadPropertyRecord: async () => ({ property: { listingSubmission: { v: 1, listingPlaceCategoryId: "shared_home", rooms: [{ id: "room-1", name: "R1" }, { id: "room-2", name: "R2" }] } } }),
}));

import { GET } from "@/app/api/calendar/export/[token]/route";

const request = () => GET(new Request("https://example.com/api/calendar/export/token.ics"), { params: Promise.resolve({ token: "token.ics" }) });

function resident(application: Record<string, unknown>, manual: Record<string, unknown>) {
  return {
    id: "app-1", manager_user_id: "owner-user", property_id: "prop-1", assigned_property_id: "prop-1",
    row_data: { bucket: "approved", propertyId: "prop-1", assignedPropertyId: "prop-1", assignedRoomChoice: "prop-1::room-1", application: { roomChoice1: "prop-1::room-1", ...application }, manualResidentDetails: manual },
  };
}
const events = (body: string) => body.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
  state.records = [];
});
afterEach(() => vi.useRealTimers());

describe("export feed: open-ended leases", () => {
  it("a month-to-month lease with no end blocks move-in -> today + 365 as one event (DTEND is exclusive)", async () => {
    state.records = [resident({ leaseStart: "2026-09-01", leaseTerm: "Month-to-Month" }, {})];
    const evs = events(await (await request()).text());
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain("DTSTART;VALUE=DATE:20260901");
    expect(evs[0]).toContain("DTEND;VALUE=DATE:20271117");
  });

  it("an approved lease with no end date and no term blocks the same way", async () => {
    state.records = [resident({ leaseStart: "2026-09-01" }, { moveInDate: "2026-09-01" })];
    const evs = events(await (await request()).text());
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain("DTEND;VALUE=DATE:20271117");
  });

  it("a month-to-month term still rolls even when a stale end date is stored", async () => {
    state.records = [resident({ leaseStart: "2026-09-01", leaseEnd: "2026-10-01", leaseTerm: "Month-to-Month" }, {})];
    expect(await (await request()).text()).toContain("DTEND;VALUE=DATE:20271117");
  });

  it("a move-out date wins over the rolling year", async () => {
    state.records = [resident({ leaseStart: "2026-09-01", leaseTerm: "Month-to-Month" }, { moveOutDate: "2027-02-14" })];
    const evs = events(await (await request()).text());
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain("DTEND;VALUE=DATE:20270215");
  });

  it("a fixed-term lease is unchanged", async () => {
    state.records = [resident({ leaseStart: "2026-09-01", leaseEnd: "2027-08-31", leaseTerm: "12 months" }, {})];
    const evs = events(await (await request()).text());
    expect(evs[0]).toContain("DTEND;VALUE=DATE:20270901");
  });
});
