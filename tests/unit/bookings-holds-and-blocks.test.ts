/**
 * Bookings calendar sources beyond stays: an approved application HOLDS a
 * room until its lease is signed, and a manager can BLOCK a range with a
 * reason. Check-out is exclusive everywhere, so back-to-back turnovers are
 * not collisions.
 */
import { describe, expect, it } from "vitest";
import {
  applicationHoldEntries,
  bookingConflictsFor,
  bookingRangesOverlap,
  lastNightBeforeCheckout,
  roomBlockEntries,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import {
  ROOM_DATE_BLOCK_RECORD_TYPE,
  isManagerScopedScheduleRecordType,
  managerScheduleRecordIdOwnedByUser,
  roomDateBlockRecordId,
} from "@/lib/portal-schedule-record-scope";

const PROPERTY = { id: "house-1", label: "4709A 8th Ave NE" };
const roomLabel = (_p: string, roomId: string) => (roomId === "room-a" ? "Room A" : "Room B");

function stay(over: Partial<PropertyBookingEntry>): PropertyBookingEntry {
  return {
    source: "proplane",
    propertyId: PROPERTY.id,
    propertyLabel: PROPERTY.label,
    roomId: "room-a",
    roomLabel: "Room A",
    summary: "Ada",
    start: "2026-09-10",
    end: "2026-09-14",
    ...over,
  };
}

describe("exclusive check-out", () => {
  it("turns a check-out day into the last night before it", () => {
    expect(lastNightBeforeCheckout("2026-09-12")).toBe("2026-09-11");
    expect(lastNightBeforeCheckout("2026-10-01")).toBe("2026-09-30");
    expect(lastNightBeforeCheckout("2027-01-01")).toBe("2026-12-31");
  });

  it("does not collide a stay ending on the day another begins", () => {
    // Stay A: nights 10–14 (check-out 15). Stay B checks in on the 15th.
    expect(bookingRangesOverlap({ start: "2026-09-10", end: "2026-09-14" }, { start: "2026-09-15", end: "2026-09-20" })).toBe(false);
    expect(bookingRangesOverlap({ start: "2026-09-10", end: "2026-09-14" }, { start: "2026-09-14", end: "2026-09-20" })).toBe(true);
  });
});

describe("bookingConflictsFor", () => {
  const existing = [stay({}), stay({ roomId: "room-b", roomLabel: "Room B", summary: "Bo", start: "2026-09-20", end: "2026-09-25" })];

  it("only collides on the same room", () => {
    expect(bookingConflictsFor(existing, { propertyId: PROPERTY.id, roomId: "room-b", start: "2026-09-11", end: "2026-09-12" })).toEqual([]);
    expect(bookingConflictsFor(existing, { propertyId: PROPERTY.id, roomId: "room-a", start: "2026-09-11", end: "2026-09-12" }).map((e) => e.summary)).toEqual(["Ada"]);
  });

  it("a whole-home range collides with every room, and a room collides with a whole-home stay", () => {
    expect(bookingConflictsFor(existing, { propertyId: PROPERTY.id, roomId: "", start: "2026-09-13", end: "2026-09-21" }).map((e) => e.summary)).toEqual(["Ada", "Bo"]);
    const wholeHome = [stay({ roomId: "", roomLabel: "Whole home" })];
    expect(bookingConflictsFor(wholeHome, { propertyId: PROPERTY.id, roomId: "room-b", start: "2026-09-12", end: "2026-09-12" })).toHaveLength(1);
  });

  it("an open-ended stay takes every night after its start, horizon or not", () => {
    const openEnded = [stay({ openEnded: true, start: "2026-09-10", end: "2027-09-10" })];
    expect(bookingConflictsFor(openEnded, { propertyId: PROPERTY.id, roomId: "room-a", start: "2028-01-01", end: "2028-01-03" })).toHaveLength(1);
    expect(bookingConflictsFor(openEnded, { propertyId: PROPERTY.id, roomId: "room-a", start: "2026-09-01", end: "2026-09-09" })).toEqual([]);
  });

  it("ignores another property", () => {
    expect(bookingConflictsFor(existing, { propertyId: "house-2", roomId: "room-a", start: "2026-09-11", end: "2026-09-12" })).toEqual([]);
  });
});

describe("applicationHoldEntries", () => {
  const opts = {
    properties: [PROPERTY],
    roomLabelForId: roomLabel,
    isLeased: (row: { id: string }) => row.id === "AXIS-LEASED",
    openEndedHorizonKey: "2028-01-01",
  };

  it("holds the room for an approved application whose lease is not signed", () => {
    const [entry] = applicationHoldEntries(
      [
        {
          id: "AXIS-1",
          bucket: "approved",
          name: "Cleo",
          assignedPropertyId: PROPERTY.id,
          assignedRoomChoice: `${PROPERTY.id}::room-a`,
          application: { leaseStart: "2026-10-01", leaseEnd: "2026-12-31" },
        },
      ],
      opts,
    );
    expect(entry).toMatchObject({ source: "hold", roomId: "room-a", roomLabel: "Room A", start: "2026-10-01", end: "2026-12-31", summary: "Cleo" });
  });

  it("skips pending applications and ones that already have a signed lease (that is a stay)", () => {
    const rows = [
      { id: "AXIS-P", bucket: "pending", assignedPropertyId: PROPERTY.id, assignedRoomChoice: `${PROPERTY.id}::room-a`, application: { leaseStart: "2026-10-01" } },
      { id: "AXIS-LEASED", bucket: "approved", assignedPropertyId: PROPERTY.id, assignedRoomChoice: `${PROPERTY.id}::room-a`, application: { leaseStart: "2026-10-01" } },
    ];
    expect(applicationHoldEntries(rows, opts)).toEqual([]);
  });

  it("is open-ended without a lease end, and needs a room unless the listing is a whole home", () => {
    const rows = [
      { id: "AXIS-2", bucket: "approved", assignedPropertyId: PROPERTY.id, assignedRoomChoice: `${PROPERTY.id}::room-b`, application: { leaseStart: "2026-10-01" } },
      { id: "AXIS-3", bucket: "approved", assignedPropertyId: PROPERTY.id, application: { leaseStart: "2026-10-01" } },
    ];
    const shared = applicationHoldEntries(rows, opts);
    expect(shared.map((e) => e.summary)).toEqual(["Approved applicant"]);
    expect(shared[0]).toMatchObject({ roomId: "room-b", openEnded: true, end: "2028-01-01" });
    const whole = applicationHoldEntries(rows, { ...opts, properties: [{ ...PROPERTY, entireHomeListing: true }] });
    expect(whole).toHaveLength(2);
    expect(whole[1]).toMatchObject({ roomId: "", roomLabel: "Whole home" });
  });
});

describe("roomBlockEntries", () => {
  it("draws a block as inclusive nights with its reason and id", () => {
    const [entry] = roomBlockEntries(
      [{ id: "axis_room_block_u1_x", propertyId: PROPERTY.id, roomId: "room-a", checkIn: "2026-09-10", checkOut: "2026-09-12", reason: "Repairs", createdAt: "" }],
      { propertyLabelForId: () => PROPERTY.label, roomLabelForId: roomLabel },
    );
    expect(entry).toMatchObject({ source: "block", start: "2026-09-10", end: "2026-09-11", summary: "Repairs", blockId: "axis_room_block_u1_x", roomLabel: "Room A", statusLabel: "Blocked" });
  });

  it("drops a block whose check-out is not after its check-in", () => {
    expect(
      roomBlockEntries(
        [{ id: "b", propertyId: PROPERTY.id, roomId: "", checkIn: "2026-09-10", checkOut: "2026-09-10", reason: "", createdAt: "" }],
        { propertyLabelForId: () => PROPERTY.label, roomLabelForId: roomLabel },
      ),
    ).toEqual([]);
  });
});

describe("room_date_block record scope", () => {
  it("is manager-scoped and owned through the id", () => {
    expect(isManagerScopedScheduleRecordType(ROOM_DATE_BLOCK_RECORD_TYPE)).toBe(true);
    const mine = roomDateBlockRecordId("user-1", "abc");
    expect(managerScheduleRecordIdOwnedByUser(mine, "user-1", ROOM_DATE_BLOCK_RECORD_TYPE)).toBe(true);
    expect(managerScheduleRecordIdOwnedByUser(mine, "user-2", ROOM_DATE_BLOCK_RECORD_TYPE)).toBe(false);
    expect(managerScheduleRecordIdOwnedByUser(roomDateBlockRecordId("user-10", "abc"), "user-1", ROOM_DATE_BLOCK_RECORD_TYPE)).toBe(false);
  });
});
