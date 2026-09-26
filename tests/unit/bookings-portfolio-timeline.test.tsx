// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Only the two entry points the component reads: a declared room list for
// "prop-a", nothing declared for "prop-b" (so it exercises the "no declared
// rooms, no bookings" → single placeholder row fallback). `getPropertyById`
// stays undefined for both, same as a property this catalog doesn't know
// about (mirrors the real Bookings evidence fixture).
vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: () => undefined,
    getRoomOptionsForProperty: (propertyId: string) =>
      propertyId === "prop-a" ? [{ value: "prop-a::room-1", label: "Room 1" }] : [],
  };
});

beforeAll(() => {
  // Pin the fine-pointer (desktop) shape — the same portal-surface decision
  // every popup in the app makes, forced the same way
  // `portal-dialog-shape.test.tsx` does — so the shared date-axis grid
  // renders instead of the phone stacked strip.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
});

afterEach(() => {
  cleanup();
});

import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDays, dateKey } from "@/lib/room-availability-calendar";

const TODAY = new Date(2026, 8, 10); // Sep 10, 2026 (local) — comfortably mid-window either side.
const TODAY_KEY = dateKey(TODAY);
const TODAY_OPEN_LABEL = `Open ${TODAY.toLocaleDateString("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
})}`;

function bookingEntry(overrides: Partial<PropertyBookingEntry> = {}): PropertyBookingEntry {
  return {
    source: "proplane",
    propertyId: "prop-a",
    propertyLabel: "Prop A House",
    roomId: "room-1",
    roomLabel: "Room 1",
    summary: "Jordan Smith",
    start: dateKey(addDays(TODAY, 1)),
    end: dateKey(addDays(TODAY, 2)),
    ...overrides,
  };
}

describe("BookingsPortfolioTimeline", () => {
  it("groups every property under its own header with its rooms beneath, even with zero bookings", () => {
    render(
      <BookingsPortfolioTimeline
        propertyIds={["prop-a", "prop-b"]}
        entries={[bookingEntry()]}
        today={TODAY}
        onOpenDay={() => {}}
      />,
    );

    expect(document.querySelector('[data-attr="bookings-timeline-property-prop-a"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="bookings-timeline-property-prop-b"]')).toBeTruthy();
    expect(screen.getByText("Prop A House")).toBeTruthy();
    expect(screen.getByText("prop-b")).toBeTruthy();
    expect(screen.getByText("Room 1")).toBeTruthy();
    // prop-b has no declared rooms and no bookings — it still renders a room row.
    expect(screen.getByText("Whole home")).toBeTruthy();
  });

  it("renders a booking inside the visible window as a bar with the right source styling", () => {
    render(
      <BookingsPortfolioTimeline
        propertyIds={["prop-a"]}
        entries={[bookingEntry({ source: "proplane" })]}
        today={TODAY}
        onOpenDay={() => {}}
      />,
    );

    const bar = document.querySelector('[title*="Jordan Smith"]');
    expect(bar).toBeTruthy();
    expect(bar?.className).toContain("bg-primary");
  });

  it("calls onOpenDay with the clicked date's key", () => {
    const onOpenDay = vi.fn();
    render(
      <BookingsPortfolioTimeline
        propertyIds={["prop-a"]}
        entries={[bookingEntry()]}
        today={TODAY}
        onOpenDay={onOpenDay}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: TODAY_OPEN_LABEL }));
    expect(onOpenDay).toHaveBeenCalledWith(TODAY_KEY);
  });

  it("shows the empty-portfolio banner when there are no properties", () => {
    render(
      <BookingsPortfolioTimeline propertyIds={[]} entries={[]} today={TODAY} onOpenDay={() => {}} />,
    );

    expect(document.querySelector('[data-attr="bookings-empty-houses-banner"]')).toBeTruthy();
    expect(screen.getByText("No houses yet")).toBeTruthy();
    expect(screen.getByText("Add property")).toBeTruthy();
  });
});
