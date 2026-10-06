// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
  localStorage.clear();
});


// studio-redesign standard (ui-page-structure.md § Reference implementations): a pick is a
// FieldSingleSelect dropdown, never a native <select>. The view switch is a listbox button.
const viewButton = () => screen.getByRole("button", { name: "Calendar view" });
const viewValue = () => viewButton().textContent?.trim().toLowerCase();
function pickView(value: string) {
  if (viewButton().getAttribute("aria-expanded") !== "true") fireEvent.click(viewButton());
  const option = within(screen.getByRole("listbox")).getByText(value[0]!.toUpperCase() + value.slice(1));
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
}

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
  it("renders every property even with zero bookings; a single-row property is one row under its own name", () => {
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
    // A title-less listing never shows its raw id.
    expect(screen.queryByText("prop-b")).toBeNull();
    expect(screen.getByText("Untitled listing")).toBeTruthy();
    // A single bookable row folds into the property's own row: its unit name is a subline.
    expect(screen.getByText("Room 1")).toBeTruthy();
    // prop-b has no declared rooms and no bookings — it is one row, not a property strip
    // above a repeated "Whole home" row.
    expect(screen.queryByText("Whole home")).toBeNull();
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

    const bar = document.querySelector('[data-attr="bookings-calendar-bar"]');
    expect(bar).toBeTruthy();
    expect(bar?.className).toContain("bg-[#3d7d46]");
  });

  it("carries the occupancy figures on Calendar: staying, check-ins, check-outs and 'n of N occupied'", () => {
    render(
      <BookingsPortfolioTimeline
        propertyIds={["prop-a"]}
        entries={[bookingEntry({ start: TODAY_KEY, end: TODAY_KEY })]}
        today={TODAY}
        onOpenDay={() => {}}
      />,
    );
    pickView("day");
    const summary = document.querySelector('[data-attr="bookings-calendar-summary"]')!.textContent!;
    expect(summary).toContain("1 staying");
    expect(summary).toContain("1 check-ins");
    expect(summary).toContain("1 of 1 occupied · 100%");
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
    expect(viewButton()).toBeTruthy();
  });
  it("keeps empty room rows while changing to year and drilling into a month", () => {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[]} today={TODAY} />);
    pickView("year");
    expect(screen.getByText("Room 1")).toBeTruthy();
    expect(screen.getByText("No bookings in this range")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Room 1 · February: 0% occupied"));
    expect(viewValue()).toBe("month");
    expect(screen.getByText("February 2026")).toBeTruthy();
  });

  it("defaults a phone to Week and remembers the page's chosen view", () => {
    const prior = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const mounted = render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[]} today={TODAY} preferenceKey="phone-test" />);
    expect(viewValue()).toBe("week");
    pickView("day");
    mounted.unmount();
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[]} today={TODAY} preferenceKey="phone-test" />);
    expect(viewValue()).toBe("day");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: prior });
  });
  it("Day keeps checkout and arrival together with real night labels", () => {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[
      bookingEntry({ start: "2026-09-08", end: "2026-09-09", summary: "Leaving" }),
      bookingEntry({ start: "2026-09-10", end: "2026-09-13", summary: "Arriving" }),
    ]} today={TODAY} />);
    pickView("day");
    expect(screen.getByText("Checks out today")).toBeTruthy();
    expect(screen.getByText("Checks in today")).toBeTruthy();
    expect(screen.getByText("1 staying · 1 check-ins · 1 check-outs")).toBeTruthy();
  });

  it("omits cancelled stays from every calendar view and preserves empty rooms", () => {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[bookingEntry({ bookingStatus: "cancelled" })]} today={TODAY} />);
    for (const value of ["day", "week", "month", "year"]) {
      pickView(value);
      expect(document.querySelector('[data-attr="bookings-calendar-bar"]')).toBeNull();
      expect(screen.getByText("No bookings in this range")).toBeTruthy();
      expect(screen.getByText("Room 1")).toBeTruthy();
    }
  });
  it("does not leak a workspace preference into a property's page", () => {
    const mounted = render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[]} today={TODAY} preferenceKey="workspace" />);
    pickView("year");
    mounted.rerender(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[]} today={TODAY} preferenceKey="property:prop-a" />);
    expect(viewValue()).toBe("month");
  });

});
