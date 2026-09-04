/**
 * AXI-167 (second ask) — "it should tell me the size of each room as well if
 * thats possible, so i know why I am paying more for one room versus the other."
 *
 * Rooms had no size at all, so the ranked room choices showed rent with nothing
 * to justify the difference between them.
 */
import { describe, expect, it } from "vitest";
import { emptyRoom, normalizeManagerListingSubmissionV1, normalizeRoomSizeSqft, createDefaultListingSubmission } from "@/lib/manager-listing-submission";

describe("normalizeRoomSizeSqft", () => {
  it("accepts a plain number and a typed string", () => {
    expect(normalizeRoomSizeSqft(120)).toBe(120);
    expect(normalizeRoomSizeSqft("120")).toBe(120);
    expect(normalizeRoomSizeSqft("120 sq ft")).toBe(120);
    expect(normalizeRoomSizeSqft("1,200")).toBe(1200);
  });

  it("treats a missing or unparseable value as UNKNOWN, never 0", () => {
    // A defaulted 0 would render as "0 sq ft" on a public listing — asserting a
    // fact about the room that nobody supplied.
    for (const raw of [undefined, null, "", "   ", "abc", Number.NaN, 0, -50, "0"]) {
      expect(normalizeRoomSizeSqft(raw)).toBeUndefined();
    }
  });

  it("rejects a figure too large to be a bedroom", () => {
    // Almost always a rent amount typed into the wrong box.
    expect(normalizeRoomSizeSqft(250000)).toBeUndefined();
  });

  it("rounds a fractional measurement", () => {
    expect(normalizeRoomSizeSqft("119.6")).toBe(120);
  });
});

describe("room size survives normalization", () => {
  it("keeps a stated size and leaves an unstated one undefined", () => {
    const sized = { ...emptyRoom(0), id: "r1", name: "Room 1", sizeSqft: 140 };
    const unsized = { ...emptyRoom(1), id: "r2", name: "Room 2" };
    const normalized = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      rooms: [sized, unsized],
    });
    expect(normalized.rooms[0]?.sizeSqft).toBe(140);
    expect(normalized.rooms[1]?.sizeSqft).toBeUndefined();
  });

  it("drops a junk value rather than storing it", () => {
    const normalized = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      rooms: [{ ...emptyRoom(0), id: "r1", sizeSqft: -3 as unknown as number }],
    });
    expect(normalized.rooms[0]?.sizeSqft).toBeUndefined();
  });
});
