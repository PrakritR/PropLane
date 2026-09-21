// @vitest-environment jsdom
/**
 * Upcoming (and In-house/Past) ⋯ → Edit must actually open the booking edit
 * sheet, prefilled — not just show the menu item (tests/unit/manager-bookings-list-view.test.tsx
 * only ever checked the menu's text, never that clicking it does anything).
 * The row itself still opens the booking record page (docs/agents/record-page.md).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import { bookingRecordHref } from "@/lib/portal-detail-routes";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));

import { ManagerBookingsListView } from "@/components/portal/manager-bookings-list-view";

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

const block: PropertyBookingEntry = {
  source: "block",
  propertyId: "h1",
  propertyLabel: "4709A 8th Ave NE",
  roomId: "r1",
  roomLabel: "Room 1",
  summary: "Alex Rivera",
  start: "2026-09-25",
  end: "2026-09-30",
  statusLabel: "Held",
  blockId: "block-1",
  reason: "",
  residentName: "Alex Rivera",
};

const stay: PropertyBookingEntry = {
  source: "proplane",
  propertyId: "h1",
  propertyLabel: "4709A 8th Ave NE",
  roomId: "r1",
  roomLabel: "Room 1",
  summary: "Ada Lovelace",
  start: "2026-09-20",
  end: "2026-09-30",
  statusLabel: "Signed",
  leaseId: "lease-1",
};

function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "ArrowDown" });
  return document.body.querySelector('[data-attr="record-actions-menu"]')!;
}

describe("Bookings Upcoming ⋯ → Edit", () => {
  it("a booking hold's Edit dates opens the edit sheet for THAT entry, prefilled", () => {
    const onEditBlock = vi.fn();
    render(
      <ManagerBookingsListView
        entries={[block]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
        onEditBlock={onEditBlock}
        onDeleteBlock={() => {}}
      />,
    );
    const menu = openMenu("Actions for Alex Rivera");
    const editButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Edit dates")!;
    expect(editButton).toBeTruthy();
    fireEvent.click(editButton);
    expect(onEditBlock).toHaveBeenCalledTimes(1);
    expect(onEditBlock).toHaveBeenCalledWith(block);
  });

  it("the row itself opens the record page — Edit never doubles as Open", () => {
    const onEditBlock = vi.fn();
    render(
      <ManagerBookingsListView
        entries={[block]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
        onEditBlock={onEditBlock}
        onDeleteBlock={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Alex Rivera"));
    expect(navigate).toHaveBeenCalledWith(bookingRecordHref("/portal", bookingEntryKey(block)));
    expect(onEditBlock).not.toHaveBeenCalled();
  });

  it("a signed-lease row's repurposed edit action jumps to the Lease record, not a no-op", () => {
    render(
      <ManagerBookingsListView
        entries={[stay]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
      />,
    );
    const menu = openMenu("Actions for Ada Lovelace");
    const openLeaseButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Open lease")!;
    expect(openLeaseButton).toBeTruthy();
    navigate.mockClear();
    fireEvent.click(openLeaseButton);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0]![0])).toContain("lease-1");
  });
});
