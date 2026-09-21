/**
 * Normalization of per-resident move-in details on a shared room: rows are
 * cleaned, padded/truncated to capacity, and dropped below capacity 2 or when
 * every entry is empty — the same shape of rule `reconcileRoomResidentPricing`
 * follows for rent.
 */
import { describe, expect, it } from "vitest";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  reconcileRoomResidentMoveIn,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

function listingWith(room: Partial<ManagerRoomSubmission>): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const first = base.rooms[0]!;
  return {
    ...base,
    rooms: [{ ...first, occupancyCapacity: 2, ...room }],
  };
}

function normalizedRoom(room: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  return normalizeManagerListingSubmissionV1(listingWith(room)).rooms[0]!;
}

describe("normalizing moveInResidentDetails", () => {
  it("keeps cleaned rows on a shared room", () => {
    const room = normalizedRoom({
      moveInResidentDetails: [
        { moveInInstructions: "Bed by the window", moveInPhotoDataUrls: ["data:image/png;base64,a"], moveInVideoDataUrl: null },
        { moveInInstructions: "Closet on the left", moveInPhotoDataUrls: [], moveInVideoDataUrl: "data:video/mp4;base64,b" },
      ],
    });
    expect(room.moveInResidentDetails).toEqual([
      { moveInInstructions: "Bed by the window", moveInPhotoDataUrls: ["data:image/png;base64,a"], moveInVideoDataUrl: null },
      { moveInInstructions: "Closet on the left", moveInPhotoDataUrls: [], moveInVideoDataUrl: "data:video/mp4;base64,b" },
    ]);
  });

  it("leaves a room that never had the field byte-identical (no key added)", () => {
    const room = normalizedRoom({});
    expect("moveInResidentDetails" in room).toBe(false);
  });

  it("drops the field when capacity is 1", () => {
    const room = normalizedRoom({
      occupancyCapacity: 1,
      moveInResidentDetails: [
        { moveInInstructions: "Bed by the window", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
      ],
    });
    expect(room.moveInResidentDetails).toBeUndefined();
  });

  it("pads missing rows to capacity with empty entries", () => {
    const room = normalizedRoom({
      occupancyCapacity: 3,
      moveInResidentDetails: [
        { moveInInstructions: "Bed by the window", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
      ],
    });
    expect(room.moveInResidentDetails).toEqual([
      { moveInInstructions: "Bed by the window", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
      { moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
      { moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
    ]);
  });

  it("truncates rows beyond capacity", () => {
    const room = normalizedRoom({
      occupancyCapacity: 2,
      moveInResidentDetails: [
        { moveInInstructions: "One", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
        { moveInInstructions: "Two", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
        { moveInInstructions: "Three", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
        { moveInInstructions: "Four", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
      ],
    });
    expect(room.moveInResidentDetails?.map((r) => r.moveInInstructions)).toEqual(["One", "Two"]);
  });

  it("drops the field when every entry is empty", () => {
    const room = normalizedRoom({
      occupancyCapacity: 2,
      moveInResidentDetails: [
        { moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
        { moveInInstructions: "   ", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
      ],
    });
    expect(room.moveInResidentDetails).toBeUndefined();
  });

  it("cleans junk entries and non-string fields", () => {
    const room = normalizedRoom({
      occupancyCapacity: 2,
      moveInResidentDetails: [
        { moveInInstructions: "  Trimmed  ", moveInPhotoDataUrls: ["ok", 42, null] as unknown as string[], moveInVideoDataUrl: "" },
        null as unknown as { moveInInstructions: string; moveInPhotoDataUrls: string[]; moveInVideoDataUrl: string | null },
      ],
    });
    expect(room.moveInResidentDetails).toEqual([
      { moveInInstructions: "Trimmed", moveInPhotoDataUrls: ["ok"], moveInVideoDataUrl: null },
      { moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
    ]);
  });
});

describe("reconcileRoomResidentMoveIn (pure)", () => {
  it("drops below capacity 2, keeping the rest of the room untouched", () => {
    const base = createDefaultListingSubmission().rooms[0]!;
    const room: ManagerRoomSubmission = {
      ...base,
      occupancyCapacity: 1,
      moveInResidentDetails: [{ moveInInstructions: "x", moveInPhotoDataUrls: [], moveInVideoDataUrl: null }],
    };
    const out = reconcileRoomResidentMoveIn(room);
    expect(out.moveInResidentDetails).toBeUndefined();
    expect(out.name).toBe(base.name);
  });

  it("pads and truncates a capacity-3 room", () => {
    const base = createDefaultListingSubmission().rooms[0]!;
    const room: ManagerRoomSubmission = {
      ...base,
      occupancyCapacity: 3,
      moveInResidentDetails: [
        { moveInInstructions: "A", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
        { moveInInstructions: "B", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
        { moveInInstructions: "C", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
        { moveInInstructions: "D", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
      ],
    };
    expect(reconcileRoomResidentMoveIn(room).moveInResidentDetails?.map((r) => r.moveInInstructions)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});
