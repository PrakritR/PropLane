import { describe, expect, it } from "vitest";
import {
  countWord,
  moveInFactTexts,
  roomAvailabilityText,
  roomResidentsBedsText,
} from "@/lib/property-record-row-facts";

/** studio-redesign(property-tabs): the one fact line on a record row. */
describe("property record row facts", () => {
  it("countWord pluralises", () => {
    expect(countWord(1, "photo")).toBe("1 photo");
    expect(countWord(0, "photo")).toBe("0 photos");
    expect(countWord(3, "room")).toBe("3 rooms");
  });

  it("residents and beds: beds only when the manager stated them", () => {
    expect(roomResidentsBedsText({ occupancyCapacity: 1 })).toBe("1 resident");
    expect(roomResidentsBedsText({})).toBe("1 resident");
    expect(roomResidentsBedsText({ occupancyCapacity: 4, bedCount: 4 })).toBe("4 residents · 4 beds");
    expect(roomResidentsBedsText({ occupancyCapacity: 2, bedCount: 1 })).toBe("2 residents · 1 bed");
    // never guessed from capacity
    expect(roomResidentsBedsText({ occupancyCapacity: 3 })).toBe("3 residents");
  });

  it("availability: free now, free from a date, occupied", () => {
    const today = "2026-10-03";
    expect(roomAvailabilityText({ manualUnavailableRanges: [], moveInAvailableDate: "" }, today)).toBe("Available now");
    expect(
      roomAvailabilityText({ manualUnavailableRanges: [], moveInAvailableDate: "2026-11-01" }, today),
    ).toBe("Available from Nov 1, 2026");
    expect(
      roomAvailabilityText(
        { manualUnavailableRanges: [{ id: "r1", start: "2026-09-01", end: null }], moveInAvailableDate: "" },
        today,
      ),
    ).toBe("Occupied");
    expect(
      roomAvailabilityText(
        { manualUnavailableRanges: [{ id: "r1", start: "2026-09-01", end: "2026-10-31" }], moveInAvailableDate: "" },
        today,
      ),
    ).toBe("Available from Nov 1, 2026");
  });

  it("move-in facts say what exists", () => {
    expect(moveInFactTexts({ instructions: "", photoCount: 0, hasVideo: false })).toEqual({
      instructions: "No instructions yet",
      photos: "0 photos",
      video: "No video",
    });
    expect(moveInFactTexts({ instructions: "  Lockbox  ", photoCount: 1, hasVideo: true })).toEqual({
      instructions: "Instructions written",
      photos: "1 photo",
      video: "Video added",
    });
  });
});
