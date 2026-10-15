// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { BookingsRecordPage } from "@/components/portal/bookings-record-page";

afterEach(() => cleanup());

const noop = async () => {};
const airbnb: PropertyBookingEntry = {
  source: "airbnb",
  propertyId: "h1",
  propertyLabel: "5259 Brooklyn Ave",
  roomId: "room-1",
  roomLabel: "Room 1",
  summary: "Reserved",
  start: "2026-10-09",
  end: "2026-10-12",
  connectionId: "c1",
  sourceUid: "1418fb94@airbnb.com",
  reservationCode: "HM8F9S4DWC",
};

function page(entry: PropertyBookingEntry) {
  return render(
    <AppUiProvider>
      <BookingsRecordPage bookingId={bookingEntryKey(entry)} basePath="/portal" entries={[entry]} loading={false} residentOptions={[]} onSaveBlock={noop} onRemoveBlock={noop} showToast={() => {}} />
    </AppUiProvider>,
  );
}

describe("booking record header for a channel stay", () => {
  it("shows Message, Open in Airbnb and a Remove from PropLane icon, with no ⋯", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    page(airbnb);
    expect(document.querySelector('[data-attr="record-header-action-message"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="record-actions-trigger"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Remove from PropLane" }).getAttribute("data-slot")).toBe("portal-icon-action");
    fireEvent.click(screen.getByRole("button", { name: "Open in Airbnb" }));
    expect(open).toHaveBeenCalledWith("https://www.airbnb.com/hosting/reservations/details/HM8F9S4DWC", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("offers no Open in Airbnb without a parsed code", () => {
    page({ ...airbnb, reservationCode: undefined });
    expect(screen.queryByRole("button", { name: "Open in Airbnb" })).toBeNull();
  });
});

describe("booking record header for a marked reservation", () => {
  const reserved: PropertyBookingEntry = {
    source: "block",
    propertyId: "h1",
    propertyLabel: "4709A 8th Ave",
    roomId: "room-9",
    roomLabel: "Room 9",
    summary: "Reserved",
    start: "2020-01-01",
    end: "2020-01-03",
    blockId: "block-1",
  };
  it("offers Delete at any date, even a past one", () => {
    page(reserved);
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
