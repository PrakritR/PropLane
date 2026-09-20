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

describe("booking list row opens the record page, ⋯ in canonical order", () => {
  it("clicking the row navigates to the booking's own record page", () => {
    render(
      <ManagerBookingsListView
        entries={[block]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
        onEditBlock={() => {}}
        onDeleteBlock={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Prakrit"));
    expect(navigate).toHaveBeenCalledWith(bookingRecordHref("/portal", bookingEntryKey(block)));
  });

  it("⋯ lists Edit dates, Move room, Message, Copy link, then Cancel in red — never a generic 'Edit'", () => {
    render(
      <ManagerBookingsListView
        entries={[block]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
        onEditBlock={() => {}}
        onDeleteBlock={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Prakrit" }), { key: "ArrowDown" });
    const menu = document.body.querySelector('[data-attr="record-actions-menu"]')!;
    const labels = [...menu.querySelectorAll("[data-attr^='bookings-row-']")].map((el) => el.textContent);
    expect(labels).toEqual(["Edit dates", "Move room", "Message Prakrit", "Copy link", "Cancel booking"]);
    // Cancel is the one danger-toned action, and it comes last.
    const cancelIndex = labels.indexOf("Cancel booking");
    expect(cancelIndex).toBe(labels.length - 1);
  });
});

describe("booking record page", () => {
  const noop = async () => {};

  it("the rail has the six sections and the header icons match the registry (record payment dropped)", () => {
    render(
      <AppUiProvider>
        <BookingsRecordPage
          bookingId={bookingEntryKey(block)}
          basePath="/portal"
          entries={[block]}
          loading={false}
          residentOptions={[]}
          onSaveBlock={noop}
          onRemoveBlock={noop}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );

    const rail = screen.getByRole("navigation", { name: "Booking sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "Guest",
      "Charges",
      "Communication",
      "Documents",
      "Activity",
    ]);

    expect(document.querySelector('[data-attr="record-header-action-edit-dates"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-move-room"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-cancel"]')).not.toBeNull();
    // Never a dead "Record payment" — no booking has a verified charge path yet.
    expect(document.querySelector('[data-attr="record-header-action-record-payment"]')).toBeNull();
  });

  it("Edit dates opens a sheet for a block-sourced booking", () => {
    render(
      <AppUiProvider>
        <BookingsRecordPage
          bookingId={bookingEntryKey(block)}
          basePath="/portal"
          entries={[block]}
          loading={false}
          residentOptions={[]}
          onSaveBlock={noop}
          onRemoveBlock={noop}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    fireEvent.click(document.querySelector('[data-attr="record-header-action-edit-dates"]')!);
    expect(document.querySelector('[data-attr="bookings-edit-dates-sheet"]')).not.toBeNull();
  });

  it("shows 'Booking not found' for an id that resolves to nothing", () => {
    render(
      <AppUiProvider>
        <BookingsRecordPage
          bookingId="does-not-exist"
          basePath="/portal"
          entries={[block]}
          loading={false}
          residentOptions={[]}
          onSaveBlock={noop}
          onRemoveBlock={noop}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    expect(screen.getByText("Booking not found.")).toBeTruthy();
  });
});
