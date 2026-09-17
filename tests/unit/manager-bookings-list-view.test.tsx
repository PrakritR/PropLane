// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ManagerBookingsListView } from "@/components/portal/manager-bookings-list-view";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

vi.mock("next/navigation", () => ({ usePathname: () => "/portal/bookings" }));

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
  it("has no Blocked or View pills; block ⋯ is Edit + Delete", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const view = render(
      <ManagerBookingsListView
        entries={[block, stay]}
        bucket="upcoming"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
        onEditBlock={onEdit}
        onDeleteBlock={onDelete}
      />,
    );

    expect(view.container.textContent).not.toMatch(/\bView\b/);
    expect(view.container.querySelector("[class*='badge']")).toBeNull();
    const blockedPills = [...view.container.querySelectorAll("*")].filter((el) => el.textContent === "Blocked");
    expect(blockedPills).toHaveLength(0);

    const triggers = view.container.querySelectorAll('[data-attr="record-actions-trigger"]');
    expect(triggers.length).toBe(2);
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Sep 20–22 hold" }), { key: "ArrowDown" });
    const menu = document.body.querySelector('[data-attr="record-actions-menu"]')!;
    expect(menu.textContent).toContain("Edit");
    expect(menu.textContent).toContain("Delete");
    expect(menu.textContent).not.toContain("View");
    expect(menu.textContent).not.toContain("Blocked");
  });
});
