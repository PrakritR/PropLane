import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isHostBlockRange, isHostBlockSummary, withoutHostBlocks } from "@/lib/channel-calendar/host-block";
import { isIcalAvailabilityBlock } from "@/lib/occupancy/snapshot";
import { icalEventsToImportedRanges } from "@/lib/channel-calendar/sync.server";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { importedRangesForFeed } from "@/lib/channel-calendar/export-feed";
import { conflictingChannelStays } from "@/lib/channel-calendar/channel-conflicts";
import { evaluateRoomOccupancy } from "@/lib/rental-application/room-occupancy";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe("host block classification", () => {
  it("matches Not available / Blocked / Unavailable, never Reserved or a guest", () => {
    for (const s of ["Airbnb (Not available)", "Not available", "blocked", "Unavailable"]) expect(isHostBlockSummary(s)).toBe(true);
    for (const s of ["Reserved", "Alex M.", "", null, undefined]) expect(isHostBlockSummary(s)).toBe(false);
  });

  it("never reads a privacy-stripped Booking.com / VRBO reservation as a host block", () => {
    // Those channels export real stays as "CLOSED - Not available": a substring match would
    // publish an occupied room as free. The whole summary must be the block label.
    for (const s of ["CLOSED - Not available", "Not available for guests", "Airbnb (Reserved)", "Blocked out by guest"]) {
      expect(isHostBlockSummary(s), s).toBe(false);
    }
    expect(isIcalAvailabilityBlock("CLOSED - Not available")).toBe(true);
  });

  it("agrees with the occupancy predicate: every host block also holds a bed", () => {
    for (const s of ["Airbnb (Not available)", "Not available", "blocked", "Unavailable"]) {
      expect(isIcalAvailabilityBlock(s), s).toBe(true);
    }
  });

  it("marks host blocks on import and leaves Reserved alone", () => {
    const out = icalEventsToImportedRanges([
      { uid: "a", summary: "Airbnb (Not available)", startDate: "2026-11-01", endDate: "2026-11-05" },
      { uid: "b", summary: "Reserved", startDate: "2026-12-01", endDate: "2026-12-03" },
    ]);
    expect(out[0]!.hostBlock).toBe(true);
    expect(out[1]!.hostBlock).toBeUndefined();
  });

  it("derives the flag on read for ranges stored before it existed", () => {
    const row = parseConnectionRow({
      id: "c1", manager_user_id: "m", property_id: "p", room_id: "r", export_token: "t",
      imported_ranges: [
        { id: "1", start: "2026-11-01", end: "2026-11-02", sourceUid: "1", summary: "Airbnb (Not available)" },
        { id: "2", start: "2026-12-01", end: "2026-12-02", sourceUid: "2", summary: "Reserved" },
      ],
    });
    expect(row.imported_ranges.map(isHostBlockRange)).toEqual([true, false]);
  });
});

describe("capacity ignores host blocks", () => {
  it("a room blocked on Airbnb still has room for a resident", () => {
    const ranges: { id: string; start: string; end: string; hostBlock?: boolean }[] = [
      { id: "channel-import-c-1", start: "2026-11-01", end: "2026-11-30", hostBlock: true },
      { id: "channel-import-c-2", start: "2027-01-01", end: "2027-01-10" },
    ];
    const toPlacements = (rs: typeof ranges) =>
      rs.map((r) => ({ id: r.id, start: new Date(`${r.start}T00:00:00`), end: new Date(`${r.end}T00:00:00`) }));
    const window = { capacity: 1, windowStart: d(2026, 11, 5), windowEnd: d(2026, 11, 20) };
    expect(evaluateRoomOccupancy({ ...window, placements: toPlacements(ranges) }).hasRoom).toBe(false);
    expect(evaluateRoomOccupancy({ ...window, placements: toPlacements(withoutHostBlocks(ranges)) }).hasRoom).toBe(true);
    // A real reservation still fills the bed.
    const real = { capacity: 1, windowStart: d(2027, 1, 2), windowEnd: d(2027, 1, 5) };
    expect(evaluateRoomOccupancy({ ...real, placements: toPlacements(withoutHostBlocks(ranges)) }).hasRoom).toBe(false);
  });
});

describe("host blocks are never exported or counted as conflicts", () => {
  it("export feed skips host blocks from other channels", () => {
    const out = importedRangesForFeed({
      propertyId: "p1", roomId: "r1", destination: "vrbo", placements: [],
      connections: [{ id: "c1", roomId: "r1", provider: "airbnb", importedRanges: [
        { id: "a", sourceUid: "a", start: "2026-11-01", end: "2026-11-05", summary: "Airbnb (Not available)", hostBlock: true },
        { id: "b", sourceUid: "b", start: "2026-12-01", end: "2026-12-03", summary: "Reserved" },
        { id: "c", sourceUid: "c", start: "2027-02-01", end: "2027-02-03", summary: "Not available" },
      ] }],
    });
    expect(out).toEqual([{ start: "2026-12-01", end: "2026-12-03" }]);
  });

  it("channel conflict detection ignores a host block over a PropLane stay", () => {
    const base = { propertyId: "p1", propertyLabel: "P", roomId: "r1", roomLabel: "R", start: "2026-11-01", end: "2026-11-05" };
    const entries = [
      { ...base, source: "proplane", summary: "Resident" },
      { ...base, source: "airbnb", summary: "Airbnb (Not available)" },
    ] as PropertyBookingEntry[];
    expect(conflictingChannelStays(entries, "p1", "r1", "airbnb")).toHaveLength(0);
    entries[1] = { ...entries[1]!, summary: "Reserved" };
    expect(conflictingChannelStays(entries, "p1", "r1", "airbnb")).toHaveLength(1);
  });
});
