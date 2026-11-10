import { describe, expect, it } from "vitest";
import { countRoomsAvailableNow } from "@/lib/public-listing-available-count";
import { listingAvailabilityCounts } from "@/lib/tools/domains/leasing-sms";

const room = (id: string, publishedAvailability: string | null = "Available now", residentCapacity = 1) => ({ id, publishedAvailability, residentCapacity });
const span = { start: "2020-01-01", end: null };

describe("listingAvailabilityCounts", () => {
  const rooms = [room("r1"), room("r2"), room("r3", "Leased")];
  const occupancy = [{ roomChoice: "p1::r1", spans: [span] }] as never;

  it("returns the listing page's own count (countRoomsAvailableNow) and the room total", () => {
    const today = "2026-11-10";
    const page = countRoomsAvailableNow(
      rooms.map((r) => ({ id: r.id, availability: r.publishedAvailability ?? "", occupancyCapacity: r.residentCapacity })),
      occupancy,
      today,
      "p1",
    );
    expect(listingAvailabilityCounts("p1", rooms, occupancy, today)).toEqual({ roomCount: 3, availableNowCount: page });
    expect(page).toBe(1);
  });

  it("is unknown, never a number, when the occupancy read failed", () => {
    expect(listingAvailabilityCounts("p1", rooms, null, "2026-11-10")).toEqual({ roomCount: 3, availableNowCount: null });
  });
});
