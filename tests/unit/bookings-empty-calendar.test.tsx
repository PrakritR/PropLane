// @vitest-environment node
//
// PLAN-0917-1236 — Bookings still paints the month grid with no houses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("Bookings empty calendar", () => {
  it("keeps the month grid when there are no houses and skips the Airbnb fetch", () => {
    const calendar = src("src/components/portal/pro-portfolio-bookings-calendar.tsx");
    expect(calendar).not.toContain("No houses in your portfolio yet. List a property, then link rooms with Link Airbnb.");
    expect(calendar).toContain("emptyPortfolio");
    expect(calendar).toContain('data-attr="bookings-empty-houses-banner"');
    expect(calendar).toContain("if (fetchPropertyIds.length === 0)");
    expect(calendar).toContain("setAirbnbEntries([])");
  });

  it("ranks Booking.com imports with other channel stays on the year grid", () => {
    const calendar = src("src/components/portal/pro-portfolio-bookings-calendar.tsx");
    expect(calendar).toContain('["proplane", "airbnb", "booking_com", "hold", "block"]');
  });
});
