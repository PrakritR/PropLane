import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/manager-listing-submission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-listing-submission")>()),
  normalizeManagerListingSubmissionV1: (sub: unknown) => sub,
}));
vi.mock("@/lib/room-pricing", () => ({ roomMonthlyEquivalentLabel: () => "$1,000/mo" }));

import { parseTourSlotKey, tourRoomParamForKey, tourSchedulePath } from "@/lib/tour-schedule-link";
import { defaultTourRoomKey } from "@/components/marketing/tour-schedule-flow";
import type { MockProperty } from "@/data/types";

describe("tour schedule link", () => {
  it("parses only well-formed Pacific slot keys", () => {
    expect(parseTourSlotKey("2026-11-04:20")).toMatchObject({ dateStr: "2026-11-04", year: 2026, month: 10, day: 4, slotIndex: 20 });
    for (const bad of ["", null, undefined, "2026-11-04", "2026-13-04:20", "2026-02-31:1", "x:20", "2026-11-04:20; drop", "//evil.example:1"]) {
      expect(parseTourSlotKey(bad as string)).toBeNull();
    }
  });

  it("builds a fixed same-origin path with the pick preselected", () => {
    const url = new URL(tourSchedulePath({ propertyId: "mgr-1", slotKey: "2026-11-04:20", roomParam: "room-7" }), "http://x");
    expect(url.pathname).toBe("/resident/tour/schedule");
    expect(Object.fromEntries(url.searchParams)).toEqual({ propertyId: "mgr-1", slot: "2026-11-04:20", room: "room-7" });
  });

  it("drops a bad slot instead of carrying it, and defaults the room to any", () => {
    expect(tourSchedulePath({ propertyId: "mgr-1", slotKey: "nope" })).toBe("/resident/tour/schedule?propertyId=mgr-1");
    expect(tourSchedulePath({ propertyId: "mgr-1", slotKey: "2026-11-04:20" })).toContain("room=any");
  });

  it("maps a room key to the url param", () => {
    expect(tourRoomParamForKey("p1", "p1::r2")).toBe("r2");
    expect(tourRoomParamForKey("p1", "__tour-room-undecided__")).toBe("any");
    expect(tourRoomParamForKey("p1", null)).toBe("any");
  });

  it("never forces a room: several rooms default to not-sure-yet, a url room is honoured, one room is that room", () => {
    const base = { id: "p1", title: "Home", buildingName: "B", unitLabel: "U", neighborhood: "N", rentLabel: "$1" } as unknown as MockProperty;
    const multi = {
      ...base,
      listingSubmission: { v: 1, rooms: [{ id: "r1", name: "Room 1", floor: "" }, { id: "r2", name: "Room 2", floor: "" }] },
    } as unknown as MockProperty;
    expect(defaultTourRoomKey(multi)).toBe("__tour-room-undecided__");
    expect(defaultTourRoomKey(multi, "any")).toBe("__tour-room-undecided__");
    expect(defaultTourRoomKey(multi, "r2")).toBe("p1::r2");
    expect(defaultTourRoomKey(multi, "ghost")).toBe("__tour-room-undecided__");
    expect(defaultTourRoomKey(base)).toBe("p1");
  });
});
