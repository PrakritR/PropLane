/**
 * "Open now" is the one availability count: rooms, today only. A room that opens later reads
 * "Opens <date>" and is never counted, including a room whose own move-in date is in the future.
 */
import { describe, expect, it } from "vitest";
import {
  countRoomsAvailableNow,
  resolveRoomAvailability,
  roomAvailabilityDisplay,
} from "@/lib/public-listing-available-count";

const TODAY = "2026-11-17";
const room = (id: string, extra: Record<string, unknown> = {}) => ({ id, availability: "Available now", occupancyCapacity: 1, ...extra });

describe("open now is the one count", () => {
  it("a future moveInAvailableDate is not 'now' even when the saved label says Available now", () => {
    const r = room("a", { moveInAvailableDate: "2026-12-01" });
    expect(resolveRoomAvailability(r, [], TODAY, "p")).toEqual({ kind: "from", date: "2026-12-01" });
    expect(countRoomsAvailableNow([r], [], TODAY, "p")).toBe(0);
  });

  it("a past or empty move-in date does not hold the room back", () => {
    expect(countRoomsAvailableNow([room("a", { moveInAvailableDate: "2026-10-01" }), room("b", { moveInAvailableDate: "" })], [], TODAY, "p")).toBe(2);
  });

  it("counts rooms open today only: a room freeing later is not counted", () => {
    const rooms = [room("a"), room("b"), room("c"), room("d")];
    const rows = [
      { roomChoice: "p::c", spans: [{ start: "2026-10-01", end: "2026-11-30", count: 1 }] },
      { roomChoice: "p::d", spans: [{ start: "2026-10-01", end: null, count: 1 }] },
    ];
    expect(countRoomsAvailableNow(rooms, rows, TODAY, "p")).toBe(2);
  });

  it("labels: Open now / Opens <date>", () => {
    const rooms = [room("a"), room("b", { moveInAvailableDate: "2026-12-01" })];
    const read = { rows: [], loading: false, failed: false };
    expect(roomAvailabilityDisplay(rooms[0]!, read, TODAY, "p")?.text).toBe("Open now");
    expect(roomAvailabilityDisplay(rooms[1]!, read, TODAY, "p")?.text).toBe("Opens Dec 1");
    expect(roomAvailabilityDisplay(rooms[1]!, read, TODAY, "p")?.tone).toBe("future");
  });
});
