import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  TOUR_ROOM_UNDECIDED_KEY,
  TOUR_ROOM_UNDECIDED_LABEL,
  isTourRoomUndecided,
  tourRoomAvailabilityMessage,
} from "@/components/marketing/tour-schedule-flow";

vi.mock("@/lib/rental-application/data", () => ({
  isRoomChoiceAvailable: vi.fn(),
  getRoomUnavailabilityWindows: vi.fn(),
}));

import {
  getRoomUnavailabilityWindows,
  isRoomChoiceAvailable,
} from "@/lib/rental-application/data";

describe("tour room selection", () => {
  beforeEach(() => {
    vi.mocked(isRoomChoiceAvailable).mockReset();
    vi.mocked(getRoomUnavailabilityWindows).mockReset();
  });

  it("recognizes the undecided sentinel key", () => {
    expect(isTourRoomUndecided(TOUR_ROOM_UNDECIDED_KEY)).toBe(true);
    expect(isTourRoomUndecided("prop::room-1")).toBe(false);
    expect(isTourRoomUndecided(null)).toBe(false);
  });

  it("exports a renter-facing undecided label", () => {
    expect(TOUR_ROOM_UNDECIDED_LABEL).toMatch(/not sure/i);
  });

  it("warns when the selected room is fully booked (PRP-398)", () => {
    vi.mocked(isRoomChoiceAvailable).mockReturnValue(false);
    vi.mocked(getRoomUnavailabilityWindows).mockReturnValue([
      {
        id: "resident-full-0",
        start: new Date("2030-01-01"),
        end: new Date("2030-06-01"),
        label: "Occupied Jan 1, 2030 to Jun 1, 2030",
        source: "resident",
      },
    ]);
    expect(tourRoomAvailabilityMessage("mgr-home::room-a")).toMatch(/not available/i);
    expect(tourRoomAvailabilityMessage("mgr-home::room-a")).toMatch(/Occupied Jan 1/);
    expect(tourRoomAvailabilityMessage(TOUR_ROOM_UNDECIDED_KEY)).toBeNull();
    expect(tourRoomAvailabilityMessage(null)).toBeNull();
  });

  it("stays quiet when the room is available", () => {
    vi.mocked(isRoomChoiceAvailable).mockReturnValue(true);
    expect(tourRoomAvailabilityMessage("mgr-home::room-a")).toBeNull();
  });
});
