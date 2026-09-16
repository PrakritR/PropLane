// A room is available by default; occupied spans close it. The label renters
// see, the next free day, and the legacy "Available from" upgrade all derive
// from one function — these pin that derivation.
import { describe, expect, it } from "vitest";
import {
  deriveRoomAvailability,
  legacyMoveInDateAsSpan,
  manualRangesToSpans,
  roomAvailabilityPatch,
  spanEndsBeforeStart,
  spanOccupying,
  spansOverlap,
  type OccupiedSpan,
} from "@/lib/room-availability-timeline";
import { normalizeManagerListingSubmissionV1, createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const TODAY = "2026-09-15";
const manual = (start: string, end: string | null, id = `m-${start}`): OccupiedSpan => ({ id, start, end, source: "manual" });
const lease = (start: string, end: string | null): OccupiedSpan => ({ id: `lease-${start}`, start, end, source: "resident", label: "Resident" });

describe("deriveRoomAvailability", () => {
  it("reads Available now with no spans", () => {
    expect(deriveRoomAvailability([], TODAY)).toMatchObject({ occupiedNow: false, label: "Available now", availableFrom: "" });
  });

  it("reads Unavailable (occupied) when a span covering today has no end", () => {
    const r = deriveRoomAvailability([manual(TODAY, null)], TODAY);
    expect(r).toMatchObject({ occupiedNow: true, label: "Unavailable (occupied)", availableFrom: "" });
  });

  it("reads Available from the day after an occupied span that covers today", () => {
    const r = deriveRoomAvailability([manual("2026-09-01", "2026-10-31")], TODAY);
    expect(r.occupiedNow).toBe(true);
    expect(r.availableFrom).toBe("2026-11-01");
    expect(r.label).toBe("Available from November 1, 2026");
  });

  it("chains back-to-back spans into one free date", () => {
    const r = deriveRoomAvailability([manual("2026-09-01", "2026-10-31"), lease("2026-11-01", "2026-11-30")], TODAY);
    expect(r.availableFrom).toBe("2026-12-01");
  });

  it("reads Available now until the day before a future span", () => {
    const r = deriveRoomAvailability([lease("2026-10-01", "2027-03-31")], TODAY);
    expect(r).toMatchObject({ occupiedNow: false, availableFrom: "", label: "Available now until September 30, 2026" });
  });

  it("lets a booked span win over a typed one covering the same day", () => {
    const winner = spanOccupying([manual("2026-09-01", "2026-09-20"), lease("2026-09-10", "2027-03-31")], TODAY);
    expect(winner?.source).toBe("resident");
  });

  it("ignores a row whose End is before its Start", () => {
    const bad = manual("2026-09-20", "2026-09-10");
    expect(spanEndsBeforeStart(bad)).toBe(true);
    expect(deriveRoomAvailability([bad], TODAY).label).toBe("Available now");
  });

  it("treats an open end as running to the horizon when testing overlap", () => {
    expect(spansOverlap({ start: "2026-09-01", end: null }, { start: "2030-01-01", end: "2030-01-02" })).toBe(true);
    expect(spansOverlap({ start: "2026-09-01", end: "2026-09-02" }, { start: "2026-09-03", end: null })).toBe(false);
  });
});

describe("legacy and storage shape", () => {
  it("reads a future Available from as occupied until the day before", () => {
    expect(legacyMoveInDateAsSpan("2026-11-01", TODAY)).toMatchObject({ start: TODAY, end: "2026-10-31", source: "manual" });
    expect(legacyMoveInDateAsSpan("2026-09-01", TODAY)).toBeNull();
    expect(legacyMoveInDateAsSpan("", TODAY)).toBeNull();
  });

  it("marks Airbnb-imported ranges read-only by their id prefix", () => {
    const spans = manualRangesToSpans([
      { id: "channel-import-conn1-abc", start: "2026-10-01", end: "2026-10-05" },
      { id: "unavail-1", start: "2026-12-01", end: null },
    ]);
    expect(spans.map((s) => s.source)).toEqual(["channel", "manual"]);
    expect(spans[0]?.label).toBe("Airbnb");
  });

  it("writes the derived label and next free day beside the ranges", () => {
    const patch = roomAvailabilityPatch([{ id: "u1", start: "2026-09-01", end: "2026-10-31" }], [], TODAY);
    expect(patch.availability).toBe("Available from November 1, 2026");
    expect(patch.moveInAvailableDate).toBe("2026-11-01");
    expect(patch.manualUnavailableRanges).toHaveLength(1);
  });

  it("normalizes an empty end to null instead of dropping the row", () => {
    const sub = createDefaultListingSubmission();
    const room = sub.rooms[0]!;
    const normalized = normalizeManagerListingSubmissionV1({
      ...sub,
      rooms: [
        {
          ...room,
          manualUnavailableRanges: [
            { id: "open", start: "2026-09-15", end: "" as unknown as string },
            { id: "closed", start: "2026-10-01", end: "2026-10-31" },
            { id: "broken", start: "nope", end: "2026-10-31" },
          ],
        },
      ],
    });
    expect(normalized.rooms[0]!.manualUnavailableRanges).toEqual([
      { id: "open", start: "2026-09-15", end: null },
      { id: "closed", start: "2026-10-01", end: "2026-10-31" },
    ]);
  });
});
