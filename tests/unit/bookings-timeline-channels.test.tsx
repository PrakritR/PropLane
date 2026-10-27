// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: () => undefined,
    getRoomOptionsForProperty: (propertyId: string) => (propertyId === "prop-a" ? [{ value: "prop-a::room-1", label: "Room 1" }, { value: "prop-a::room-2", label: "Room 2" }] : []),
  };
});

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

import { BookingsCalendarLegend, BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { closureBarLabel, isLongChannelClosure, roomHasClash } from "@/components/portal/bookings-timeline-layout";
import { calendarStatusClass } from "@/lib/channel-calendar/bookings-calendar-view";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const TODAY = new Date(2026, 8, 10);

function entry(over: Partial<PropertyBookingEntry>): PropertyBookingEntry {
  return { source: "block", propertyId: "prop-a", propertyLabel: "Prop A House", roomId: "room-1", roomLabel: "Room 1", summary: "Alex", start: "2026-09-12", end: "2026-09-15", ...over };
}

function renderEntries(entries: PropertyBookingEntry[]) {
  return render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={entries} today={TODAY} onOpenDay={() => {}} />);
}

const bars = () => Array.from(document.querySelectorAll('[data-attr="bookings-calendar-bar"]')) as HTMLElement[];
const visual = (bar: HTMLElement) => bar.querySelector("[data-bar-visual]") as HTMLElement;

describe("channel colours and the legend", () => {
  it("the legend names Airbnb, Booking.com and PadSplit with colours of their own, and the hatch for a closed channel", () => {
    render(<BookingsCalendarLegend />);
    const legend = document.querySelector('[data-attr="bookings-calendar-legend"]')!;
    for (const name of ["Airbnb", "Booking.com", "PadSplit", "Closed on a channel"]) expect(legend.textContent).toContain(name);
    expect(new Set(["Airbnb", "Booking.com", "PadSplit"].map(calendarStatusClass)).size).toBe(3);
  });

  it("a Booking.com stay, a PadSplit stay and a stay linked to Airbnb each draw in their channel's colour with a mark", () => {
    renderEntries([
      entry({ source: "booking_com", summary: "CLOSED - Not available", sourceUid: "u1", connectionId: "c1", roomId: "room-1" }),
      entry({ summary: "Jordan", residentName: "Jordan", blockId: "b1", stayDetails: { source: "PadSplit" }, roomId: "room-2" }),
      entry({ summary: "Kumaran", residentName: "Kumaran", blockId: "b2", channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" }, roomId: "room-2", start: "2026-09-20", end: "2026-09-23" }),
    ]);
    const drawn = bars().map((bar) => ({ cls: visual(bar).className, mark: bar.querySelector('[role="img"]')?.getAttribute("aria-label") }));
    expect(drawn[0]!.cls).toContain("bg-[#003b95]");
    expect(drawn[0]!.mark).toBe("Booking.com");
    expect(drawn.some((d) => d.cls.includes("bg-[#6b3fa0]") && d.mark === "PadSplit")).toBe(true);
    expect(drawn.some((d) => d.cls.includes("bg-[#9a4b1a]") && d.mark === "Airbnb")).toBe(true);
    // The linked stay carries the guest's name, not the channel's "Reserved".
    expect(bars().some((bar) => bar.textContent?.includes("Kumaran"))).toBe(true);
  });
});

describe("a channel's standing closure", () => {
  const closure = (over: Partial<PropertyBookingEntry> = {}) => entry({ source: "airbnb", summary: "Airbnb (Not available)", start: "2026-09-05", end: "2027-10-26", sourceUid: "host", connectionId: "c1", ...over });

  it("longer than 60 nights is a hatched 'Closed on Airbnb · until <date>' bar, not a guest", () => {
    expect(isLongChannelClosure(closure())).toBe(true);
    expect(closureBarLabel(closure())).toBe("Closed on Airbnb · until Oct 27, 2027");
    renderEntries([closure()]);
    const [bar] = bars();
    expect(bar!.textContent).toContain("Closed on Airbnb · until Oct 27, 2027");
    expect(visual(bar!).style.backgroundImage).toContain("repeating-linear-gradient");
    expect(visual(bar!).className).not.toContain("bg-[#9a4b1a]");
    expect(bar!.querySelector('[role="img"]')).toBeNull();
  });

  it("a short Airbnb block, or a reservation of any length, keeps its ordinary look", () => {
    expect(isLongChannelClosure(closure({ end: "2026-09-20" }))).toBe(false);
    expect(isLongChannelClosure(closure({ summary: "Reserved" }))).toBe(false);
    // Sep 5 through Nov 3 is exactly 60 nights; one more tips it over.
    expect(isLongChannelClosure(closure({ end: "2026-11-03" }))).toBe(false);
    expect(isLongChannelClosure(closure({ end: "2026-11-04" }))).toBe(true);
    renderEntries([closure({ end: "2026-09-20" })]);
    expect(visual(bars()[0]!).style.backgroundImage).toBe("");
  });
});

describe("a double booking is easy to find", () => {
  it("a room with two stays on the same nights shows a red dot by its name; a clean room shows none", () => {
    renderEntries([
      entry({ source: "airbnb", summary: "Reserved", sourceUid: "a", connectionId: "c1", roomId: "room-1", start: "2026-09-12", end: "2026-09-16" }),
      entry({ source: "booking_com", summary: "CLOSED - Not available", sourceUid: "b", connectionId: "c2", roomId: "room-1", start: "2026-09-14", end: "2026-09-18" }),
      entry({ roomId: "room-2", residentName: "Sam", blockId: "b3", start: "2026-09-12", end: "2026-09-14" }),
    ]);
    const dots = Array.from(document.querySelectorAll('[data-attr="bookings-room-clash"]'));
    expect(dots).toHaveLength(1);
    expect(dots[0]!.closest("[data-room-row]")?.textContent).toContain("Room 1");
    expect(roomHasClash({ bars: [{ conflict: false }, { conflict: true }] as never })).toBe(true);
  });
});

describe("a block with no end", () => {
  it("says where it starts and carries a 'no end' tag", () => {
    renderEntries([entry({ summary: "Blocked", residentName: undefined, openEnded: true, blockId: "b9", start: "2026-09-12", end: "2028-09-12" })]);
    const [bar] = bars();
    expect(bar!.textContent).toContain("Blocked · from Sep 12");
    expect(bar!.querySelector('[data-attr="bookings-bar-no-end"]')?.textContent).toBe("no end");
  });

  it("a named open-ended stay keeps its name and still shows the tag; a lease with no end does not", () => {
    renderEntries([
      entry({ summary: "Pat", residentName: "Pat", openEnded: true, blockId: "b8", roomId: "room-1", end: "2028-09-12" }),
      entry({ source: "proplane", summary: "Resident", openEnded: true, roomId: "room-2", end: "2028-09-12" }),
    ]);
    const [named, lease] = bars();
    expect(named!.textContent).toContain("Pat");
    expect(named!.querySelector('[data-attr="bookings-bar-no-end"]')).not.toBeNull();
    expect(lease!.querySelector('[data-attr="bookings-bar-no-end"]')).toBeNull();
  });
});
