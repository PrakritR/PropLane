// @vitest-environment jsdom
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
};

const block: PropertyBookingEntry = {
  source: "block",
  propertyId: "h1",
  propertyLabel: "4709A 8th Ave NE",
  roomId: "r1",
  roomLabel: "Room 1",
  summary: "Sep 20–22 hold",
  start: "2026-09-20",
  end: "2026-09-21",
  statusLabel: "Blocked",
  blockId: "block-1",
  reason: "Repairs",
};

describe("ManagerBookingsListView", () => {
  it("has no Blocked or View pills", () => {
    const view = render(
      <ManagerBookingsListView
        entries={[block, stay]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
        onEditBlock={() => {}}
        onDeleteBlock={() => {}}
      />,
    );

    expect(view.container.textContent).not.toMatch(/\bView\b/);
    expect(view.container.querySelector("[class*='badge']")).toBeNull();
    const blockedPills = [...view.container.querySelectorAll("*")].filter((el) => el.textContent === "Blocked");
    expect(blockedPills).toHaveLength(0);
  });

  it("row click opens the booking's own record page (never a day view)", () => {
    render(
      <ManagerBookingsListView
        entries={[stay]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Ada Lovelace"));
    expect(navigate).toHaveBeenCalledWith(bookingRecordHref("/portal", bookingEntryKey(stay)));
  });

  it("a block's ⋯ offers Edit dates, Move room and Cancel; a lease/import row only Message + Copy link", () => {
    render(
      <ManagerBookingsListView
        entries={[block, stay]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
        onEditBlock={() => {}}
        onDeleteBlock={() => {}}
      />,
    );

    const triggers = document.querySelectorAll('[data-attr="record-actions-trigger"]');
    expect(triggers.length).toBe(2);

    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Sep 20–22 hold" }), { key: "ArrowDown" });
    const blockMenu = document.body.querySelector('[data-attr="record-actions-menu"]')!;
    expect(blockMenu.textContent).toContain("Edit dates");
    expect(blockMenu.textContent).toContain("Move room");
    expect(blockMenu.textContent).toContain("Cancel booking");
    expect(blockMenu.textContent).not.toContain("View");
    expect(blockMenu.textContent).not.toContain("Blocked");
    fireEvent.keyDown(document.body, { key: "Escape" });

    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Ada Lovelace" }), { key: "ArrowDown" });
    const stayMenu = document.body.querySelector('[data-attr="record-actions-menu"]')!;
    expect(stayMenu.textContent).toContain("Message Ada Lovelace");
    expect(stayMenu.textContent).toContain("Copy link");
    expect(stayMenu.textContent).not.toContain("Edit dates");
    expect(stayMenu.textContent).not.toContain("Cancel booking");
  });

  it("is the Properties card: guest as title, stay · room · property, source and stage as plain facts", () => {
    const airbnb: PropertyBookingEntry = {
      ...stay,
      source: "airbnb",
      summary: "Airbnb guest",
      start: "2026-10-02",
      end: "2026-10-05",
      statusLabel: undefined,
    };
    const confirmed: PropertyBookingEntry = { ...stay, start: "2026-11-01", end: "2026-11-30", statusLabel: "Confirmed" };
    const view = render(
      <ManagerBookingsListView
        entries={[stay, airbnb, block, confirmed]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
      />,
    );

    const cards = view.container.querySelectorAll(".portal-property-row");
    expect(cards).toHaveLength(4);
    expect(view.container.querySelector("[class*='badge']")).toBeNull();

    const signed = cards[0]!;
    expect(signed.textContent).toContain("Ada Lovelace");
    expect(signed.textContent).toContain("Room 1");
    expect(signed.textContent).toContain("4709A 8th Ave NE");
    const signedFacts = signed.querySelector("[data-attr='record-row-facts']")!;
    expect(signedFacts.textContent).toContain("PropLane");
    expect(signed.querySelector("[data-attr='booking-row-status']")?.textContent).toBe("Signed");

    expect(cards[1]!.querySelector("[data-attr='record-row-facts']")!.textContent).toContain("Airbnb");
    expect(cards[1]!.querySelector("[data-attr='booking-row-status']")).toBeNull();

    // A block's source fact says "Block"; it never repeats "Blocked" as a state.
    expect(cards[2]!.querySelector("[data-attr='record-row-facts']")!.textContent).toContain("Block");
    expect(cards[2]!.querySelector("[data-attr='booking-row-status']")).toBeNull();

    // Confirmed is the default and says nothing.
    expect(cards[3]!.querySelector("[data-attr='booking-row-status']")).toBeNull();
    expect(view.container.textContent).not.toContain("Confirmed");
  });
});
