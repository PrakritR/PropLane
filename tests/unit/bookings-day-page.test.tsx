// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import { bookingRecordHref } from "@/lib/portal-detail-routes";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));

import { BookingsDayPage } from "@/components/portal/bookings-day-page";

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

const brooklyn: PropertyBookingEntry = {
  source: "proplane",
  propertyId: "p1",
  propertyLabel: "5257 Brooklyn Ave",
  roomId: "r1",
  roomLabel: "Room 1",
  summary: "Ada Lovelace",
  start: "2026-09-01",
  end: "2026-09-10",
  statusLabel: "Signed",
};

const ashFlats: PropertyBookingEntry = {
  source: "block",
  propertyId: "p2",
  propertyLabel: "Ash Flats 6",
  roomId: "r5",
  roomLabel: "Room 5",
  summary: "Prakrit",
  start: "2026-09-01",
  end: "2026-09-03",
  statusLabel: "Held",
  blockId: "block-1",
  residentName: "Prakrit",
};

const outsideDay: PropertyBookingEntry = {
  ...brooklyn,
  roomId: "r9",
  start: "2026-08-01",
  end: "2026-08-05",
};

const propertyOptions = [
  { id: "p1", label: "5257 Brooklyn Ave" },
  { id: "p2", label: "Ash Flats 6" },
];

describe("BookingsDayPage", () => {
  it("is a wizard PortalDialog over the calendar — no assistant chip", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-01"
        basePath="/portal"
        entries={[brooklyn, ashFlats, outsideDay]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    expect(document.querySelector('[data-attr="bookings-day-detail-modal"]')).toBeTruthy();
    expect(screen.queryByText("Ask PropLane")).toBeNull();
    expect(document.body.textContent).not.toContain("Ask PropLane");
  });

  it("names the weekday and shows the bookings / check-ins / occupancy summary line", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-01"
        basePath="/portal"
        entries={[brooklyn, ashFlats, outsideDay]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    expect(screen.getByText("Tuesday, September 1")).toBeTruthy();
    const summary = document.querySelector('[data-attr="bookings-day-summary"]');
    expect(summary?.textContent).toContain("2 bookings");
    expect(summary?.textContent).toContain("2 check-ins");
    expect(summary?.textContent).toContain("rooms occupied");
  });

  it("groups rows by property, each with its own occupied/rooms line", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-01"
        basePath="/portal"
        entries={[brooklyn, ashFlats, outsideDay]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    const brooklynGroup = document.querySelector('[data-attr="bookings-day-group-p1"]') as HTMLElement;
    expect(within(brooklynGroup).getByText("5257 Brooklyn Ave")).toBeTruthy();
    expect(brooklynGroup.textContent).toContain("Ada Lovelace");
    const ashGroup = document.querySelector('[data-attr="bookings-day-group-p2"]') as HTMLElement;
    expect(within(ashGroup).getByText("Ash Flats 6")).toBeTruthy();
    expect(ashGroup.textContent).toContain("Prakrit");
    // The August-only booking never appears on the September 1 page.
    expect(document.body.textContent).not.toContain("Aug 1");
  });

  it("a row opens the booking's own record page, never a second peek popup", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-01"
        basePath="/portal"
        entries={[brooklyn]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    expect(document.querySelector('[data-attr="bookings-day-detail-modal"]')).toBeTruthy();
    fireEvent.click(screen.getByText("Ada Lovelace · Room 1"));
    expect(navigate).toHaveBeenCalledWith(bookingRecordHref("/portal", bookingEntryKey(brooklyn)));
  });
});
