import { beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateRoomOccupancy } from "@/lib/public-room-occupancy";
import { readPublicRoomOccupancy, replacePublicRoomOccupancy, replacePublicRoomOccupancyForProperty } from "@/lib/public-room-occupancy-client";

describe("anonymous room occupancy snapshots", () => {
  beforeEach(() => { vi.useRealTimers(); replacePublicRoomOccupancy([]); });
  it("counts simultaneous beds with inclusive last days and whole-property weights", () => {
    expect(aggregateRoomOccupancy([
      { start: "2030-01-01", end: "2030-01-05" },
      { start: "2030-01-05", end: "2030-01-07" },
      { start: "2030-01-10", end: null, count: 3 },
    ])).toEqual([
      { start: "2030-01-01", end: "2030-01-04", count: 1 },
      { start: "2030-01-05", end: "2030-01-05", count: 2 },
      { start: "2030-01-06", end: "2030-01-07", count: 1 },
      { start: "2030-01-10", end: null, count: 3 },
    ]);
  });
  it("replaces disappeared stays and never keeps a stale successful snapshot indefinitely", () => {
    vi.useFakeTimers();
    replacePublicRoomOccupancy([{ roomChoice: "home::a", spans: [{ start: "2030-01-01", end: null, count: 1 }] }]);
    replacePublicRoomOccupancy([{ roomChoice: "home::a", spans: [] }]);
    expect(readPublicRoomOccupancy("home::a")).toEqual([]);
    vi.advanceTimersByTime(60_001);
    expect(readPublicRoomOccupancy("home::a")).toBeUndefined();
    vi.useRealTimers();
  });
  it("refreshes one property without extending another property's expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const spans = [{ start: "2030-01-01", end: null, count: 1 }];
    replacePublicRoomOccupancy([{ roomChoice: "home::a", spans }, { roomChoice: "other::b", spans }]);
    vi.advanceTimersByTime(45_000);
    replacePublicRoomOccupancyForProperty("home", [{ roomChoice: "home::a", spans: [] }, { roomChoice: "other::b", spans: [] }]);
    expect(readPublicRoomOccupancy("other::b")).toEqual(spans);
    vi.advanceTimersByTime(15_001);
    expect(readPublicRoomOccupancy("other::b")).toBeUndefined();
    expect(readPublicRoomOccupancy("home::a")).toEqual([]);
  });
  it("removes obsolete rooms only from the property being refreshed", () => {
    replacePublicRoomOccupancy([{ roomChoice: "home::a", spans: [] }, { roomChoice: "other::b", spans: [] }]);
    replacePublicRoomOccupancyForProperty("home", []);
    expect(readPublicRoomOccupancy("home::a")).toBeUndefined();
    expect(readPublicRoomOccupancy("other::b")).toEqual([]);
  });

  it("merges a background response without undoing a newer scoped refresh", () => {
    const occupied = [{ start: "2030-01-01", end: null, count: 1 }];
    replacePublicRoomOccupancy([{ roomChoice: "home::a", spans: occupied }, { roomChoice: "other::b", spans: occupied }]);
    replacePublicRoomOccupancyForProperty("home", []);
    replacePublicRoomOccupancy([{ roomChoice: "home::a", spans: occupied }, { roomChoice: "other::b", spans: [] }], ["home"]);
    expect(readPublicRoomOccupancy("home::a")).toBeUndefined();
    expect(readPublicRoomOccupancy("other::b")).toEqual([]);
  });

});
