import { describe, expect, it } from "vitest";
import { bookingGuestLabel, bookingGuestShortLabel } from "@/lib/channel-calendar/booking-guest-label";

describe("bookingGuestLabel", () => {
  it("maps generic Airbnb summaries to a friendly booked label", () => {
    expect(bookingGuestLabel("Reserved")).toBe("Booked (Airbnb)");
    expect(bookingGuestLabel("not available")).toBe("Booked (Airbnb)");
  });

  it("keeps guest names from Airbnb", () => {
    expect(bookingGuestLabel("Alex M.")).toBe("Alex M.");
  });

  it("truncates short cell labels", () => {
    expect(bookingGuestShortLabel("Christopher", 8)).toBe("Christo…");
  });
});
