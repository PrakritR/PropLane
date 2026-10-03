// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import { bookingRecordHref } from "@/lib/portal-detail-routes";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerBookingsListView } from "@/components/portal/manager-bookings-list-view";
import { BookingsRecordPage } from "@/components/portal/bookings-record-page";

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

const noop = async () => {};

const block: PropertyBookingEntry = {
  source: "block",
  propertyId: "h1",
  propertyLabel: "4709A 8th Ave NE",
  roomId: "room-9",
  roomLabel: "Room 9",
  summary: "Prakrit",
  start: "2026-09-01",
  end: "2026-09-05",
  statusLabel: "Held",
  blockId: "block-1",
  residentName: "Prakrit",
};

describe("booking record and actions", () => {
  const page = (entry = block) => render(<AppUiProvider><BookingsRecordPage bookingId={bookingEntryKey(entry)} basePath="/portal" entries={[entry]} loading={false} residentOptions={[]} onSaveBlock={noop} onRemoveBlock={noop} showToast={() => {}} /></AppUiProvider>);
  it("keeps Overview and Communication with Guest and Stay cards", () => {
    page();
    expect(within(screen.getByRole("navigation", { name: "Booking sections" })).getAllByRole("link").map((link) => link.textContent)).toEqual(["Overview", "Communication"]);
    expect(screen.getByRole("heading", { name: "Guest" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Stay" })).toBeTruthy();
  });
  it("opens the unified editor for a manual booking", () => {
    page();
    fireEvent.click(document.querySelector('[data-attr="record-header-action-edit"]')!);
    expect(document.querySelector('[data-attr="bookings-edit-sheet"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save booking" })).toBeTruthy();
  });
  it("shows a locked editor for a lease", () => {
    page({ ...block, source: "proplane", blockId: undefined, leaseId: "lease-1" });
    fireEvent.click(document.querySelector('[data-attr="record-header-action-edit"]')!);
    expect(document.querySelector('[data-attr="bookings-edit-sheet"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save booking" })).toBeNull();
  });
  it("keeps channel records read-only and identifies a calendar UID honestly", () => {
    page({ ...block, source: "airbnb", blockId: undefined, sourceUid: "event-uid" });
    expect(document.querySelector('[data-attr="record-header-action-edit"]')).toBeNull();
    expect(screen.getByText("Calendar event")).toBeTruthy();
    expect(screen.getByText("event-uid")).toBeTruthy();
  });
  it("list View opens the same stable record route", () => {
    render(<ManagerBookingsListView entries={[block]} bucket="upcoming" selectedKeys={new Set()} onToggleSelected={() => {}} />);
    fireEvent.click(screen.getByText("Prakrit"));
    expect(navigate).toHaveBeenCalledWith(bookingRecordHref("/portal", bookingEntryKey(block)));
  });
});
