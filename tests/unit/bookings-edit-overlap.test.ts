import { afterEach, describe, expect, it, vi } from "vitest";
import { describeBookingConflict } from "@/lib/channel-calendar/bookings-ui";
import { saveRoomDateBlock } from "@/lib/channel-calendar/room-date-blocks";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

// The server-side half: same pattern as tests/unit/portal-schedule-records-atomic-write.test.ts
// — capture the route's `atomicWrite` hook by mocking `createJsonRecordRoute`,
// then call it directly with a fake db.
const routeMocks = vi.hoisted(() => ({ config: null as null | Record<string, unknown> }));
vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    routeMocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
await import("@/app/api/portal-schedule-records/route");

type AtomicWrite = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function fakeScheduleRecordsDb(rows: Array<{ id: string; row_data: unknown }>) {
  const builder = {
    eq: () => builder,
    then: (resolve: (value: { data: unknown; error: null }) => void) => resolve({ data: rows, error: null }),
  };
  return { from: () => ({ select: () => builder }) };
}

/**
 * The Edit dates / Move room overlap refusal (PLAN-0920-1058, area 1e):
 * the conflict names the room, the dates, and who has it — never a generic
 * "these dates are taken" — and a same-room, same-property 409 from the
 * server is what a client save ultimately surfaces, so a race with another
 * save still refuses.
 */
describe("describeBookingConflict", () => {
  const conflict: Pick<PropertyBookingEntry, "roomLabel" | "start" | "end" | "openEnded" | "summary"> = {
    roomLabel: "Room 9",
    start: "2026-09-01",
    end: "2026-08-31",
    openEnded: false,
    summary: "Prakrit",
  };

  it("names the room, the dates, and the person — never a generic refusal", () => {
    expect(describeBookingConflict(conflict, "Room 1")).toBe(
      "Room 9 is booked Sep 1, 2026 – Aug 31, 2026 by Prakrit",
    );
  });

  it("falls back to the field's own room label when the conflict has none", () => {
    expect(describeBookingConflict({ ...conflict, roomLabel: "" }, "Room 1")).toBe(
      "Room 1 is booked Sep 1, 2026 – Aug 31, 2026 by Prakrit",
    );
  });

  it("drops the 'by <name>' clause when the conflicting entry has no name", () => {
    expect(describeBookingConflict({ ...conflict, summary: "" }, "Room 1")).toBe(
      "Room 9 is booked Sep 1, 2026 – Aug 31, 2026",
    );
  });
});

describe("the server re-checks overlap at write time (docs/agents/shared-room-capacity.md's 409 contract)", () => {
  it("refuses a new block that overlaps another hold on the same room with a 409", async () => {
    const atomicWrite = routeMocks.config!.atomicWrite as AtomicWrite;
    const db = fakeScheduleRecordsDb([
      {
        id: "existing-block",
        row_data: {
          roomId: "room-9",
          checkIn: "2026-09-01",
          checkOut: "2026-09-05",
          residentName: "Prakrit",
        },
      },
    ]);

    const result = await atomicWrite({
      db,
      user: { id: "mgr-1", role: "manager" },
      record: {
        id: "new-block",
        manager_user_id: "mgr-1",
        property_id: "p1",
        record_type: "room_date_block",
        row_data: { roomId: "room-9", checkIn: "2026-09-03", checkOut: "2026-09-06" },
      },
      existing: null,
      expectedPayload: undefined,
      expectedPayloadKnown: false,
    });

    expect(result.status).toBe(409);
    expect(result.error).toContain("Prakrit");
  });

  it("lets a non-overlapping block, or a different room, through to the ordinary upsert", async () => {
    const atomicWrite = routeMocks.config!.atomicWrite as AtomicWrite;
    const db = fakeScheduleRecordsDb([
      { id: "existing-block", row_data: { roomId: "room-9", checkIn: "2026-09-01", checkOut: "2026-09-05" } },
    ]);

    const sameRoomLater = await atomicWrite({
      db,
      user: { id: "mgr-1", role: "manager" },
      record: {
        id: "new-block",
        manager_user_id: "mgr-1",
        property_id: "p1",
        record_type: "room_date_block",
        row_data: { roomId: "room-9", checkIn: "2026-09-05", checkOut: "2026-09-08" },
      },
      existing: null,
      expectedPayload: undefined,
      expectedPayloadKnown: false,
    });
    // Check-out is exclusive: the 5th is free again.
    expect(sameRoomLater).toEqual({ handled: false });

    const differentRoom = await atomicWrite({
      db,
      user: { id: "mgr-1", role: "manager" },
      record: {
        id: "new-block-2",
        manager_user_id: "mgr-1",
        property_id: "p1",
        record_type: "room_date_block",
        row_data: { roomId: "room-10", checkIn: "2026-09-02", checkOut: "2026-09-04" },
      },
      existing: null,
      expectedPayload: undefined,
      expectedPayloadKnown: false,
    });
    expect(differentRoom).toEqual({ handled: false });
  });

  it("excludes the record's own prior row from the conflict check (editing dates in place)", async () => {
    const atomicWrite = routeMocks.config!.atomicWrite as AtomicWrite;
    const db = fakeScheduleRecordsDb([
      { id: "same-block", row_data: { roomId: "room-9", checkIn: "2026-09-01", checkOut: "2026-09-05" } },
    ]);

    const result = await atomicWrite({
      db,
      user: { id: "mgr-1", role: "manager" },
      record: {
        id: "same-block",
        manager_user_id: "mgr-1",
        property_id: "p1",
        record_type: "room_date_block",
        row_data: { roomId: "room-9", checkIn: "2026-09-02", checkOut: "2026-09-06" },
      },
      existing: null,
      expectedPayload: undefined,
      expectedPayloadKnown: false,
    });

    expect(result).toEqual({ handled: false });
  });
});

describe("saveRoomDateBlock propagates the server's 409 refusal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws with the server's named-conflict message on a 409", async () => {
    const message = "Room 9 is booked Sep 1 – Aug 31 by Prakrit";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: message }),
      })),
    );

    await expect(
      saveRoomDateBlock("mgr-1", {
        propertyId: "p1",
        roomId: "room-9",
        checkIn: "2026-09-01",
        checkOut: "2026-09-02",
        reason: "",
      }),
    ).rejects.toThrow(message);
  });

  it("still throws a usable message when the 409 body carries none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({}),
      })),
    );

    await expect(
      saveRoomDateBlock("mgr-1", {
        propertyId: "p1",
        roomId: "room-9",
        checkIn: "2026-09-01",
        checkOut: "2026-09-02",
        reason: "",
      }),
    ).rejects.toThrow("Could not block those dates.");
  });
});
