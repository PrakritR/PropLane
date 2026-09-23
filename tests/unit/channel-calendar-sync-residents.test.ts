import { describe, expect, it } from "vitest";
import {
  icalGuestStaysForResidents,
  icalStayHasEnded,
} from "@/lib/channel-calendar/airbnb-residents";

describe("ical guest stays for Current residents", () => {
  it("upserts a guest stay and skips Not available", () => {
    const stays = icalGuestStaysForResidents("conn-1", [
      { id: "g1", sourceUid: "uid-guest", summary: "Vedel", start: "2026-09-15", end: "2026-09-30" },
      { id: "b1", sourceUid: "uid-block", summary: "Not available", start: "2026-09-15", end: "2026-09-30" },
    ]);
    expect(stays).toEqual([
      {
        connectionId: "conn-1",
        sourceUid: "uid-guest",
        summary: "Vedel",
        start: "2026-09-15",
        end: "2026-09-30",
      },
    ]);
  });

  it("a second sync of the same connectionId + sourceUid is the same stay, not a clone", () => {
    const first = icalGuestStaysForResidents("conn-1", [
      { id: "g1", sourceUid: "uid-guest", summary: "Vedel", start: "2026-09-15", end: "2026-09-30" },
    ]);
    const second = icalGuestStaysForResidents("conn-1", [
      { id: "g1", sourceUid: "uid-guest", summary: "Vedel", start: "2026-09-15", end: "2026-10-02" },
    ]);
    expect(first[0]!.connectionId).toBe(second[0]!.connectionId);
    expect(first[0]!.sourceUid).toBe(second[0]!.sourceUid);
  });

  it("an ended stay is Past", () => {
    expect(icalStayHasEnded({ end: "2026-09-01" }, "2026-09-23")).toBe(true);
    expect(icalStayHasEnded({ end: "2026-09-30" }, "2026-09-23")).toBe(false);
  });
});
