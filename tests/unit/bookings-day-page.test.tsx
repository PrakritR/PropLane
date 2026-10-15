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
        onDeleteBlock={() => {}}
        showToast={() => {}}
      />,
    );
    expect(document.querySelector('[data-attr="bookings-day-detail-modal"]')).toBeTruthy();
    expect(screen.queryByText("Ask PropLane")).toBeNull();
    expect(document.body.textContent).not.toContain("Ask PropLane");
  });

  it("names the weekday and leads the summary with beds occupied (matches month cell)", () => {
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
        onDeleteBlock={() => {}}
        showToast={() => {}}
      />,
    );
    expect(screen.getByText("Tuesday, September 1")).toBeTruthy();
    const summary = document.querySelector('[data-attr="bookings-day-summary"]');
    expect(summary?.textContent).toMatch(/\d+ of \d+ beds occupied/);
    expect(summary?.textContent).toContain("2 check-ins");
    expect(summary?.textContent).not.toContain("bookings");
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
        onDeleteBlock={() => {}}
        showToast={() => {}}
      />,
    );
    const brooklynGroup = document.querySelector('[data-attr="bookings-day-group-p1"]') as HTMLElement;
    expect(within(brooklynGroup).getByText("5257 Brooklyn Ave")).toBeTruthy();
    expect(brooklynGroup.textContent).toContain("Ada Lovelace");
    // Place line carries property · room on each stay row (PLAN-0923-1737).
    expect(brooklynGroup.textContent).toContain("Room 1");
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
        onDeleteBlock={() => {}}
        showToast={() => {}}
      />,
    );
    expect(document.querySelector('[data-attr="bookings-day-detail-modal"]')).toBeTruthy();
    fireEvent.click(screen.getByText("Ada Lovelace"));
    expect(navigate).toHaveBeenCalledWith(bookingRecordHref("/portal", bookingEntryKey(brooklyn)));
  });

  it("a channel Not available block gets the lock tile and no Message; a channel Reserved guest stay keeps a guest tile and Message", () => {
    const airbnbBase: PropertyBookingEntry = { ...brooklyn, source: "airbnb", propertyId: "p1", connectionId: "c1", sourceUid: "u1" };
    const notAvailable: PropertyBookingEntry = { ...airbnbBase, roomId: "r3", roomLabel: "Room 3", summary: "Airbnb (Not available)", sourceUid: "u-block" };
    const guest: PropertyBookingEntry = { ...airbnbBase, roomId: "r4", roomLabel: "Room 4", summary: "Reserved", sourceUid: "u-guest" };
    render(
      <BookingsDayPage
        dayKey="2026-09-01"
        basePath="/portal"
        entries={[notAvailable, guest]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        onDeleteBlock={() => {}}
        showToast={() => {}}
      />,
    );
    const rowFor = (entry: PropertyBookingEntry) =>
      document.querySelector(`[data-attr="bookings-day-row-${bookingEntryKey(entry)}"]`)!.closest("[data-record-row]") as HTMLElement;
    const blockRow = rowFor(notAvailable);
    const guestRow = rowFor(guest);
    expect(blockRow.textContent).toContain("Airbnb · Not available");
    expect(blockRow.querySelector('[data-slot="portal-row-glyph-tile"]')).toBeTruthy();
    expect(guestRow.textContent).toContain("Airbnb · Reserved");
    expect(guestRow.querySelector('[data-slot="portal-row-glyph-tile"]')).toBeNull();

    fireEvent.keyDown(within(blockRow).getByRole("button", { name: /^Actions for / }), { key: "ArrowDown" });
    expect(screen.queryByRole("menuitem", { name: "Message" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    cleanup();
  });
});
