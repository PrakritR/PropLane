import { describe, expect, it } from "vitest";
import { conflictRangeLabel, explainRoomDateConflict } from "@/lib/rental-application/room-conflict-explanation";

const d = (s: string) => {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y!, m! - 1, day!);
};

describe("explainRoomDateConflict", () => {
  const short = [{ start: d("2026-12-12"), end: d("2026-12-13") }];

  it("names the conflicting range and the nearest workable dates, with no guest detail", () => {
    const r = explainRoomDateConflict({
      roomName: "Room 7",
      windows: short,
      leaseStart: d("2026-11-24"),
      leaseEnd: d("2027-11-23"),
      alternativeRooms: ["Room 3"],
    })!;
    expect(r.message).toContain("Room 7 is booked Dec 12–13, 2026.");
    expect(r.message).toContain("a lease ending Dec 11, 2026");
    expect(r.message).toContain("a start on Dec 14, 2026 or later");
    expect(r.message).toContain("Free for your whole term: Room 3.");
    expect(r.latestEndBeforeConflict).toEqual(d("2026-12-11"));
    expect(r.nextStartAfterConflict).toEqual(d("2026-12-14"));
    expect(r.message.toLowerCase()).not.toContain("airbnb");
  });

  it("returns null when nothing overlaps", () => {
    expect(
      explainRoomDateConflict({ roomName: "Room 7", windows: short, leaseStart: d("2027-01-01"), leaseEnd: d("2027-12-31") }),
    ).toBeNull();
  });

  it("offers no end date when the start is already inside the booking, only the next start", () => {
    const r = explainRoomDateConflict({ roomName: "Room 7", windows: short, leaseStart: d("2026-12-12"), leaseEnd: d("2027-12-11") })!;
    expect(r.latestEndBeforeConflict).toBeNull();
    expect(r.nextStartAfterConflict).toEqual(d("2026-12-14"));
  });

  it("skips a next start that a second booking holds", () => {
    const r = explainRoomDateConflict({
      roomName: "Room 7",
      windows: [...short, { start: d("2026-12-14"), end: d("2026-12-20") }],
      leaseStart: d("2026-11-24"),
      leaseEnd: d("2027-11-23"),
    })!;
    expect(r.conflicts).toHaveLength(1);
    expect(r.message).toContain("Dec 12–20, 2026");
    expect(r.nextStartAfterConflict).toEqual(d("2026-12-21"));
  });

  it("offers no next start when the room is held indefinitely, and falls back to the generic advice", () => {
    const r = explainRoomDateConflict({
      roomName: "Room 7",
      windows: [{ start: d("2026-12-12"), end: null }],
      leaseStart: d("2026-12-01"),
      leaseEnd: d("2027-11-30"),
    })!;
    expect(r.nextStartAfterConflict).toBeNull();
    expect(r.message).toContain("booked from Dec 12, 2026");
    expect(r.message).toContain("a lease ending Dec 11, 2026");
  });

  it("formats ranges across months and years", () => {
    expect(conflictRangeLabel(d("2026-12-30"), d("2027-01-02"))).toBe("Dec 30, 2026 – Jan 2, 2027");
    expect(conflictRangeLabel(d("2026-12-12"), d("2026-12-12"))).toBe("Dec 12, 2026");
  });
});
