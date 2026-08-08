import { describe, expect, it } from "vitest";
import { dateKeyInBookingRange } from "@/lib/channel-calendar/bookings-dates";

describe("dateKeyInBookingRange", () => {
  it("matches inclusive YYYY-MM-DD ranges", () => {
    expect(dateKeyInBookingRange("2026-08-10", "2026-08-08", "2026-08-12")).toBe(true);
    expect(dateKeyInBookingRange("2026-08-07", "2026-08-08", "2026-08-12")).toBe(false);
    expect(dateKeyInBookingRange("2026-08-13", "2026-08-08", "2026-08-12")).toBe(false);
  });

  it("treats a missing end as the start date", () => {
    expect(dateKeyInBookingRange("2026-08-08", "2026-08-08", "")).toBe(true);
    expect(dateKeyInBookingRange("2026-08-09", "2026-08-08", "")).toBe(false);
  });
});
