import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeSeattleRoomOccupancy } from "@/lib/marketing/track-record-occupancy";
import {
  STATED_ROOM_OCCUPANCY,
  TRACK_RECORD,
  resolveRoomOccupancy,
  trackRecordMetrics,
} from "@/lib/marketing/track-record";

const listing = (id: string, title: string, rooms: number) => ({
  id,
  title,
  address: title,
  listingSubmission: { rooms: Array.from({ length: rooms }, (_, i) => ({ id: `r${i + 1}` })) },
});
const SEATTLE = [
  listing("a", "5257 Brooklyn Ave NE", 9),
  listing("b", "5259 Brooklyn Ave NE", 9),
  listing("c", "4709A 8th Ave NE", 10),
];
const span = (start: string, end: string | null, count = 1) => ({ start, end, count });
const TODAY = "2026-11-10";

describe("homepage rooms occupied: live from the occupancy snapshot", () => {
  it("counts a room occupied when a span covers today, across the three homes", () => {
    const rooms = [
      { roomChoice: "a::r1", spans: [span("2026-09-01", null)] },
      { roomChoice: "a::r2", spans: [span("2026-11-10", "2026-11-12")] },
      { roomChoice: "b::r1", spans: [span("2026-01-01", "2026-11-09")] }, // ended yesterday
      { roomChoice: "c::r1", spans: [span("2026-11-11", null)] }, // starts tomorrow
      { roomChoice: "c::r2", spans: [{ start: "2026-01-01", end: null, count: 0 }] },
    ];
    expect(computeSeattleRoomOccupancy(SEATTLE, rooms, TODAY)).toEqual({ roomsOccupied: 2, roomsTotal: 28 });
  });

  it("returns null when one of the homes is missing, so the caller falls back", () => {
    expect(computeSeattleRoomOccupancy(SEATTLE.slice(0, 2), [], TODAY)).toBeNull();
    expect(computeSeattleRoomOccupancy([...SEATTLE.slice(0, 2), listing("c", "4709A 8th Ave NE", 0)], [], TODAY)).toBeNull();
  });

  it("falls back to the last stated figure when the live one is missing or nonsense", () => {
    expect(resolveRoomOccupancy(null)).toEqual(STATED_ROOM_OCCUPANCY);
    expect(resolveRoomOccupancy({ roomsOccupied: 30, roomsTotal: 28 })).toEqual(STATED_ROOM_OCCUPANCY);
    expect(resolveRoomOccupancy({ roomsOccupied: 1.5, roomsTotal: 28 })).toEqual(STATED_ROOM_OCCUPANCY);
    expect(resolveRoomOccupancy({ roomsOccupied: 0, roomsTotal: 0 })).toEqual(STATED_ROOM_OCCUPANCY);
    expect(resolveRoomOccupancy({ roomsOccupied: 23, roomsTotal: 28 })).toEqual({ roomsOccupied: 23, roomsTotal: 28 });
    expect(STATED_ROOM_OCCUPANCY).toEqual({ roomsOccupied: TRACK_RECORD.roomsOccupied, roomsTotal: TRACK_RECORD.roomsTotal });
  });

  it("the metrics strip draws the live figure", () => {
    const occupied = trackRecordMetrics(undefined, { roomsOccupied: 23, roomsTotal: 28 }).find((m) => m.id === "occupied");
    expect(occupied?.value).toBe("23 of 28");
    expect(trackRecordMetrics().find((m) => m.id === "occupied")?.value).toBe("26 of 28");
  });
});

describe("liveRoomOccupancy (server)", () => {
  beforeEach(() => vi.resetModules());

  it("falls back to the stated figure when the public read fails, and never throws", async () => {
    vi.doMock("@/lib/public-listings.server", () => ({ getPublicListings: async () => { throw new Error("db down"); } }));
    vi.doMock("@/lib/public-room-occupancy-snapshot.server", () => ({ loadPublicOccupancySnapshot: async () => [] }));
    const { liveRoomOccupancy } = await import("@/lib/marketing/track-record-live.server");
    await expect(liveRoomOccupancy()).resolves.toEqual(STATED_ROOM_OCCUPANCY);
  });

  it("returns the computed figure when the snapshot reads", async () => {
    vi.doMock("@/lib/public-listings.server", () => ({ getPublicListings: async () => SEATTLE }));
    vi.doMock("@/lib/public-room-occupancy-snapshot.server", () => ({
      loadPublicOccupancySnapshot: async () => [{ roomChoice: "a::r1", spans: [span("2000-01-01", null)] }],
    }));
    const { liveRoomOccupancy } = await import("@/lib/marketing/track-record-live.server");
    await expect(liveRoomOccupancy()).resolves.toEqual({ roomsOccupied: 1, roomsTotal: 28 });
  });
});
